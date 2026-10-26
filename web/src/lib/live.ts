/**
 * Grouping for the Live view: rooms -> appliance columns -> devices and held values.
 * Pure functions, no Svelte. Rooms come from device `.room` and cell `room`; groups from the `group` field
 * (engine default by kind, see format.defaultGroup). Computed cells go to the room's Detaljer; sun and weather (when known) to System; settings and the internal event cell are not shown.
 */
import type { AlertLevel, Cell, CellGroup } from './api';
import { GROUP_ORDER, defaultGroup, roomName, systemName } from './format';

export interface LiveDevice {
  id: string;
  name: string;
  kind: string;
  group: CellGroup;
  /** prop -> cell */
  props: Record<string, Cell>;
  cells: Cell[];
}

export interface LiveColumn {
  group: CellGroup;
  devices: LiveDevice[];
  /** Held values (kind var) in this room and group: shown as controls. */
  vars: Cell[];
}

/** One source of a room reading: the device and its value. */
export interface ReadingSource {
  device: string;
  name: string;
  value: number | boolean;
  /** Unreachable (`.available` FALSE): listed, but left out of the room value. */
  offline: boolean;
  changedAt: number | null;
}

/**
 * A quantity measured in the room, whatever reports it (motion sensor, climate sensor, thermostat ...):
 * numbers are the mean of the reachable sources, occupancy is TRUE when any source sees motion.
 */
export interface RoomReading {
  prop: 'temperature' | 'humidity' | 'illuminance' | 'occupancy' | 'open';
  value: number | boolean | null;
  sources: ReadingSource[];
}

export interface LiveRoom {
  /** Room id, or '' for the house panel (cells without a room). */
  key: string;
  title: string;
  columns: LiveColumn[];
  /** Computed cells (kind derived) of the room, per group, for the Detaljer accordion. */
  computed: { group: CellGroup; cells: Cell[] }[];
  /** Devices with nothing to show or control (e.g. a remote: only battery), listed only under Detaljer. */
  hidden: LiveDevice[];
  /** Everything measured in the room, together at the top of the panel. */
  readings: RoomReading[];
}

export interface SystemBlock {
  id: string;
  name: string;
  cells: Cell[];
  /** Held values in the block (room-less vars): shown as controls. */
  vars?: Cell[];
}

/**
 * Props that make a device worth a row in Live: something to switch or steer. Pure sensors (motion, climate,
 * contact) and remotes get no row: their measurements are in the room's readings, the rest under Detaljer.
 */
const CONTROL_PROPS = new Set(['state', 'brightness', 'level', 'setpoint']);
const SENSOR_KINDS = new Set(['motion', 'climate', 'contact', 'remote']);
export function isDetailsOnly(d: LiveDevice): boolean {
  return SENSOR_KINDS.has(d.kind) || !d.cells.some((c) => CONTROL_PROPS.has(c.prop ?? ''));
}

/** Room readings in display order. */
export const READING_PROPS: RoomReading['prop'][] = ['temperature', 'humidity', 'illuminance', 'occupancy', 'open'];

export function roomReadings(devices: LiveDevice[]): RoomReading[] {
  const out: RoomReading[] = [];
  for (const prop of READING_PROPS) {
    const sources: ReadingSource[] = [];
    for (const d of devices) {
      const c = d.props[prop];
      if (!c || (typeof c.value !== 'number' && typeof c.value !== 'boolean')) continue;
      sources.push({ device: d.id, name: d.name, value: c.value, offline: d.props['available']?.value === false, changedAt: c.changedAt ?? null });
    }
    if (!sources.length) continue;
    const live = sources.filter((s) => !s.offline);
    let value: number | boolean | null = null;
    if (live.length && typeof live[0]!.value === 'boolean') value = live.some((s) => s.value === true);
    else if (live.length) value = live.reduce((n, s) => n + (s.value as number), 0) / live.length;
    sources.sort((a, b) => Number(a.offline) - Number(b.offline) || a.name.localeCompare(b.name, 'sv'));
    out.push({ prop, value, sources });
  }
  return out;
}

/** An alerts.tsv banner whose condition is TRUE right now. */
export interface LiveAlert {
  id: string;
  level: AlertLevel;
  text: string;
  room: string | null;
}

export interface LiveLayout {
  rooms: LiveRoom[];
  system: SystemBlock[];
  /** Active banners, most severe first. */
  alerts: LiveAlert[];
}

const ALERT_RANK: Record<AlertLevel, number> = { danger: 0, warning: 1, info: 2 };

/** Active banners from the alert cells: condition TRUE; the text comes from its `_text` cell. */
export function activeAlerts(cells: Cell[]): LiveAlert[] {
  const texts = new Map<string, string>();
  for (const c of cells) if (c.alert?.role === 'text' && typeof c.value === 'string') texts.set(c.alert.id, c.value);
  return cells
    .filter((c) => c.alert?.role === 'if' && c.value === true)
    .map((c) => ({ id: c.alert!.id, level: c.alert!.level, text: texts.get(c.alert!.id) || c.alert!.id, room: c.room }))
    .sort((a, b) => ALERT_RANK[a.level] - ALERT_RANK[b.level] || a.id.localeCompare(b.id));
}

const PROP_ORDER = ['state', 'brightness', 'color_temp', 'color', 'level', 'occupancy', 'open', 'temperature', 'humidity', 'setpoint', 'demand', 'mode', 'running', 'illuminance', 'action', 'power', 'energy', 'pressure', 'battery', 'linkquality', 'room', 'room_name', 'available', 'last_seen'];
export function propOrder(a: Cell, b: Cell): number {
  const ia = PROP_ORDER.indexOf(a.prop ?? '');
  const ib = PROP_ORDER.indexOf(b.prop ?? '');
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.id.localeCompare(b.id);
}
const byId = (a: Cell, b: Cell) => a.id.localeCompare(b.id);

/** Fallback when /api/tables has not arrived: infer the kind from the props present. */
export function guessKind(props: Set<string | null>): string {
  if (props.has('brightness')) return 'light';
  if (props.has('setpoint')) return 'thermostat';
  if (props.has('occupancy')) return 'motion';
  if (props.has('level')) return 'pwm';
  if (props.has('action')) return 'remote';
  if (props.has('open')) return 'contact';
  if (props.has('humidity')) return 'climate';
  if (props.has('state')) return 'plug';
  return 'device';
}

interface RoomAcc {
  devices: Map<string, Cell[]>;
  vars: Cell[];
  derived: Cell[];
}

export function buildLive(cells: Cell[], kinds: Record<string, string>, names: Record<string, string>): LiveLayout {
  const rooms = new Map<string, RoomAcc>();
  const acc = (room: string): RoomAcc => {
    let r = rooms.get(room);
    if (!r) rooms.set(room, (r = { devices: new Map(), vars: [], derived: [] }));
    return r;
  };
  const system = new Map<string, SystemBlock>();

  for (const c of cells) {
    if (c.alert) continue; // alerts.tsv cells: shown as banners, not as computed cells
    if (c.device) {
      const devs = acc(c.room ?? '').devices;
      let list = devs.get(c.device);
      if (!list) devs.set(c.device, (list = []));
      list.push(c);
    } else if (c.kind === 'var') acc(c.room ?? '').vars.push(c);
    else if (c.kind === 'derived') acc(c.room ?? '').derived.push(c);
    else if (c.kind === 'setting') continue; // engine configuration: Tabeller → Inställningar, never Live
    else if (c.id === 'event') continue; // internal: the event being handled, NULL between passes
    else {
      // system inputs: sun.elevation, weather.temperature ...
      const prefix = c.id.includes('.') ? c.id.slice(0, c.id.indexOf('.')) : 'system';
      let b = system.get(prefix);
      if (!b) system.set(prefix, (b = { id: prefix, name: systemName(prefix), cells: [] }));
      b.cells.push(c);
    }
  }

  const out: LiveRoom[] = [];
  let house: RoomAcc | undefined;
  for (const [key, r] of rooms) {
    // Cells without a room are not a room: they go to the System section below.
    if (!key && !r.devices.size) {
      house = r;
      continue;
    }
    const columns = new Map<CellGroup, LiveColumn>();
    const col = (g: CellGroup): LiveColumn => {
      let x = columns.get(g);
      if (!x) columns.set(g, (x = { group: g, devices: [], vars: [] }));
      return x;
    };
    const hidden: LiveDevice[] = [];
    const all: LiveDevice[] = [];
    for (const [id, list] of r.devices) {
      list.sort(propOrder);
      const kind = kinds[id] ?? guessKind(new Set(list.map((c) => c.prop)));
      const group = list.find((c) => c.group)?.group ?? defaultGroup(kind);
      const dev: LiveDevice = { id, name: list.find((c) => c.name)?.name ?? id, kind, group, props: Object.fromEntries(list.map((c) => [c.prop ?? c.id, c])), cells: list };
      all.push(dev);
      if (isDetailsOnly(dev)) hidden.push(dev);
      else col(group).devices.push(dev);
    }
    hidden.sort((a, b) => a.name.localeCompare(b.name, 'sv'));
    for (const v of r.vars.sort(byId)) col(v.group ?? 'other').vars.push(v);
    for (const x of columns.values()) x.devices.sort((a, b) => a.name.localeCompare(b.name, 'sv'));

    const computed = new Map<CellGroup, Cell[]>();
    for (const d of r.derived.sort(byId)) {
      const g = d.group ?? 'other';
      let list = computed.get(g);
      if (!list) computed.set(g, (list = []));
      list.push(d);
    }
    out.push({
      key,
      title: key ? roomName(key, names) : 'Huset',
      columns: GROUP_ORDER.filter((g) => columns.has(g)).map((g) => columns.get(g)!),
      computed: GROUP_ORDER.filter((g) => computed.has(g)).map((g) => ({ group: g, cells: computed.get(g)! })),
      hidden,
      readings: roomReadings(all),
    });
  }
  // Rooms in rooms.tsv order (unknown rooms after, by name); the house panel (no room) last.
  const order = Object.keys(names);
  const rank = (k: string) => (k ? (order.indexOf(k) < 0 ? order.length : order.indexOf(k)) : order.length + 1);
  out.sort((a, b) => rank(a.key) - rank(b.key) || a.title.localeCompare(b.title, 'sv'));

  // Blocks with nothing known yet (e.g. weather without an API key) are left out rather than a list of NULL.
  const sys = [...system.values()].filter((b) => b.cells.some((c) => c.value !== null)).sort((a, b) => a.id.localeCompare(b.id));
  for (const b of sys) b.cells.sort(byId);
  if (house && (house.vars.length || house.derived.length)) {
    sys.unshift({ id: 'house', name: 'Hela huset', cells: house.derived.sort(byId), vars: house.vars.sort(byId) });
  }
  return { rooms: out, system: sys, alerts: activeAlerts(cells) };
}
