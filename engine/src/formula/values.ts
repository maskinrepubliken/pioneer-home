/**
 * Value model shared by the formula language, the cell store and the tables.
 *
 * Plain JS primitives cover number / boolean / string / null. Three small classes
 * cover the time types so they can never be confused with plain numbers:
 *  - Duration   a length of time in milliseconds          e.g. 10m, 1h30m
 *  - TimeOfDay  milliseconds since local midnight          e.g. 07:30
 *  - Timestamp  an absolute instant (epoch milliseconds)   e.g. NOW(), SUNSET()
 */

export class Duration {
  constructor(readonly ms: number) {}
  toString(): string {
    return formatDuration(this.ms);
  }
}

export class TimeOfDay {
  /** ms since local midnight, 0 <= ms < 86_400_000 */
  constructor(readonly ms: number) {}
  toString(): string {
    const total = Math.round(this.ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const hh = String(h).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    return s ? `${hh}:${mm}:${String(s).padStart(2, '0')}` : `${hh}:${mm}`;
  }
}

export class Timestamp {
  constructor(readonly ms: number) {}
  toString(): string {
    return new Date(this.ms).toISOString();
  }
}

export type Value = number | boolean | string | null | Duration | TimeOfDay | Timestamp;

export type ValueType = 'number' | 'boolean' | 'string' | 'duration' | 'timeofday' | 'timestamp' | 'null' | 'any';

export function typeOf(v: Value): ValueType {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') return 'string';
  if (v instanceof Duration) return 'duration';
  if (v instanceof TimeOfDay) return 'timeofday';
  if (v instanceof Timestamp) return 'timestamp';
  return 'any';
}

/** Structural equality used by the store (change detection) and by `=` in formulas. */
export function valuesEqual(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (a instanceof Duration && b instanceof Duration) return a.ms === b.ms;
  if (a instanceof TimeOfDay && b instanceof TimeOfDay) return a.ms === b.ms;
  if (a instanceof Timestamp && b instanceof Timestamp) return a.ms === b.ms;
  return false;
}

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;
const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parses `10m`, `1h30m`, `500ms`, `1.5h`. Returns null when the text is not a duration. */
export function parseDuration(text: string): Duration | null {
  const parts = text.match(/\d+(?:\.\d+)?(?:ms|s|m|h|d)/g);
  if (!parts || parts.join('') !== text) return null;
  let ms = 0;
  for (const p of parts) {
    const m = p.match(DURATION_RE);
    if (!m) return null;
    ms += Number(m[1]) * (DURATION_UNITS[m[2]!] ?? 0);
  }
  return new Duration(ms);
}

export function formatDuration(ms: number): string {
  if (ms === 0) return '0s';
  const neg = ms < 0;
  let rest = Math.abs(ms);
  const out: string[] = [];
  for (const [unit, size] of [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]] as const) {
    if (rest >= size) {
      const n = Math.floor(rest / size);
      out.push(`${n}${unit}`);
      rest -= n * size;
    }
  }
  if (rest > 0) out.push(`${Math.round(rest)}ms`);
  return (neg ? '-' : '') + out.join('');
}

/** Parses `07:30` or `07:30:15`. Returns null when the text is not a time of day. */
export function parseTimeOfDay(text: string): TimeOfDay | null {
  const m = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = Number(m[3] ?? 0);
  if (h > 23 || mi > 59 || s > 59) return null;
  return new TimeOfDay(((h * 60 + mi) * 60 + s) * 1000);
}

/**
 * Parses a literal as written in a table cell (vars.tsv initial values, scenario `set` commands,
 * setting values). Strings may be quoted; unquoted text that is not a number, boolean, duration
 * or time of day is returned as a string.
 */
export function parseLiteral(text: string, hint?: ValueType): Value {
  const t = text.trim();
  if (t === '' || /^null$/i.test(t)) return null;
  if (hint === 'string') return unquote(t);
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  const d = parseDuration(t);
  if (d) return d;
  const tod = parseTimeOfDay(t);
  if (tod) return tod;
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) {
    const ms = Date.parse(t);
    if (!Number.isNaN(ms)) return new Timestamp(ms);
  }
  return unquote(t);
}

function unquote(t: string): string {
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Human-readable rendering used by traces, the CLI and the UI. */
export function formatValue(v: Value): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  if (typeof v === 'string') return JSON.stringify(v);
  return v.toString();
}

/** JSON-safe encoding for snapshots, SSE and the HTTP API. */
export function encodeValue(v: Value): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Duration) return { $duration: v.ms };
  if (v instanceof TimeOfDay) return { $timeofday: v.ms };
  if (v instanceof Timestamp) return { $timestamp: v.ms };
  return v;
}

export function decodeValue(raw: unknown): Value {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (typeof o['$duration'] === 'number') return new Duration(o['$duration']);
    if (typeof o['$timeofday'] === 'number') return new TimeOfDay(o['$timeofday']);
    if (typeof o['$timestamp'] === 'number') return new Timestamp(o['$timestamp']);
  }
  return null;
}
