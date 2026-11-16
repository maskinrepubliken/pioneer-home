/**
 * The house's heat loss: watts per °C between inside and out (W/K), from quiet night hours, per era between the
 * events in events.tsv (a renovation step, insulation), so the eras can be compared. Pure functions; the service
 * that feeds them from history is adapters/heatloss.ts.
 *
 * The zone is every heated room (adapters/program.ts heatedRooms): its heating power is the sum of the thermostats'
 * watts × demand, its temperature the mean of the rooms'. Every three hours in the dark (evening, night, early
 * morning: no sun) give the energy used and the mean difference inside − outside. Such a window counts when the zone
 * was steady (it neither cooled nor warmed by more than `steady` °C over it; a room cooling towards a lower target
 * lives on stored heat, one being warmed stores it) and no extra heat (a wood stove) was seen from 8 hours before it
 * to its end. Called nights below, as they mostly are.
 *
 * The zone also gets heat that is not in the thermostats (the rest of the house, appliances, people): `Q`. So a night's
 * power is P = UA·ΔT − Q, and P/ΔT alone looks better on a mild night than on a cold one. One least-squares fit over
 * every counted night gives Q (shared) and UA per era; a night's own value is (P + Q) / ΔT.
 */
import { leastSquares } from './thermal.js';

/** A zone sample (epoch seconds): its temperature, outdoor temperature, heating power in kW, extra heat seen. */
export interface ZoneSample {
  t: number;
  tin: number;
  tout: number;
  power: number;
  extra?: boolean;
  /** extra heat seen as the room warming with its heaters at rest (part of `extra`) */
  warming?: boolean;
  /** solar gain factor (0 when the sun is down) */
  sun?: number;
}

export interface Night {
  /** window start, epoch seconds */
  t: number;
  /** local date of the window, YYYY-MM-DD */
  date: string;
  /** mean heating power over the window, kW */
  kw: number;
  /** mean inside − outside over the window, °C */
  dT: number;
  tin: number;
  tout: number;
  /** how much the zone warmed (+) or cooled (−) over the window, °C */
  change: number;
  /** the zone's highest less its lowest temperature, from the hour before to the hour after, °C */
  span?: number;
  /** extra heat (a wood stove) seen from the look-back before the window to its end */
  extra: boolean;
}

export interface Era {
  /** epoch ms of the event that starts it (the first era: the first night measured) */
  from: number;
  /** as written in events.tsv; empty for the first era */
  at: string;
  title: string;
}

export interface EraResult extends Era {
  /** nights counted */
  nights: number;
  /** W/K, null without counted nights or a fit */
  ua: number | null;
  /** standard error of ua, W/K */
  se: number | null;
  /** each counted night: local date, W/K */
  perNight: { date: string; ua: number }[];
}

export interface HeatLossResult {
  /** heat the zone gets without the thermostats, W (null until there are enough nights) */
  freeHeat: number | null;
  eras: EraResult[];
  /** nights measured, and why the others were not counted */
  measured: number;
  counted: number;
  extra: number;
  unsteady: number;
}

/** The night in [from, to) (epoch seconds) from zone samples, or null when too little is known. */
export function nightOf(samples: ZoneSample[], from: number, to: number, date: string, stepS: number, lookbackS: number): Night | null {
  const inWin = samples.filter((s) => s.t >= from && s.t < to);
  if (inWin.length < 0.8 * ((to - from) / stepS)) return null;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const before = samples.filter((s) => s.t >= from - 3600 && s.t < from).map((s) => s.tin);
  const after = samples.filter((s) => s.t >= to && s.t < to + 3600).map((s) => s.tin);
  // from the hour before to the hour after, scaled to the window
  const change = before.length && after.length ? ((mean(after) - mean(before)) * (to - from)) / (to - from + 3600) : inWin[inWin.length - 1]!.tin - inWin[0]!.tin;
  const r = (v: number, d = 100) => Math.round(v * d) / d;
  const around = samples.filter((s) => s.t >= from - 3600 && s.t < to + 3600).map((s) => s.tin);
  return {
    t: from,
    date,
    kw: r(mean(inWin.map((s) => s.power)), 1000),
    dT: r(mean(inWin.map((s) => s.tin - s.tout))),
    tin: r(mean(inWin.map((s) => s.tin))),
    tout: r(mean(inWin.map((s) => s.tout))),
    change: r(change),
    span: r(Math.max(...around) - Math.min(...around)),
    extra: samples.some((s) => s.extra && s.t >= from - lookbackS && s.t < to),
  };
}

/**
 * The steady windows of `winS` seconds in [from, to) (epoch seconds), each starting on a full hour with the sun down in
 * every sample: a window counts when the zone changed less than `steady` °C over it and did not swing more than
 * SPAN × `steady` within it (warmed and cooled back); the next one starts after it.
 * `label` names a window by its start (local date and time). Windows with extra heat are kept, flagged.
 */
export function steadyWindows(samples: ZoneSample[], from: number, to: number, stepS: number, lookbackS: number, winS: number, steady: number, label: (t: number) => string): Night[] {
  const at = new Map(samples.map((s) => [s.t, s]));
  const out: Night[] = [];
  let t = Math.ceil(from / 3600) * 3600;
  while (t < to) {
    const qs = Array.from({ length: winS / stepS }, (_, i) => at.get(t + i * stepS));
    if (qs.every((q) => q && (q.sun ?? 0) <= 0)) {
      const n = nightOf(samples, t, t + winS, label(t), stepS, lookbackS);
      if (n && Math.abs(n.change) < steady && (n.span ?? 0) < SPAN * steady) {
        out.push(n);
        t += winS;
        continue;
      }
    }
    t += 3600;
  }
  return out;
}

/** How far the zone may swing within a steady window, in multiples of `steady` (a thermostat holding wobbles a little). */
const SPAN = 2.5;

/** Inverse of a small symmetric matrix (Gauss–Jordan), null when singular. */
function invert(A: number[][]): number[][] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r]![i]!) > Math.abs(M[p]![i]!)) p = r;
    if (Math.abs(M[p]![i]!) < 1e-12) return null;
    [M[i], M[p]] = [M[p]!, M[i]!];
    const d = M[i]![i]!;
    for (let c = 0; c < 2 * n; c++) M[i]![c]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = M[r]![i]!;
      for (let c = 0; c < 2 * n; c++) M[r]![c]! -= f * M[i]![c]!;
    }
  }
  return M.map((row) => row.slice(n));
}

/** At least this many counted nights, one era with three of them, before Q can be told from UA. */
const MIN_NIGHTS = 5;
/** A night this close to the outdoor temperature says little (and divides by almost nothing). */
const MIN_DT = 3;

/** UA per era and the shared free heat, from the nights measured. `eras` sorted by `from`. */
export function fitHeatLoss(nights: Night[], eras: Era[], steady: number): HeatLossResult {
  const counted = nights.filter((n) => !n.extra && Math.abs(n.change) < steady && n.dT >= MIN_DT);
  const eraOf = (n: Night) => {
    let k = 0;
    for (let i = 0; i < eras.length; i++) if (eras[i]!.from <= n.t * 1000) k = i;
    return k;
  };
  const byEra = eras.map(() => [] as Night[]);
  for (const n of counted) byEra[eraOf(n)]!.push(n);
  const active = byEra.map((xs, i) => (xs.length ? i : -1)).filter((i) => i >= 0);
  const base = { measured: nights.length, counted: counted.length, extra: nights.filter((n) => n.extra).length, unsteady: nights.filter((n) => !n.extra && Math.abs(n.change) >= steady).length };
  const empty = (): HeatLossResult => ({ ...base, freeHeat: null, eras: eras.map((e, i) => ({ ...e, nights: byEra[i]!.length, ua: null, se: null, perNight: [] })) });
  if (counted.length < MIN_NIGHTS || !byEra.some((xs) => xs.length >= 3)) return empty();
  // P = Σ UA_era · ΔT · [era] − Q
  const X = counted.map((n) => [...active.map((i) => (eraOf(n) === i ? n.dT : 0)), -1]);
  const y = counted.map((n) => n.kw);
  let beta = leastSquares(X, y);
  let cols = X;
  if (beta && beta[beta.length - 1]! < 0) {
    // heat that takes heat away is not free heat: without it
    cols = X.map((row) => row.slice(0, -1));
    beta = leastSquares(cols, y);
    if (beta) beta = [...beta, 0];
  }
  if (!beta) return empty();
  const q = beta[beta.length - 1]!;
  const k = cols[0]!.length;
  const resid = y.map((v, j) => v - cols[j]!.reduce((s, x, c) => s + x * beta![c]!, 0));
  const dof = Math.max(1, y.length - k);
  const s2 = resid.reduce((s, r) => s + r * r, 0) / dof;
  const xtx = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (_, b) => cols.reduce((s, row) => s + row[a]! * row[b]!, 0)));
  const inv = invert(xtx);
  const r0 = (v: number) => Math.round(v);
  return {
    ...base,
    freeHeat: r0(q * 1000),
    eras: eras.map((e, i) => {
      const c = active.indexOf(i);
      const xs = byEra[i]!;
      return {
        ...e,
        nights: xs.length,
        ua: c >= 0 ? r0(beta![c]! * 1000) : null,
        se: c >= 0 && inv ? r0(Math.sqrt(Math.max(0, s2 * inv[c]![c]!)) * 1000) : null,
        perNight: xs.map((n) => ({ date: n.date, ua: r0(((n.kw + q) / n.dT) * 1000) })),
      };
    }),
  };
}

/**
 * A cooling hour: an hour in the dark with the heaters nearly at rest and no extra heat, the zone left to cool.
 * `rate` is how fast it cooled (°C/h, negative when cooling), `dT` the mean inside − outside.
 */
export interface CoolingHour {
  t: number;
  rate: number;
  dT: number;
}

export interface CoolingEra {
  /** cooling hours in the era */
  hours: number;
  /** W/K from the cooling rate and the heat capacity, null without enough hours or no capacity yet */
  ua: number | null;
  se: number | null;
}

export interface CoolingResult {
  /** heat capacity of the zone, kWh/K (from the eras with a steady measure as well), null until known */
  capacity: number | null;
  eras: CoolingEra[];
}

/**
 * Cooling hours in [from, to) (epoch seconds) from zone samples; `maxKw` is the zone's rated heating power. An hour
 * with a room warming by itself (`warming`) in the look-back before it is left out.
 */
export function coolingHours(samples: ZoneSample[], from: number, to: number, stepS: number, lookbackS: number, maxKw: number): CoolingHour[] {
  const at = new Map(samples.map((s) => [s.t, s]));
  const out: CoolingHour[] = [];
  const perHour = 3600 / stepS;
  for (let t = Math.ceil(from / 3600) * 3600; t < to; t += 3600) {
    // this hour and the one before: dark, heaters under a tenth of their power (the air cools fast for a while after
    // heating stops, so the hour before must be quiet too), and the end of the hour known
    const qs = Array.from({ length: 2 * perHour + 1 }, (_, i) => at.get(t - 3600 + i * stepS));
    if (qs.some((q) => !q || (q.sun ?? 0) > 0) || qs.slice(0, -1).some((q) => q!.power > 0.1 * maxKw)) continue;
    if (samples.some((s) => s.warming && s.t >= t - lookbackS && s.t < t + 3600)) continue;
    const hour = qs.slice(perHour, 2 * perHour) as ZoneSample[];
    const dT = hour.reduce((a, s) => a + s.tin - s.tout, 0) / hour.length;
    if (dT < MIN_DT) continue;
    out.push({ t, rate: Math.round((qs[2 * perHour]!.tin - qs[perHour]!.tin) * 1000) / 1000, dT: Math.round(dT * 100) / 100 });
  }
  return out;
}

/** At least this many cooling hours before an era gets a value. */
const MIN_COOLING_HOURS = 3;

/**
 * Heat loss from cooling: the zone cools as C·dT/dt = −(UA·ΔT − Q). The capacity C (kWh/K: what walls and air hold,
 * which insulation does not change) comes from the eras that also have a steady measure, where UA and Q are known:
 * −dT/dt = (UA·ΔT − Q)/C, one least-squares slope through the origin. Then each cooling hour of any era gives its own
 * UA = (−dT/dt · C + Q) / ΔT, and an era's value is the mean of its hours (± the standard error).
 */
export function fitCooling(hours: CoolingHour[], eras: Era[], steadyUa: (number | null)[], freeHeat: number | null): CoolingResult {
  const eraOf = (h: CoolingHour) => {
    let k = 0;
    for (let i = 0; i < eras.length; i++) if (eras[i]!.from <= h.t * 1000) k = i;
    return k;
  };
  const byEra = eras.map(() => [] as CoolingHour[]);
  for (const h of hours) byEra[eraOf(h)]!.push(h);
  const q = (freeHeat ?? 0) / 1000;
  let sxy = 0;
  let sxx = 0;
  byEra.forEach((xs, i) => {
    const ua = steadyUa[i];
    if (ua === null || ua === undefined || xs.length < MIN_COOLING_HOURS) return;
    for (const h of xs) {
      const x = (ua / 1000) * h.dT - q;
      sxy += x * -h.rate;
      sxx += x * x;
    }
  });
  const inv = sxx > 0 ? sxy / sxx : 0;
  const capacity = inv > 0 ? 1 / inv : null;
  return {
    capacity: capacity === null ? null : Math.round(capacity * 100) / 100,
    eras: byEra.map((xs) => {
      if (capacity === null || xs.length < MIN_COOLING_HOURS) return { hours: xs.length, ua: null, se: null };
      const v = xs.map((h) => ((-h.rate * capacity + q) / h.dT) * 1000);
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1));
      return { hours: xs.length, ua: Math.round(m), se: Math.round(sd / Math.sqrt(v.length)) };
    }),
  };
}
