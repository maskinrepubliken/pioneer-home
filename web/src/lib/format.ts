/** Value formatting, relative time and Swedish UI labels. Pure functions, no Svelte. */
import type { Cell, EncodedValue } from './api';

export const LOCALE = 'sv-SE';

export function isDuration(v: EncodedValue): v is { $duration: number } {
  return typeof v === 'object' && v !== null && '$duration' in v;
}
export function isTimeOfDay(v: EncodedValue): v is { $timeofday: number } {
  return typeof v === 'object' && v !== null && '$timeofday' in v;
}
export function isTimestamp(v: EncodedValue): v is { $timestamp: number } {
  return typeof v === 'object' && v !== null && '$timestamp' in v;
}

/** `1 h 20 min`, `45 s`, `0 s`. Mirrors engine formatDuration but with Swedish units and no ms tail. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '?';
  if (Math.abs(ms) < 1000) return ms === 0 ? '0 s' : `${Math.round(ms)} ms`;
  const neg = ms < 0;
  let rest = Math.abs(ms);
  const out: string[] = [];
  for (const [unit, size] of [['d', 86_400_000], ['h', 3_600_000], ['min', 60_000], ['s', 1000]] as const) {
    if (rest >= size) {
      const n = Math.floor(rest / size);
      out.push(`${n} ${unit}`);
      rest -= n * size;
    }
    if (out.length === 2) break;
  }
  return (neg ? '-' : '') + out.join(' ');
}

export function formatTimeOfDay(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return s ? `${hh}:${mm}:${String(s).padStart(2, '0')}` : `${hh}:${mm}`;
}

/** "just nu", "för 3 min sedan", "för 2 h sedan", "för 5 d sedan". `now` is injected so the UI can tick. */
export function relativeTime(at: number | null | undefined, now: number = Date.now()): string {
  if (at === null || at === undefined) return 'aldrig';
  const diff = now - at;
  if (diff < 0) return 'om ' + formatDuration(-diff);
  if (diff < 10_000) return 'just nu';
  if (diff < 60_000) return `för ${Math.floor(diff / 1000)} s sedan`;
  if (diff < 3_600_000) return `för ${Math.floor(diff / 60_000)} min sedan`;
  if (diff < 86_400_000) return `för ${Math.floor(diff / 3_600_000)} h sedan`;
  return `för ${Math.floor(diff / 86_400_000)} d sedan`;
}

export function clock(at: number, withSeconds = true): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return withSeconds ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
}

/** Full date and time in Swedish, e.g. `2026-09-23 14:05:09`. */
export function dateTime(at: number): string {
  return new Date(at).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'medium' });
}

/** Time of day in Swedish, e.g. `14:05:09`. */
export function timeOnly(at: number, withSeconds = true): string {
  return new Date(at).toLocaleTimeString(LOCALE, { timeStyle: withSeconds ? 'medium' : 'short' });
}

/** Unit guessed from the last part of a cell id (`lamp1.brightness` -> `%`). */
export function unitFor(id: string, prop?: string | null): string {
  const p = (prop ?? id.split('.').pop() ?? '').toLowerCase();
  switch (p) {
    case 'temperature':
    case 'setpoint':
    case 'current':
    case 'target':
      return '°C';
    case 'humidity':
    case 'brightness':
    case 'level':
    case 'battery':
    case 'demand':
    case 'pi':
      return '%';
    case 'color_temp':
      return 'K';
    case 'illuminance':
      return 'lx';
    case 'power':
      return 'W';
    case 'energy':
      return 'kWh';
    case 'pressure':
      return 'hPa';
    case 'elevation':
    case 'azimuth':
      return '°';
    case 'windspeed':
      return 'm/s';
    default:
      return '';
  }
}

export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

/** Boolean shown as a pill: PÅ / AV. */
export function onOff(v: boolean): string {
  return v ? 'PÅ' : 'AV';
}

/** Compact display of any encoded value. Strings are shown bare (not quoted). */
export function formatValue(v: EncodedValue, id = '', prop?: string | null, now: number = Date.now()): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return onOff(v);
  if (typeof v === 'number') {
    const unit = unitFor(id, prop);
    return unit ? `${formatNumber(v)}${unit === '°C' || unit === 'K' || unit === 'lx' || unit === 'W' || unit === 'm/s' ? ' ' : ''}${unit}` : formatNumber(v);
  }
  if (typeof v === 'string') return v === '' ? '""' : v;
  if (isDuration(v)) return formatDuration(v.$duration);
  if (isTimeOfDay(v)) return formatTimeOfDay(v.$timeofday);
  if (isTimestamp(v)) return relativeTime(v.$timestamp, now);
  return String(v);
}

/** Formatting for `from -> to` lines in traces: TRUE/FALSE like the engine, quoted strings. */
export function formatTraceValue(v: EncodedValue): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (isDuration(v)) return formatDuration(v.$duration);
  if (isTimeOfDay(v)) return formatTimeOfDay(v.$timeofday);
  if (isTimestamp(v)) return clock(v.$timestamp);
  return String(v);
}

/** Swedish labels for device properties (the last part of a cell id). */
export const PROP_LABEL: Record<string, string> = {
  temperature: 'Temperatur',
  humidity: 'Luftfuktighet',
  illuminance: 'Ljus',
  brightness: 'Ljusstyrka',
  color_temp: 'Färgtemperatur',
  color: 'Färg',
  state: 'Läge',
  occupancy: 'Rörelse',
  level: 'Nivå',
  setpoint: 'Måltemperatur',
  demand: 'Effektbehov',
  mode: 'Driftläge',
  running: 'Status',
  battery: 'Batteri',
  linkquality: 'Signal',
  room: 'Rum',
  room_name: 'Rumsnamn',
  available: 'Tillgänglig',
  last_seen: 'Senast sedd',
  power: 'Effekt',
  energy: 'Energi',
  pressure: 'Tryck',
  action: 'Knapp',
  open: 'Öppen',
  contact: 'Kontakt',
  elevation: 'Höjd',
  azimuth: 'Azimut',
  up: 'Uppe',
  windspeed: 'Vindhastighet',
};

export function propLabel(prop: string): string {
  return PROP_LABEL[prop] ?? prop.replace(/_/g, ' ');
}

export function cellLabel(c: Cell): string {
  if (c.prop) return propLabel(c.prop);
  return c.id;
}

/** Swedish names for device kinds. */
export const KIND_NAME: Record<string, string> = {
  light: 'Lampa',
  plug: 'Uttag',
  motion: 'Rörelsesensor',
  thermostat: 'Termostat',
  remote: 'Fjärrkontroll',
  climate: 'Klimat',
  pwm: 'Fläkt/PWM',
  contact: 'Dörr/fönster',
  system: 'System',
  computed: 'Beräknat',
  device: 'Enhet',
};

export function kindName(kind: string): string {
  return KIND_NAME[kind] ?? kind;
}

const KIND_ICON: Record<string, string> = {
  light: '💡',
  plug: '🔌',
  motion: '🚶',
  contact: '🚪',
  thermostat: '🌡️',
  remote: '🎛️',
  climate: '🌦️',
  pwm: '🌀',
  system: '⚙️',
  computed: '🧮',
};

export function kindIcon(kind: string): string {
  return KIND_ICON[kind] ?? '▫️';
}

/**
 * Room names come from rooms.tsv (`name`, stored lowercase as in the old history data) via GET /api/tables.
 * The store calls setRoomNames() when tables load; until then, and for unknown ids, the id is capitalised.
 */
let ROOM_NAMES: Record<string, string> = {};

export function setRoomNames(rooms: { id: string; name: string }[]): void {
  const next: Record<string, string> = {};
  for (const r of rooms) if (r.id) next[r.id] = r.name || r.id;
  ROOM_NAMES = next;
}

/** "living room" -> "Living room". Only the first letter changes; åäö are kept. */
export function capitalise(s: string): string {
  return s ? s.charAt(0).toLocaleUpperCase(LOCALE) + s.slice(1) : s;
}

/**
 * Display name of a room id: the name from rooms.tsv with an initial capital ("Living room"), or the capitalised id.
 * Cells without a room belong to "System". Components pass `home.rooms` as `names` so they re-render when rooms.tsv changes.
 */
export function roomName(room: string | null | undefined, names: Record<string, string> = ROOM_NAMES): string {
  if (!room) return 'System';
  return capitalise(names[room] ?? ROOM_NAMES[room] ?? room);
}

/** Display names for system pseudo-devices (cell id prefixes without a device). */
const SYSTEM_NAME: Record<string, string> = {
  sun: 'Solen',
  weather: 'Vädret',
  system: 'System',
};

export function systemName(prefix: string): string {
  return SYSTEM_NAME[prefix] ?? prefix;
}

/** Sequence trace events as shown in the trace view. */
const SEQUENCE_EVENT: Record<string, string> = {
  started: 'startad',
  step: 'steg',
  waiting: 'väntar',
  cancelled: 'avbruten',
  finished: 'klar',
};

export function sequenceEvent(event: string): string {
  return SEQUENCE_EVENT[event] ?? event;
}
