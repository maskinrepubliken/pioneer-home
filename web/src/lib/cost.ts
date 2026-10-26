/**
 * Estimated energy and cost for appliances with a rated power (devices.tsv `watts`). Pure functions, no Svelte.
 *
 * Use over time is a stepped series of percent: a thermostat's heating demand (the share of time it heats), or
 * 0/100 for an on/off appliance. Energy = watts x percent x time; each 5-minute step is priced at the spot price of
 * that moment x VAT factor + a fixed surcharge (cells electricity_vat, electricity_surcharge). A value is held until
 * the next history row, but never longer than MAX_HOLD: a longer gap (a device that could not be reached, the engine
 * stopped) counts as unknown, not as running. On/off appliances are written only when they switch, so for them
 * the value is held until the next row (maxHold = Infinity).
 */
import type { PriceSlot } from './api';
import { seriesBy, sourceId, sourceName, ts, type Names, type Points, type Rec, type Series } from './history';

const STEP = 300;
/** History heartbeats are at most 30 min apart; beyond an hour without a row the value is not trusted. */
export const MAX_HOLD = 3600;

export interface Pricing {
  slots: PriceSlot[];
  vat: number;
  surcharge: number;
}

export interface CostResult {
  label: string;
  watts: number;
  kwh: number;
  sek: number;
  /** seconds of the interval without a usable value */
  unknown: number;
  /** cumulative cost in SEK, one point per hour, for the chart */
  cumulative: Points;
}

/** Spot price (SEK/kWh, no VAT) at an instant, or null. `slots` sorted by start. */
function spotAt(slots: PriceSlot[], t: number, hint: { i: number }): number | null {
  while (hint.i < slots.length && slots[hint.i]!.end <= t) hint.i++;
  const s = slots[hint.i];
  return s && s.start <= t && t < s.end ? s.sek : null;
}

export function meanSpot(slots: PriceSlot[]): number | null {
  if (!slots.length) return null;
  return slots.reduce((n, s) => n + s.sek, 0) / slots.length;
}

export function estimate(label: string, watts: number, use: Points, since: number, until: number, pricing: Pricing, maxHold = MAX_HOLD): CostResult {
  const fallback = meanSpot(pricing.slots);
  const hint = { i: 0 };
  let kwh = 0;
  let sek = 0;
  let unknown = 0;
  const cumulative: Points = [[since, 0]];
  let nextMark = since + 3600;
  let idx = 0;
  let current: number | null = null;
  let heldSince = -Infinity;
  for (let t = since; t < until; t += STEP) {
    while (idx < use.length && use[idx]![0] <= t) {
      current = use[idx]![1];
      heldSince = use[idx]![0];
      idx++;
    }
    const dt = Math.min(STEP, until - t);
    if (current === null || t - heldSince > maxHold) {
      unknown += dt;
    } else {
      const e = (watts / 1000) * (current / 100) * (dt / 3600);
      const spot = spotAt(pricing.slots, t, hint) ?? fallback;
      kwh += e;
      if (spot !== null) sek += e * (spot * pricing.vat + pricing.surcharge);
    }
    if (t + STEP >= nextMark) {
      cumulative.push([Math.min(nextMark, until), sek]);
      nextMark += 3600;
    }
  }
  cumulative.push([until, sek]);
  return { label, watts, kwh, sek, unknown, cumulative };
}

/** Cumulative cost lines for the chart, one per appliance. */
export function costSeries(results: CostResult[]): Series[] {
  return results.map((r) => ({ label: r.label, points: r.cumulative }));
}

/**
 * Heating rows from a thermostat that was frozen are left out: a live thermostat's temperature moves a little
 * between rows, so a run of rows with the very same `current` and `pi` is a silent device's cached value
 * (zigbee2mqtt keeps the last state and the heartbeat repeats it). Only the last row of such a run counts, and it is
 * held at most an hour, so a frozen stretch is unknown, not heating. An on/off heater switching at a steady
 * temperature is not frozen (its `pi` changes).
 */
export function liveHeatingRows(items: Rec[]): Rec[] {
  const bySensor = new Map<string, Rec[]>();
  for (const r of items) {
    if (ts(r) === null) continue;
    const k = String(r['sensor'] ?? '');
    let list = bySensor.get(k);
    if (!list) bySensor.set(k, (list = []));
    list.push(r);
  }
  const key = (x: Rec | undefined) => (x ? `${String(x['current'])}|${String(x['pi'])}` : undefined);
  const out: Rec[] = [];
  for (const list of bySensor.values()) {
    list.sort((a, b) => ts(a)! - ts(b)!);
    list.forEach((r, i) => {
      const prev = key(list[i - 1]);
      const next = key(list[i + 1]);
      const own = key(r);
      if (prev === undefined || next === undefined || own !== prev || own !== next) out.push(r);
    });
  }
  return out;
}

export interface CostInput {
  heating: Rec[];
  power: Rec[];
  names: Names;
  pricing: Pricing;
  since: number;
  until: number;
  /** devices left out (cannot be reached now) */
  skip: (id: string) => boolean;
  /** room id -> display name, to tell same-named devices apart */
  roomLabel: (room: string) => string;
}

/**
 * Cost per appliance with `watts`: thermostats by their heating demand (held at most an hour between rows),
 * on/off appliances by their on-time (written when they switch, so each value holds until the next row).
 * Two devices with the same name ("Golvvärme" in two rooms) are told apart by their room. Most expensive first.
 */
export function computeCosts(input: CostInput): CostResult[] {
  const { names, pricing, since, until } = input;
  const label = (key: string) => sourceName(names, key);
  const out: { id: string; result: CostResult }[] = [];
  for (const s of seriesBy(liveHeatingRows(input.heating), 'sensor', 'pi', (k) => k)) {
    const id = sourceId(names, s.label);
    const w = names.deviceWatts[id];
    if (w && !input.skip(id)) out.push({ id, result: estimate(label(s.label), w, s.points, since, until, pricing) });
  }
  for (const s of seriesBy(input.power, 'name', 'powerlevel', (k) => k)) {
    const id = sourceId(names, s.label);
    const w = names.deviceWatts[id];
    if (w && !input.skip(id) && names.deviceKind[id] !== 'pwm') out.push({ id, result: estimate(label(s.label), w, s.points, since, until, pricing, Infinity) });
  }
  const count = new Map<string, number>();
  for (const o of out) count.set(o.result.label, (count.get(o.result.label) ?? 0) + 1);
  for (const o of out) {
    if ((count.get(o.result.label) ?? 0) > 1) {
      const room = names.deviceRoom[o.id];
      o.result.label = `${o.result.label} · ${room ? input.roomLabel(room) : o.id}`;
    }
  }
  return out.map((o) => o.result).sort((a, b) => b.sek - a.sek);
}

/** Cost of one appliance inside each [from, to) bucket (epoch seconds), read off its hourly cumulative curve. */
export function costPerBucket(r: CostResult, buckets: [number, number][]): number[] {
  const at = (t: number) => {
    let v = 0;
    for (const [pt, sek] of r.cumulative) {
      if (pt > t) break;
      v = sek;
    }
    return v;
  };
  return buckets.map(([a, b]) => Math.max(0, at(b) - at(a)));
}

/** A thermostat silent this long (the engine's history limit) is dead even if zigbee2mqtt replayed its cached state. */
export const STALE_MS = 6 * 3_600_000;

/**
 * True for a device that cannot be reached now; its old history rows are a dead device's last value, not real use.
 * `available` FALSE, or a thermostat (which reports its temperature all the time) silent for STALE_MS.
 */
export function isUnreachable(cells: Record<string, { value: unknown } | undefined>, names: Names, id: string, nowMs: number): boolean {
  if (cells[`${id}.available`]?.value === false) return true;
  const seen = cells[`${id}.last_seen`]?.value;
  const at = seen && typeof seen === 'object' && '$timestamp' in seen ? (seen as { $timestamp: number }).$timestamp : null;
  return names.deviceKind[id] === 'thermostat' && at !== null && nowMs - at > STALE_MS;
}

/** "1,23 kr" under 10 kr, "45 kr" above. */
export function kr(n: number): string {
  const d = n < 10 ? 2 : 0;
  return `${n.toLocaleString('sv-SE', { minimumFractionDigits: d, maximumFractionDigits: d })} kr`;
}
