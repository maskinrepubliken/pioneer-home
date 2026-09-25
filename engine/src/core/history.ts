/**
 * Turns cell changes into history records according to history.tsv.
 *
 * A record (rows sharing the same `record` id) is written when any of its formulas changes value,
 * at most once per `min_interval`, and only if at least one numeric field moved by `min_delta`
 * (fields without min_delta count as changed whenever their value changes). All fields of the
 * record are evaluated and written together, so a PocketBase row always has sensor, location,
 * temperature and humidity even when only the temperature moved.
 */
import type { HistoryRecordDef } from '../config/model.js';
import type { Engine } from './engine.js';
import type { CellChange } from './store.js';
import { formula } from '../formula/index.js';
import { Duration, TimeOfDay, Timestamp, type Value, valuesEqual } from '../formula/values.js';

export interface HistoryRow {
  collection: string;
  record: string;
  fields: Record<string, unknown>;
  at: number;
}

export interface HistorySink {
  write(row: HistoryRow): void;
}

interface RecordState {
  lastWrittenAt: number | null;
  lastValues: Map<string, Value>;
  /** a change arrived inside the min_interval; write it when the interval is over */
  pending: boolean;
  heartbeat: NodeJS.Timeout | null;
}

export class HistoryTracker {
  private states = new Map<string, RecordState>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private engine: Engine,
    private sink: HistorySink,
    /** timer factory, replaceable in tests */
    private schedule: (ms: number, cb: () => void) => NodeJS.Timeout = (ms, cb) => {
      const t = setTimeout(cb, ms);
      t.unref();
      return t;
    },
  ) {
    engine.onChanges((changes, at) => this.onChanges(changes, at));
  }

  /** Re-writes records whose max_interval has passed without a write (called by the heartbeat timer). */
  private heartbeat(def: HistoryRecordDef): void {
    const st = this.states.get(def.record);
    if (!st || !def.maxInterval) return;
    st.heartbeat = null;
    const now = this.engine.now();
    if (st.lastWrittenAt !== null && now - st.lastWrittenAt >= def.maxInterval.ms - 50) {
      const values = new Map<string, Value>();
      for (const f of def.fields) {
        try {
          values.set(f.field, this.engine.evaluate(f.formula));
        } catch {
          values.set(f.field, null);
        }
      }
      const allNull = def.fields.filter((f) => f.refs.length > 0).every((f) => values.get(f.field) === null);
      if (!allNull) this.write(def, values, now, st);
    }
    this.armHeartbeat(def, st);
  }

  private armHeartbeat(def: HistoryRecordDef, st: RecordState): void {
    if (!def.maxInterval || st.heartbeat) return;
    const due = (st.lastWrittenAt ?? this.engine.now()) + def.maxInterval.ms;
    st.heartbeat = this.schedule(Math.max(1000, due - this.engine.now()), () => this.heartbeat(def));
  }

  /** Writes every record that already has values (after a restart with a restored snapshot). */
  prime(): void {
    const at = this.engine.now();
    for (const def of this.defs()) this.consider(def, at);
  }

  private defs(): HistoryRecordDef[] {
    return this.engine.config.history;
  }

  private onChanges(changes: CellChange[], at: number): void {
    const changed = new Set(changes.map((c) => c.cell));
    for (const def of this.defs()) {
      if (!def.refs.some((r) => changed.has(r))) continue;
      this.consider(def, at);
    }
  }

  private consider(def: HistoryRecordDef, at: number): void {
    let st = this.states.get(def.record);
    if (!st) this.states.set(def.record, (st = { lastWrittenAt: null, lastValues: new Map(), pending: false, heartbeat: null }));
    const values = new Map<string, Value>();
    let anyNumeric = false;
    let movedEnough = false;
    let anyChanged = false;
    for (const f of def.fields) {
      let v: Value;
      try {
        v = this.engine.evaluate(f.formula);
      } catch {
        v = null;
      }
      values.set(f.field, v);
      const prev = st.lastValues.get(f.field);
      if (typeof v === 'number') {
        anyNumeric = true;
        if (f.minDelta !== null) {
          if (typeof prev !== 'number' || Math.abs(v - prev) >= f.minDelta) movedEnough = true;
        } else if (!valuesEqual(v, prev ?? null)) movedEnough = true;
      } else if (!valuesEqual(v, prev ?? null)) anyChanged = true;
    }
    // Records without any numeric field write on any change; numeric records need a big enough move.
    const shouldWrite = anyNumeric ? movedEnough : anyChanged || st.lastWrittenAt === null;
    if (!shouldWrite) return;
    // Do not write rows whose formula refs are all still NULL (sensor has not reported yet).
    const allNull = def.fields.filter((f) => f.refs.length > 0).every((f) => values.get(f.field) === null);
    if (allNull) return;

    const interval = def.minInterval?.ms ?? 0;
    if (st.lastWrittenAt !== null && interval > 0 && at - st.lastWrittenAt < interval) {
      if (!st.pending) {
        st.pending = true;
        const wait = st.lastWrittenAt + interval - at;
        this.schedule(wait + 50, () => {
          st!.pending = false;
          this.consider(def, this.engine.now());
        });
      }
      return;
    }
    this.write(def, values, at, st);
  }

  private write(def: HistoryRecordDef, values: Map<string, Value>, at: number, st: RecordState): void {
    const fields: Record<string, unknown> = {};
    for (const f of def.fields) {
      let v = values.get(f.field) ?? null;
      if (typeof v === 'number' && f.scale !== null) v = v * f.scale;
      fields[f.field] = encodeForDb(v);
    }
    fields['when'] = new Date(at).toISOString();
    st.lastWrittenAt = at;
    st.lastValues = values;
    this.sink.write({ collection: def.collection, record: def.record, fields, at });
    if (st.heartbeat) {
      clearTimeout(st.heartbeat);
      st.heartbeat = null;
    }
    this.armHeartbeat(def, st);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const st of this.states.values()) if (st.heartbeat) clearTimeout(st.heartbeat);
  }
}

function encodeForDb(v: Value): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Duration) return v.ms / 1000;
  if (v instanceof TimeOfDay) return v.toString();
  if (v instanceof Timestamp) return new Date(v.ms).toISOString();
  return v;
}

/** Convenience for tests: evaluate a record right now regardless of intervals. */
export function evaluateRecord(engine: Engine, def: HistoryRecordDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of def.fields) {
    let v: Value = engine.evaluate(f.formula);
    if (typeof v === 'number' && f.scale !== null) v = v * f.scale;
    out[f.field] = encodeForDb(v);
  }
  return out;
}

export { formula };
