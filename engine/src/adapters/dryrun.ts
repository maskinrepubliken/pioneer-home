/**
 * Dry-run report: while the engine runs with DRY_RUN=true next to Node-RED, every action it would
 * have sent is recorded together with what the device actually did shortly after. Agreement means
 * the tables reproduce the old behaviour; disagreement is either a bug in the tables or an
 * improvement, and either way something to look at before cutting over.
 */
import type { Engine, Trace } from '../core/engine.js';
import type { RawState } from '../core/kinds.js';
import { formatValue, valuesEqual, type Value } from '../formula/values.js';

export interface DryRunEntry {
  at: number;
  source: string;
  device: string;
  topic: string;
  payload: string;
  /** cell -> value the command would have produced */
  expected: Record<string, Value>;
  /** cell -> value observed `checkAfterMs` later */
  observed: Record<string, Value> | null;
  matched: boolean | null;
}

export class DryRunReport {
  readonly entries: DryRunEntry[] = [];

  constructor(
    private engine: Engine,
    private checkAfterMs = 20_000,
    private max = 500,
  ) {
    engine.onTrace((t) => this.onTrace(t));
  }

  private onTrace(t: Trace): void {
    for (const a of t.actions) {
      if (!a.dryRun || !a.topic || !a.payload || !a.topic.endsWith('/set')) continue;
      const stateTopic = a.topic.slice(0, -4);
      const dev = [...this.engine.config.devices.values()].find((d) => this.engine.stateTopic(d) === stateTopic);
      if (!dev) continue;
      let set: RawState;
      try {
        set = JSON.parse(a.payload) as RawState;
      } catch {
        continue;
      }
      const predicted = dev.kind.fromPayload(dev.kind.applySet(currentRaw(this.engine, dev.id), set));
      const expected: Record<string, Value> = {};
      for (const [prop, v] of Object.entries(predicted)) if (prop in set || `${prop}` === 'state') expected[`${dev.id}.${prop}`] = v;
      const entry: DryRunEntry = { at: t.at, source: a.source, device: dev.id, topic: a.topic, payload: a.payload, expected, observed: null, matched: null };
      this.entries.push(entry);
      if (this.entries.length > this.max) this.entries.shift();
      setTimeout(() => this.check(entry), this.checkAfterMs).unref();
    }
  }

  private check(entry: DryRunEntry): void {
    const observed: Record<string, Value> = {};
    let matched = true;
    for (const [cell, want] of Object.entries(entry.expected)) {
      const have = this.engine.store.get(cell);
      observed[cell] = have;
      if (typeof want === 'number' && typeof have === 'number') {
        if (Math.abs(want - have) > 2) matched = false;
      } else if (!valuesEqual(want, have)) matched = false;
    }
    entry.observed = observed;
    entry.matched = matched;
  }

  summary(): { total: number; matched: number; mismatched: number; pending: number } {
    const total = this.entries.length;
    const matched = this.entries.filter((e) => e.matched === true).length;
    const mismatched = this.entries.filter((e) => e.matched === false).length;
    return { total, matched, mismatched, pending: total - matched - mismatched };
  }

  format(tz: string): string {
    const lines = this.entries.map((e) => {
      const time = new Date(e.at).toLocaleTimeString('sv-SE', { timeZone: tz });
      const exp = Object.entries(e.expected).map(([c, v]) => `${c}=${formatValue(v)}`).join(' ');
      const obs = e.observed ? Object.entries(e.observed).map(([c, v]) => `${c}=${formatValue(v)}`).join(' ') : '(pending)';
      const flag = e.matched === null ? '?' : e.matched ? 'OK ' : 'DIFF';
      return `${time} ${flag} ${e.source}\n        expected ${exp}\n        observed ${obs}`;
    });
    const s = this.summary();
    return [...lines, `${s.total} would-send actions: ${s.matched} matched Node-RED, ${s.mismatched} differed, ${s.pending} pending`].join('\n');
  }
}

/** Best-effort raw device state from the store, for applySet's relative operations. */
function currentRaw(engine: Engine, deviceId: string): RawState {
  const raw: RawState = {};
  const b = engine.store.get(`${deviceId}.brightness`);
  if (typeof b === 'number') raw['brightness'] = Math.round((b / 100) * 254);
  const s = engine.store.get(`${deviceId}.state`);
  if (typeof s === 'boolean') raw['state'] = s ? 'ON' : 'OFF';
  const l = engine.store.get(`${deviceId}.level`);
  if (typeof l === 'number') raw['level'] = l;
  return raw;
}
