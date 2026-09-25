/**
 * Runes-based store shared by every view: cells, traces, health, tables and the SSE connection.
 * Import `home` and read its fields inside components; call `startHome()` once from App.
 */
import { api, openStream, type Cell, type CellChange, type Health, type Tables, type Trace } from './api';
import { setRoomNames } from './format';

export const TRACE_CAP = 300;

interface HomeState {
  cells: Record<string, Cell>;
  traces: Trace[];
  health: Health | null;
  tables: Tables | null;
  /** rooms.tsv as last loaded: id -> lowercase Swedish name. Mirrored into format.roomName(). */
  rooms: Record<string, string>;
  configError: string | null;
  connected: boolean;
  loaded: boolean;
  /** Ticks every second so relative times stay fresh. */
  now: number;
  /** rule id -> epoch ms of the last FIRED seen in this session. */
  ruleFiredAt: Record<string, number>;
  /** Short-lived message shown at the bottom of the page (errors from actions etc). */
  notice: { text: string; error: boolean } | null;
}

export const home: HomeState = $state({
  cells: {},
  traces: [],
  health: null,
  tables: null,
  rooms: {},
  configError: null,
  connected: false,
  loaded: false,
  now: Date.now(),
  ruleFiredAt: {},
  notice: null,
});

export function cellValue(id: string) {
  return home.cells[id]?.value ?? null;
}

function applySnapshot(cells: Cell[], configError: string | null) {
  const next: Record<string, Cell> = {};
  for (const c of cells) next[c.id] = c;
  home.cells = next;
  home.configError = configError;
  home.loaded = true;
}

function applyChanges(changes: CellChange[]) {
  const at = Date.now();
  for (const ch of changes) {
    const cell = home.cells[ch.cell];
    if (cell) {
      cell.value = ch.to;
      cell.changedAt = at;
      cell.seenAt = at;
    }
  }
}

export function pushTrace(t: Trace, front = true) {
  for (const r of t.rules) if (r.fired) home.ruleFiredAt[r.id] = t.at;
  const next = front ? [t, ...home.traces] : [...home.traces, t];
  home.traces = next.length > TRACE_CAP ? next.slice(0, TRACE_CAP) : next;
}

let noticeTimer: ReturnType<typeof setTimeout> | null = null;
export function notify(text: string, error = false) {
  home.notice = { text, error };
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (home.notice = null), error ? 8000 : 3000);
}

export async function sendAction(action: string): Promise<void> {
  try {
    const res = await api.action(action);
    const errors = res.traces.flatMap((t) => t.errors);
    if (!res.ok || errors.length) notify(`${action}: ${errors.join('; ') || 'misslyckades'}`, true);
  } catch (e) {
    notify(`${action}: ${(e as Error).message}`, true);
  }
}

export async function sendEvent(event: string): Promise<void> {
  try {
    const res = await api.event(event);
    const errors = res.traces.flatMap((t) => t.errors);
    if (errors.length) notify(`händelse ${event}: ${errors.join('; ')}`, true);
  } catch (e) {
    notify(`händelse ${event}: ${(e as Error).message}`, true);
  }
}

export async function loadTables(): Promise<void> {
  try {
    const t = await api.tables();
    const rooms = Array.isArray(t.rooms) ? t.rooms : [];
    // Names first, so everything that re-renders on `tables` already sees them.
    setRoomNames(rooms);
    home.rooms = Object.fromEntries(rooms.map((r) => [r.id, r.name]));
    home.tables = { ...t, rooms };
  } catch (e) {
    notify(`tabeller: ${(e as Error).message}`, true);
  }
}

async function loadHealth(): Promise<void> {
  try {
    home.health = await api.health();
    home.configError = home.health.configError;
  } catch {
    /* the connection dot already shows we are offline */
  }
}

async function loadTraces(): Promise<void> {
  try {
    const list = await api.trace();
    home.traces = [];
    home.ruleFiredAt = {};
    for (const t of list) pushTrace(t);
  } catch (e) {
    notify(`spår: ${(e as Error).message}`, true);
  }
}

let started = false;
/** Loads everything once and opens the SSE stream. Returns a stop function. */
export function startHome(): () => void {
  if (started) return () => {};
  started = true;
  void loadHealth();
  void loadTables();
  void loadTraces();
  const tick = setInterval(() => (home.now = Date.now()), 1000);
  const healthPoll = setInterval(loadHealth, 60_000);
  const stop = openStream({
    state: (s) => applySnapshot(s.cells, s.configError),
    changes: applyChanges,
    trace: (t) => pushTrace(t),
    config: (c) => {
      home.configError = c.error;
      void loadTables();
    },
    status: (ok) => {
      const wasDown = !home.connected;
      home.connected = ok;
      if (ok && wasDown && home.loaded) void loadTraces();
    },
  });
  return () => {
    clearInterval(tick);
    clearInterval(healthPoll);
    stop();
    started = false;
  };
}
