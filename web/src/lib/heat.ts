/**
 * The Värme page's model, read from cell naming conventions (see CLAUDE.md, "Heating modes"). Pure functions, no Svelte.
 *
 *   heat_mode            held string: "auto" (follow the schedule), a mode id chosen by hand, or "manual" (a target
 *                        changed in the UI: the targets are left alone until a mode or auto is chosen)
 *   heat_active          the mode in force now (the chosen one, or the schedule's)
 *   heat_sched_now       the schedule's mode now; its `note` describes the schedule
 *   heat_use_<mode>      TRUE while <mode> counts in the rooms' plans (the schedule's overlap makes two count at once);
 *                        the cell's `name` is the mode's Swedish label, its row order the order of the buttons
 *   <room>_plan          the room's planned temperature; <room>_target the room's target (a rule copies the plan into it)
 *
 * Every room is on the page; the heated ones (a `_plan` or a `_target` cell) first.
 */
import type { Cell } from './api';
import type { LiveLayout } from './live';
import { parseTsv } from './tsv';

export const AUTO = 'auto';
export const MANUAL = 'manual';
export const MANUAL_NAME = 'Manuellt';

export interface HeatMode {
  id: string;
  name: string;
  /** counts in the plan right now */
  inUse: boolean;
}

export interface Heater {
  id: string;
  name: string;
  /** TRUE heating, FALSE resting, null unknown or unreachable */
  heating: boolean | null;
  /** 0-100 % heating demand, when the device reports one */
  demand: number | null;
  setpoint: number | null;
  offline: boolean;
}

export interface HeatRoom {
  id: string;
  title: string;
  /** has a plan or a target: part of the heating modes */
  heated: boolean;
  temperature: number | null;
  humidity: number | null;
  /** names of the temperature sources, reachable ones first */
  sources: string[];
  target: Cell | null;
  plan: number | null;
  heaters: Heater[];
}

const num = (c: Cell | undefined): number | null => (typeof c?.value === 'number' ? c.value : null);
const str = (c: Cell | undefined): string | null => (typeof c?.value === 'string' ? c.value : null);

/** Modes in cells.tsv order (the order the engine lists the cells in). */
export function heatModes(cells: Cell[]): HeatMode[] {
  const out: HeatMode[] = [];
  for (const c of cells) {
    const m = /^heat_use_([a-z0-9_]+)$/.exec(c.id);
    if (m) out.push({ id: m[1]!, name: c.name ?? m[1]!, inUse: c.value === true });
  }
  return out;
}

export function heatState(byId: Record<string, Cell | undefined>): { mode: string | null; active: string | null; scheduled: string | null } {
  return { mode: str(byId['heat_mode']), active: str(byId['heat_active']), scheduled: str(byId['heat_sched_now']) };
}

/** Every room in the Live order, the heated ones first, with its readings and heat sources (thermostats). */
export function heatRooms(layout: LiveLayout, byId: Record<string, Cell | undefined>, roomNames: Record<string, string>): HeatRoom[] {
  const ids = [...new Set([...Object.keys(roomNames), ...layout.rooms.map((r) => r.key).filter(Boolean)])];
  const heated = (r: string) => Boolean(byId[`${r}_plan`] || byId[`${r}_target`]);
  const ordered = [...ids.filter(heated), ...ids.filter((r) => !heated(r))];
  return ordered.map((id): HeatRoom => {
    const live = layout.rooms.find((r) => r.key === id);
    const reading = (prop: string) => live?.readings.find((x) => x.prop === prop);
    const t = reading('temperature');
    const h = reading('humidity');
    const devices = (live?.columns ?? []).flatMap((c) => c.devices).concat(live?.hidden ?? []);
    const heaters = devices
      .filter((d) => d.kind === 'thermostat')
      .map((d): Heater => {
        const offline = d.props['available']?.value === false;
        const running = d.props['running']?.value;
        const demand = num(d.props['demand']);
        const heating = offline ? null : typeof running === 'string' ? running.toLowerCase() === 'heat' : demand === null ? null : demand > 0;
        return { id: d.id, name: d.name, heating, demand, setpoint: num(d.props['setpoint']), offline };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'sv'));
    return {
      id,
      title: live?.title ?? roomNames[id] ?? id,
      heated: heated(id),
      temperature: typeof t?.value === 'number' ? t.value : null,
      humidity: typeof h?.value === 'number' ? h.value : null,
      sources: (t?.sources ?? []).map((s) => s.name),
      target: byId[`${id}_target`] ?? null,
      plan: num(byId[`${id}_plan`]),
      heaters,
    };
  });
}

/**
 * The actions for a room target changed in the UI: with heating modes in the tables, the mode first becomes
 * manual, so the schedule leaves the new target alone.
 */
export function targetActions(cellId: string, value: number, byId: Record<string, Cell | undefined>): string[] {
  const mode = str(byId['heat_mode']);
  const isRoomTarget = /_target$/.test(cellId) && byId[`${cellId.slice(0, -'_target'.length)}_plan`] !== undefined;
  const out = isRoomTarget && mode !== null && mode !== MANUAL ? [`set heat_mode ${MANUAL}`] : [];
  return [...out, `set ${cellId} ${value}`];
}

/** `note` column of cells.tsv by id (the engine's cell list carries no notes). */
export function cellNotes(files: Record<string, string>): Record<string, string> {
  const t = parseTsv(files['cells.tsv'] ?? '');
  const id = t.header.indexOf('id');
  const note = t.header.indexOf('note');
  const out: Record<string, string> = {};
  if (id < 0 || note < 0) return out;
  for (const r of t.rows) if (r[id] && r[note]) out[r[id]!] = r[note]!;
  return out;
}
