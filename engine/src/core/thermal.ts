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
 * Fitted on the room's trajectory (`fitTrajectory`): from the measured temperature at the start of a window of some
 * hours, the model is run forward with the heating, weather and sun that really were, and the coefficients are
 * those that keep it closest to the measured temperatures over the whole window, recent days weighing more. A
 * one-step fit (`fitModel`, least squares on hourly changes) drowns in the sensors' 0.1 °C steps and the noisy
 * demand readings, and comes out too slow both ways: it then believes the room keeps heat it does not. The one-step
 * fit is only the starting point. `backtest` runs the model over the last day the same way, to show how well it
 * holds. From the model: the heating curve (power needed to hold a temperature at an outdoor temperature) and a
 * simulator for the planner (core/planner.ts).
 */

export interface RoomModel {
  a: number;
  b: number;
  c: number;
  d: number;
  /** samples used, step length in seconds */
  n: number;
  stepS: number;
  /** root mean square of model minus measured temperature over the fit's windows, °C (weighted by age) */
  rmse: number;
  /** length of the windows the trajectory was fitted on, hours */
  horizonH: number;
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

/** One-step least squares on consecutive samples (pairs exactly one step apart): the trajectory fit's start. Null without enough data. */
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
  const rmse = Math.sqrt(y.reduce((s, v, k) => s + (v - (a * X[k]![0]! + b * X[k]![1]! + c * X[k]![2]! + d)) ** 2, 0) / y.length);
  return { a, b, c, d, n: X.length, stepS, rmse, horizonH: stepS / 3600, from: samples[0]!.t * 1000, to: samples[samples.length - 1]!.t * 1000 };
}

export interface TrajectoryOptions {
  stepS: number;
  /** steps per window: how far the model is run from a measured start */
  horizonSteps: number;
  /** a sample this much older weighs half (seconds) */
  halfLifeS: number;
  /** epoch seconds the ages are counted from */
  now: number;
  /** fewest samples to fit on */
  minSamples?: number;
}

/** The model run forward over consecutive samples from a measured start: temperatures after each step, until a gap. */
export function simulate(m: RoomModel, samples: ThermalSample[], i0: number, steps: number, stepS: number): number[] {
  const out: number[] = [];
  let t = samples[i0]!.tin;
  for (let k = i0; k < i0 + steps && k + 1 < samples.length; k++) {
    if (samples[k + 1]!.t - samples[k]!.t !== stepS) break;
    const s = samples[k]!;
    t = step(m, t, s.tout, s.power, s.sun, stepS / 3600);
    out.push(t);
  }
  return out;
}

/** Nelder–Mead minimisation (no derivatives), from a start point and the size of the first simplex per dimension. */
export function nelderMead(f: (x: number[]) => number, x0: number[], scale: number[], iterations = 800): number[] {
  const n = x0.length;
  let pts = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + scale[i]! : v)))].map((x) => ({ x, f: f(x) }));
  const at = (a: number[], b: number[], t: number) => a.map((v, i) => v + t * (b[i]! - v));
  for (let it = 0; it < iterations; it++) {
    pts.sort((p, q) => p.f - q.f);
    if (Math.abs(pts[n]!.f - pts[0]!.f) < 1e-10 * (1 + Math.abs(pts[0]!.f))) break;
    const centroid = x0.map((_, i) => pts.slice(0, n).reduce((s, p) => s + p.x[i]!, 0) / n);
    const worst = pts[n]!;
    const r = at(centroid, worst.x, -1);
    const fr = f(r);
    if (fr < pts[0]!.f) {
      const e = at(centroid, worst.x, -2);
      const fe = f(e);
      pts[n] = fe < fr ? { x: e, f: fe } : { x: r, f: fr };
    } else if (fr < pts[n - 1]!.f) pts[n] = { x: r, f: fr };
    else {
      const c = at(centroid, worst.x, fr < worst.f ? -0.5 : 0.5);
      const fc = f(c);
      if (fc < Math.min(fr, worst.f)) pts[n] = { x: c, f: fc };
      else pts = pts.map((p, i) => (i === 0 ? p : { x: at(pts[0]!.x, p.x, 0.5), f: f(at(pts[0]!.x, p.x, 0.5)) }));
    }
  }
  pts.sort((p, q) => p.f - q.f);
  return pts[0]!.x;
}

/**
 * Fits the model on trajectories: windows of `horizonSteps` start every half window wherever the samples run on
 * without a gap; in each the model runs from the measured start and every step's miss counts, weighted by age
 * (half-life). a and b are kept positive. Null without enough data or when nothing better than the start is found.
 */
export function fitTrajectory(samples: ThermalSample[], opts: TrajectoryOptions): RoomModel | null {
  const { stepS, horizonSteps: H } = opts;
  if (samples.length < (opts.minSamples ?? 4 * H)) return null;
  const starts: number[] = [];
  for (let i = 0; i + 1 < samples.length; i += Math.max(1, Math.floor(H / 2))) if (samples[i + 1]!.t - samples[i]!.t === stepS) starts.push(i);
  if (!starts.length) return null;
  const weight = (t: number) => Math.pow(0.5, (opts.now - t) / opts.halfLifeS);
  const make = (x: number[]): RoomModel => ({ a: Math.exp(x[0]!), b: Math.exp(x[1]!), c: x[2]!, d: x[3]!, n: samples.length, stepS, rmse: 0, horizonH: (H * stepS) / 3600, from: samples[0]!.t * 1000, to: samples[samples.length - 1]!.t * 1000 });
  const loss = (x: number[]) => {
    const m = make(x);
    let sum = 0;
    let w = 0;
    for (const i of starts) {
      const sim = simulate(m, samples, i, H, stepS);
      sim.forEach((v, k) => {
        const q = samples[i + 1 + k]!;
        const wq = weight(q.t);
        sum += wq * (v - q.tin) ** 2;
        w += wq;
      });
    }
    return w > 0 ? sum / w : Infinity;
  };
  // start from the one-step fit when it is sensible, else from a slow, well-insulated room
  const one = fitModel(samples, stepS, 8);
  const x0 = one && one.a > 0.01 && one.b > 0.001 ? [Math.log(one.a), Math.log(one.b), one.c, one.d] : [Math.log(0.5), Math.log(0.05), 0, 0];
  const x = nelderMead(loss, x0, [0.5, 0.5, 0.3, 0.1]);
  const best = loss(x);
  if (!Number.isFinite(best)) return null;
  return { ...make(x), rmse: Math.sqrt(best) };
}

/** The model run over the samples in [from, to) (epoch s), restarted from the measured temperature every window. */
export function backtest(m: RoomModel, samples: ThermalSample[], from: number, to: number, horizonSteps: number): { points: [number, number, number][]; rmse: number; max: number } | null {
  const points: [number, number, number][] = [];
  let i = samples.findIndex((s) => s.t >= from);
  if (i < 0) return null;
  while (i < samples.length && samples[i]!.t < to) {
    const sim = simulate(m, samples, i, horizonSteps, m.stepS);
    if (!sim.length) {
      i++;
      continue;
    }
    if (!points.length) points.push([samples[i]!.t, samples[i]!.tin, samples[i]!.tin]);
    sim.forEach((v, k) => {
      const q = samples[i + 1 + k]!;
      if (q.t < to) points.push([q.t, q.tin, v]);
    });
    i += sim.length;
  }
  if (points.length < 8) return null;
  const miss = points.map(([, meas, mod]) => mod - meas);
  return { points, rmse: Math.sqrt(miss.reduce((s, v) => s + v * v, 0) / miss.length), max: Math.max(...miss.map(Math.abs)) };
}

/**
 * A model the planner can trust: heaters warm, the room loses heat, a time constant between 2 h and 2 weeks, and run
 * over the recent days from measured starts (`backtest`) it stays within `maxError` °C of the measured temperature
 * (root mean square) and never misses by more than three times that (quiet days at a steady temperature would
 * otherwise hide a miss on the few nights the room cools). Without a check, the fit's own error counts.
 */
export function usable(m: RoomModel | null, check: { rmse: number; max: number } | null = null, maxError = 0.5): m is RoomModel {
  const ok = check ? check.rmse <= maxError && check.max <= 3 * maxError : !!m && m.rmse <= maxError;
  return !!m && ok && m.a > 0.01 && m.b > 1 / 336 && m.b < 0.5 && Number.isFinite(m.c) && Number.isFinite(m.d);
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

/**
 * A heater with its own thermostat and clock that the engine cannot read (devices.tsv kind heater): its power is
 * known only at the extremes. Well below its setpoint it heats at full power, well above it is off; in between it
 * holds the room and its mean power is what the room loses. From the room's temperature (another sensor in the
 * room), the setpoint by its clock and the outdoor temperature:
 *
 *   off  (tin > setpoint + OFF_BAND):  dT/dt = -b (T - Tout) + d          -> b, d by least squares
 *   on   (tin < setpoint - ON_BAND):   dT/dt = a P - b (T - Tout) + d     -> a, the median over the hours
 *   hold (in between):                 P = (b (T - Tout) - d) / a, within 0..P
 *
 * Sun is left out. A rough estimate, for the cost of a heater that cannot be measured.
 */
export interface LocalHeaterModel {
  a: number;
  b: number;
  d: number;
  /** hours of the fit: off, on */
  nOff: number;
  nOn: number;
}

export interface LocalSample {
  /** epoch seconds, start of the step */
  t: number;
  tin: number;
  tout: number;
  setpoint: number;
}

export const ON_BAND = 0.7;
export const OFF_BAND = 0.5;

export type LocalPhase = 'on' | 'off' | 'hold';
export function localPhase(tin: number, setpoint: number): LocalPhase {
  return tin < setpoint - ON_BAND ? 'on' : tin > setpoint + OFF_BAND ? 'off' : 'hold';
}

/** Fits on hour-long stretches of `stepS` samples in one phase (the sensors' tenths make shorter ones noise). */
export function fitLocalHeater(samples: LocalSample[], kw: number, stepS: number, minOff = 6, minOn = 2): LocalHeaterModel | null {
  const k = Math.max(1, Math.round(3600 / stepS));
  const off: { x: number; y: number }[] = [];
  const on: { x: number; y: number }[] = [];
  for (let i = 0; i + k < samples.length; i += k) {
    const run = samples.slice(i, i + k + 1);
    if (run.some((s, j) => j > 0 && s.t - run[j - 1]!.t !== stepS)) continue;
    const phases = new Set(run.slice(0, k).map((s) => localPhase(s.tin, s.setpoint)));
    if (phases.size !== 1 || phases.has('hold')) continue;
    const first = run[0]!;
    const last = run[k]!;
    const y = ((last.tin - first.tin) * 3600) / (last.t - first.t);
    const x = run.slice(0, k).reduce((n, s) => n + (s.tin - s.tout), 0) / k;
    (phases.has('on') ? on : off).push({ x, y });
  }
  if (off.length < minOff || on.length < minOn) return null;
  const fit = leastSquares(off.map((p) => [-p.x, 1]), off.map((p) => p.y));
  if (!fit) return null;
  const [b, d] = fit as [number, number];
  if (!(b > 0)) return null;
  const as = on.map((p) => (p.y + b * p.x - d) / kw).sort((p, q) => p - q);
  const a = as[Math.floor(as.length / 2)]!;
  if (!(a > 0)) return null;
  return { a, b, d, nOff: off.length, nOn: on.length };
}

/** The share of time the heater heats now, percent; null in the hold band without a model. */
export function localDemand(m: LocalHeaterModel | null, tin: number, tout: number, setpoint: number, kw: number): number | null {
  const phase = localPhase(tin, setpoint);
  if (phase === 'on') return 100;
  if (phase === 'off') return 0;
  if (!m) return null;
  const p = (m.b * (tin - tout) - m.d) / m.a;
  return Math.round(Math.min(Math.max(p / kw, 0), 1) * 100);
}
