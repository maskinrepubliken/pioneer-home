/**
 * A room's thermal model, learnt from history. Pure functions, no I/O.
 *
 * The room is one lump of heat, seen through its thermostats' own sensors (the temperature the setpoints are
 * compared with):
 *
 *   dT/dt [°C/h] = a * P  -  b * (T - Tout)  +  c * S  +  d
 *
 *   P     heating power [kW]: the room's thermostats, rated watts x heating demand
 *   Tout  outdoor temperature [°C]
 *   S     sun, 0..1: sin(solar elevation) dimmed by cloud cover (clear-sky proxy, cloud octas)
 *   a     °C/h per kW: how fast the heaters warm the room
 *   b     1/h: how fast the room loses heat to the outside (1/b = the time constant in hours)
 *   c     °C/h at full sun, d °C/h from everything else (people, appliances, neighbouring rooms)
 *
 * Fitted by least squares on fixed steps (an hour: the sensors' 0.1 °C resolution makes shorter steps mostly noise).
 * From it: the heating curve (power needed to hold a temperature at an outdoor temperature) and a simulator for
 * the planner (core/planner.ts).
 */

export interface RoomModel {
  a: number;
  b: number;
  c: number;
  d: number;
  /** samples used, coefficient of determination of the fit, step length in seconds */
  n: number;
  r2: number;
  stepS: number;
  /** epoch ms of the first and last sample */
  from: number;
  to: number;
}

export interface ThermalSample {
  /** start of the step, epoch seconds */
  t: number;
  /** room temperature (mean over the step) */
  tin: number;
  tout: number;
  /** kW, mean over the step */
  power: number;
  sun: number;
}

const RAD = Math.PI / 180;

/** Solar elevation in degrees at an instant (NOAA approximation, good to a fraction of a degree). */
export function solarElevation(epochMs: number, latitude: number, longitude: number): number {
  const n = epochMs / 86_400_000 - 10957.5; // days since J2000.0
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 4e-7 * n) * RAD;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const ha = (gmst * 15 + longitude) * RAD - ra;
  const la = latitude * RAD;
  return Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha)) / RAD;
}

/** 0..1: sin(elevation) dimmed by clouds (Kasten–Czeplak), 0 below the horizon. `octas` 0 (clear) .. 8 (overcast). */
export function sunFactor(elevationDeg: number, octas: number): number {
  const s = Math.max(0, Math.sin(elevationDeg * RAD));
  return s * (1 - 0.75 * Math.pow(Math.min(Math.max(octas, 0), 8) / 8, 3.4));
}

/** Cloud octas from an OpenWeatherMap icon code (`01d` clear .. `04d` overcast, rain/snow/fog as overcast). */
export function iconOctas(icon: string | null | undefined): number | null {
  if (!icon) return null;
  const k = icon.slice(0, 2);
  return ({ '01': 0, '02': 2, '03': 4, '04': 7 } as Record<string, number>)[k] ?? 8;
}

/** [epoch seconds, value] pairs, ascending. */
export type Points = [number, number][];

/**
 * Time-weighted mean of a stepped series over [a, b): each value holds until the next point, at most `holdS`
 * seconds; null when less than 60 % of the interval is covered.
 */
export function meanOver(points: Points, a: number, b: number, holdS: number): number | null {
  // the last point at or before a (its value covers the start of the interval), else the first one after it
  let lo = 0;
  let hi = points.length - 1;
  let first = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (points[m]![0] <= a) {
      first = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  let sum = 0;
  let covered = 0;
  for (let k = first; k < points.length && points[k]![0] < b; k++) {
    const [pt, v] = points[k]!;
    const start = Math.max(pt, a);
    const next = k + 1 < points.length ? points[k + 1]![0] : Infinity;
    const end = Math.min(next, pt + holdS, b);
    if (end > start) {
      sum += v * (end - start);
      covered += end - start;
    }
  }
  return covered >= 0.6 * (b - a) ? sum / covered : null;
}

export interface SampleInput {
  /** each of the room's thermostats' temperature */
  temperatures: Points[];
  /** each heat source's demand in percent and its rated power in kW */
  heaters: { demand: Points; kw: number }[];
  outdoor: Points;
  /** cloud octas over time (history: from the weather icon) */
  clouds: Points;
  latitude: number;
  longitude: number;
  from: number;
  to: number;
  stepS: number;
}

/** Fixed-step samples (epoch seconds) wherever every input is known. */
export function buildSamples(input: SampleInput): ThermalSample[] {
  const out: ThermalSample[] = [];
  const { stepS } = input;
  for (let a = Math.ceil(input.from / stepS) * stepS; a + stepS <= input.to; a += stepS) {
    const b = a + stepS;
    const temps = input.temperatures.map((p) => meanOver(p, a, b, 2 * 3600));
    if (!temps.length || temps.some((v) => v === null)) continue;
    let power = 0;
    let known = true;
    for (const h of input.heaters) {
      const v = meanOver(h.demand, a, b, 3600);
      if (v === null) {
        known = false;
        break;
      }
      power += (h.kw * v) / 100;
    }
    const tout = meanOver(input.outdoor, a, b, 3 * 3600);
    const octas = meanOver(input.clouds, a, b, 3 * 3600);
    if (!known || tout === null || octas === null) continue;
    const sun = sunFactor(solarElevation((a + stepS / 2) * 1000, input.latitude, input.longitude), octas);
    out.push({ t: a, tin: (temps as number[]).reduce((s, v) => s + v, 0) / temps.length, tout, power, sun });
  }
  return out;
}

/** Least squares for y = X β (normal equations, Gauss–Jordan with partial pivoting). Null when singular. */
export function leastSquares(X: number[][], y: number[]): number[] | null {
  const n = X[0]?.length ?? 0;
  if (!n || X.length < n) return null;
  const M = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
  X.forEach((row, k) => {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) M[i]![j]! += row[i]! * row[j]!;
      M[i]![n]! += row[i]! * y[k]!;
    }
  });
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r]![i]!) > Math.abs(M[p]![i]!)) p = r;
    if (Math.abs(M[p]![i]!) < 1e-12) return null;
    [M[i], M[p]] = [M[p]!, M[i]!];
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = M[r]![i]! / M[i]![i]!;
      for (let c = i; c <= n; c++) M[r]![c]! -= f * M[i]![c]!;
    }
  }
  return M.map((r, i) => r[n]! / r[i]!);
}

/** Fits the model on consecutive samples (pairs exactly one step apart). Null without enough data. */
export function fitModel(samples: ThermalSample[], stepS: number, minPairs = 48): RoomModel | null {
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const p = samples[i - 1]!;
    const q = samples[i]!;
    if (q.t - p.t !== stepS) continue;
    X.push([p.power, -(p.tin - p.tout), p.sun, 1]);
    y.push(((q.tin - p.tin) * 3600) / stepS);
  }
  if (X.length < minPairs) return null;
  const beta = leastSquares(X, y);
  if (!beta) return null;
  const [a, b, c, d] = beta as [number, number, number, number];
  const mean = y.reduce((s, v) => s + v, 0) / y.length;
  const ssTot = y.reduce((s, v) => s + (v - mean) ** 2, 0);
  const ssRes = y.reduce((s, v, k) => s + (v - (a * X[k]![0]! + b * X[k]![1]! + c * X[k]![2]! + d)) ** 2, 0);
  return { a, b, c, d, n: X.length, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0, stepS, from: samples[0]!.t * 1000, to: samples[samples.length - 1]!.t * 1000 };
}

/** Below this share of the hourly changes explained, a model is too unsure to steer by (the schedule applies). */
export const MIN_R2 = 0.15;

/**
 * A model the planner can trust: heaters warm, the room loses heat, a time constant between 2 h and 2 weeks, and it
 * explains at least MIN_R2 of the hourly changes (the sensors' 0.1 °C steps keep this low even for a good model).
 */
export function usable(m: RoomModel | null): m is RoomModel {
  return !!m && m.a > 0.01 && m.b > 1 / 336 && m.b < 0.5 && m.r2 >= MIN_R2 && Number.isFinite(m.c) && Number.isFinite(m.d);
}

/** The temperature after `hours` of constant conditions (exact solution of the linear model). */
export function step(m: RoomModel, tin: number, tout: number, power: number, sun: number, hours: number): number {
  // dT/dt = k - b T  with  k = a P + b Tout + c S + d  ->  T(t) = T∞ + (T0 - T∞) e^(-b t)
  const k = m.a * power + m.b * tout + m.c * sun + m.d;
  const tInf = k / m.b;
  return tInf + (tin - tInf) * Math.exp(-m.b * hours);
}

/** Power [kW] that holds `tin` at `tout` and `sun` (the heating curve); 0 when the room holds it without heat. */
export function holdingPower(m: RoomModel, tin: number, tout: number, sun = 0): number {
  return Math.max(0, (m.b * (tin - tout) - m.c * sun - m.d) / m.a);
}
