/**
 * The heating modes' model, read from cell naming conventions (see CLAUDE.md, "Heating modes"). Pure functions, no
 * Svelte. Used by the start page, Värme and Program.
 *
 *   heat_mode            held string: "program" (the week schedule, week.tsv, with the program's planning), a mode id
 *                        chosen to hold all the time, or "manual" (a target changed by hand, in the UI or on a
 *                        thermostat: the targets are left alone until program or a mode is chosen)
 *   heat_use_<mode>      TRUE while <mode> is in force; the cell's `name` is the mode's Swedish label, its row order the
 *                        order of the buttons
 *   heat_transition      TRUE when two modes are in force at once (a transition hour in the schedule)
 *   <room>_comfort       the modes' temperature for the room now; <room>_plan what its target follows (the program's
 *                        setpoint when it has one); <room>_target the room's target
 *
 * Every room is on the page; the heated ones (a `_plan` or a `_target` cell) first.
 */
import type { Cell } from './api';
import type { LiveLayout } from './live';
import { parseTsv } from './tsv';

/** The program: the week schedule, heated by price and weather. */
export const PROGRAM = 'program';
export const PROGRAM_NAME = 'Program';
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
  /** a heater with its own clock: heating and demand are the engine's estimate */
  estimated: boolean;
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
  /** what a heater the engine cannot steer holds now by its own clock (`<room>_local_setpoint`), its label */
  local: { value: number; name: string } | null;
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

export function heatState(byId: Record<string, Cell | undefined>): { mode: string | null; transition: boolean } {
  return { mode: str(byId['heat_mode']), transition: byId['heat_transition']?.value === true };
}

/** The Swedish name of a heat_mode value. */
export function modeName(mode: string | null, modes: HeatMode[]): string {
  if (mode === null) return '—';
  if (mode === PROGRAM) return PROGRAM_NAME;
  if (mode === MANUAL) return MANUAL_NAME;
  return modes.find((m) => m.id === mode)?.name ?? mode;
}

/** Every room in the Live order, the heated ones first, with its readings and heat sources (thermostats). */
export function heatRooms(layout: LiveLayout, byId: Record<string, Cell | undefined>, roomNames: Record<string, string>): HeatRoom[] {
  const ids = [...new Set([...Object.keys(roomNames), ...layout.rooms.map((r) => r.key).filter(Boolean)])];
  const heated = (r: string) => Boolean(byId[`${r}_plan`] || byId[`${r}_target`] || byId[`${r}_local_setpoint`]);
  const ordered = [...ids.filter(heated), ...ids.filter((r) => !heated(r))];
  return ordered.map((id): HeatRoom => {
    const live = layout.rooms.find((r) => r.key === id);
    const reading = (prop: string) => live?.readings.find((x) => x.prop === prop);
    const t = reading('temperature');
    const h = reading('humidity');
    const devices = (live?.columns ?? []).flatMap((c) => c.devices).concat(live?.hidden ?? []);
    const heaters = devices
      .filter((d) => d.kind === 'thermostat' || d.kind === 'heater')
      .map((d): Heater => {
        const offline = d.props['available']?.value === false;
        const running = d.props['running']?.value;
        const demand = num(d.props['demand']);
        const heating = offline ? null : typeof running === 'string' ? running.toLowerCase() === 'heat' : demand === null ? null : demand > 0;
        return { id: d.id, name: d.name, heating, demand, setpoint: num(d.props['setpoint']), offline, estimated: d.kind === 'heater' };
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
      local: num(byId[`${id}_local_setpoint`]) === null ? null : { value: num(byId[`${id}_local_setpoint`])!, name: byId[`${id}_local_setpoint`]?.name ?? 'eget element' },
      heaters,
    };
  });
}

/**
 * The actions for a room target changed in the UI: with heating modes in the tables, the mode first becomes
 * manual, so neither the program nor a mode overwrites the new target.
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
