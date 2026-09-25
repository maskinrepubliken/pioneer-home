import type { EvalContext } from '../../src/formula/index.js';
import { Duration, formatValue, type Value } from '../../src/formula/index.js';
import { localParts } from '../../src/formula/time.js';
import { formula } from '../../src/formula/index.js';

export const TZ = 'Europe/Stockholm';
/** Wednesday 2026-09-23 08:15:30 CEST */
export const DEFAULT_NOW = Date.UTC(2026, 8, 23, 6, 15, 30);

export interface FakeCtxOptions {
  values?: Record<string, Value>;
  prev?: Record<string, Value>;
  changed?: string[];
  /** Keyed by `ref` (SINCE(ref)) or `ref|<formatValue(value)>` (SINCE(ref, value)). Missing = null. */
  since?: Record<string, Duration | null>;
  now?: number;
  tz?: string;
}

export function fakeCtx(opts: FakeCtxOptions = {}): EvalContext {
  const values = new Map(Object.entries(opts.values ?? {}));
  const prev = new Map(Object.entries(opts.prev ?? {}));
  const changed = new Set(opts.changed ?? []);
  const since = new Map(Object.entries(opts.since ?? {}));
  const now = opts.now ?? DEFAULT_NOW;
  const tz = opts.tz ?? TZ;
  return {
    get: (ref) => values.get(ref) ?? null,
    prev: (ref) => prev.get(ref) ?? null,
    changed: (ref) => changed.has(ref),
    since: (ref, value) => since.get(value === undefined ? ref : `${ref}|${formatValue(value)}`) ?? null,
    now: () => now,
    tz,
    // Fixed offsets from local midnight: sunrise 06:00, sunset 18:00.
    sunrise: (epochMs) => localParts(epochMs, tz).midnightMs + 6 * 3_600_000,
    sunset: (epochMs) => localParts(epochMs, tz).midnightMs + 18 * 3_600_000,
  };
}

/** Parse and evaluate in one go. */
export function ev(source: string, ctx: EvalContext = fakeCtx()): Value {
  return formula.evaluate(formula.parse(source), ctx);
}

/** Deep copy of an AST without spans, for structural comparison. */
export function stripSpans(ast: unknown): unknown {
  return JSON.parse(JSON.stringify(ast, (key, value: unknown) => (key === 'span' ? undefined : value)));
}
