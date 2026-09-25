/**
 * Typed access to the engine's HTTP API and its SSE stream.
 * All paths are same-origin relative (`/api/...`): in dev, Vite proxies them to the engine.
 */

/** JSON encoding of a cell value as produced by engine/src/formula/values.ts encodeValue(). */
export type EncodedValue =
  | number
  | boolean
  | string
  | null
  | { $duration: number }
  | { $timeofday: number }
  | { $timestamp: number };

export type CellType = 'number' | 'boolean' | 'string' | 'duration' | 'timeofday' | 'timestamp' | 'null' | 'any';
export type CellKind = 'input' | 'var' | 'derived' | 'setting';

export interface Cell {
  id: string;
  value: EncodedValue;
  type: CellType;
  kind: CellKind;
  settable: boolean;
  device: string | null;
  prop: string | null;
  room: string | null;
  name: string | null;
  changedAt: number | null;
  seenAt: number | null;
}

export interface StateSnapshot {
  at: number;
  configError: string | null;
  cells: Cell[];
}

export interface CellChange {
  cell: string;
  from: EncodedValue;
  to: EncodedValue;
}

export interface Health {
  ok: boolean;
  dryRun: boolean;
  configError: string | null;
  uptimeSeconds: number;
  now: number;
  timezone: string;
  sequences: unknown[];
}

export interface RuleTrace {
  id: string;
  fired: boolean;
  cond: EncodedValue;
  reason: string;
}

export interface ActionTrace {
  source: string;
  detail: string;
  topic?: string;
  payload?: string;
  dryRun: boolean;
  error?: string;
}

export interface SequenceTrace {
  id: string;
  event: 'started' | 'step' | 'waiting' | 'cancelled' | 'finished';
  step?: number;
  reason?: string;
}

export interface Trace {
  cause: string;
  at: number;
  changed: CellChange[];
  derived: CellChange[];
  rules: RuleTrace[];
  actions: ActionTrace[];
  sequences: SequenceTrace[];
  errors: string[];
}

export interface Tables {
  files: Record<string, string>;
  /** rooms.tsv: id and Swedish display name (lowercase as stored). */
  rooms: { id: string; name: string }[];
  rules: { id: string; enabled: boolean; condition: string; file: string; line: number }[];
  devices: { id: string; room: string; kind: string; name: string }[];
  scenes: string[];
  sequences: string[];
}

/** One validation error from the config loader. `line` is 1-based in the TSV text (comments and blank lines count). */
export interface TableError {
  file: string;
  line: number;
  /** Header name of the offending column, when known. */
  column?: string;
  message: string;
}

/** Body of PUT /api/tables/:file with validateOnly: true (200), and of a rejected save (422). */
export interface TableValidation {
  ok: boolean;
  errors: TableError[];
  messages: string[];
}

export type TableSaveResult =
  /** 200: written. `text` is the normalised TSV as saved; `ok` is false when the engine could not reload it. */
  | { status: 200; ok: boolean; text: string; reloadError: string | null }
  /** 422: nothing written, the edit would break the configuration. */
  | ({ status: 422; ok: false } & TableValidation);

export interface ConfigEvent {
  error: string | null;
  at: number;
}

export interface HistoryResponse {
  items: Record<string, unknown>[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => request<Health>('/api/health'),
  state: () => request<StateSnapshot>('/api/state'),
  tables: () => request<Tables>('/api/tables'),
  trace: () => request<Trace[]>('/api/trace'),
  action: (action: string) => request<{ ok: boolean; traces: Trace[] }>('/api/action', { method: 'POST', body: JSON.stringify({ action }) }),
  event: (event: string) => request<{ ok: boolean; traces: Trace[] }>('/api/event', { method: 'POST', body: JSON.stringify({ event }) }),
  history: (collection: string, since: Date, until: Date) =>
    request<HistoryResponse>(`/api/history/${encodeURIComponent(collection)}?since=${encodeURIComponent(since.toISOString())}&until=${encodeURIComponent(until.toISOString())}`),
};

async function putTable(file: string, body: Record<string, unknown>): Promise<Response> {
  const res = await fetch(`/api/tables/${encodeURIComponent(file)}`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 200 || res.status === 422) return res;
  let msg = `${res.status} ${res.statusText}`;
  try {
    const err = (await res.json()) as { error?: string };
    if (err?.error) msg = err.error;
  } catch {
    /* not json */
  }
  throw new ApiError(res.status, msg);
}

/**
 * PUT /api/tables/:file. With `validateOnly` nothing is written and the validation result comes back (200).
 * Otherwise the table is saved (200) or rejected (422) when it would break the configuration.
 * Throws ApiError on 404 (unknown table), 400 and 5xx.
 */
export async function saveTable(file: string, text: string, opts: { validateOnly: true; message?: string }): Promise<TableValidation>;
export async function saveTable(file: string, text: string, opts?: { validateOnly?: false; message?: string }): Promise<TableSaveResult>;
export async function saveTable(file: string, text: string, opts: { validateOnly?: boolean; message?: string } = {}): Promise<TableValidation | TableSaveResult> {
  const body: Record<string, unknown> = { text };
  if (opts.validateOnly) body['validateOnly'] = true;
  if (opts.message) body['message'] = opts.message;
  const res = await putTable(file, body);
  if (opts.validateOnly) {
    const v = (await res.json()) as Partial<TableValidation>;
    return { ok: v.ok === true, errors: v.errors ?? [], messages: v.messages ?? [] };
  }
  if (res.status === 422) {
    const v = (await res.json()) as Partial<TableValidation>;
    return { status: 422, ok: false, errors: v.errors ?? [], messages: v.messages ?? [] };
  }
  const saved = (await res.json()) as { ok?: boolean; text?: string; reloadError?: string | null };
  return { status: 200, ok: saved.ok !== false, text: saved.text ?? text, reloadError: saved.reloadError ?? null };
}

export interface StreamHandlers {
  state: (s: StateSnapshot) => void;
  changes: (c: CellChange[]) => void;
  trace: (t: Trace) => void;
  config: (c: ConfigEvent) => void;
  status: (connected: boolean) => void;
}

/**
 * Opens `/api/events` and keeps it open: EventSource reconnects by itself on transient errors,
 * but if the browser gives up (readyState CLOSED) we recreate it with a small backoff.
 */
export function openStream(handlers: StreamHandlers): () => void {
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  let stopped = false;

  const parse = <T>(ev: MessageEvent, fn: (v: T) => void) => {
    try {
      fn(JSON.parse(ev.data as string) as T);
    } catch (e) {
      console.warn('bad SSE frame', e);
    }
  };

  const connect = () => {
    if (stopped) return;
    source = new EventSource('/api/events');
    source.addEventListener('open', () => {
      attempts = 0;
      handlers.status(true);
    });
    source.addEventListener('state', (ev) => parse<StateSnapshot>(ev, handlers.state));
    source.addEventListener('changes', (ev) => parse<CellChange[]>(ev, handlers.changes));
    source.addEventListener('trace', (ev) => parse<Trace>(ev, handlers.trace));
    source.addEventListener('config', (ev) => parse<ConfigEvent>(ev, handlers.config));
    source.addEventListener('error', () => {
      handlers.status(false);
      if (source?.readyState === EventSource.CLOSED) {
        source.close();
        source = null;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5));
        retry = setTimeout(connect, delay);
      }
    });
  };

  connect();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    source?.close();
  };
}
