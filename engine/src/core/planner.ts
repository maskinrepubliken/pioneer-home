/**
 * The program planner: the cheapest heating for one room over the coming hours, given its thermal model
 * (core/thermal.ts), the forecast, the electricity price and the comfort the schedule asks for. Pure functions.
 *
 * Dynamic programming over the room temperature (a 0.1 °C grid), one step per quarter: each step chooses a heating
 * power (a share of the room's heaters) and pays energy x price. Comfort is a band per step:
 *   comfort  the temperature the schedule wants; every °C·h below it costs `shortfallCost`
 *   floor    never below (comfort less the allowed shortfall, or the cold temperature itself)
 *   ceiling  heating never drives the room above it (comfort plus the allowed preheating)
 * Heat still missing at the horizon is priced at what it costs to make up at the mean price, so the plan does not
 * drain the room at the end. The setpoint sent to the thermostats is the planned temperature at the end of a step
 * while heating, else the floor: the thermostats regulate to it, and the plan is redone every quarter from the
 * temperature actually measured (model predictive control), which corrects the model's errors.
 */
import { step, type RoomModel } from './thermal.js';

export interface PlanInput {
  /** start of the step, epoch ms */
  t: number;
  tout: number;
  sun: number;
  /** kr per kWh paid (spot x VAT + surcharge) */
  price: number;
  comfort: number;
  floor: number;
  ceiling: number;
}

export interface PlannedStep extends PlanInput {
  /** kW */
  power: number;
  /** room temperature at the start and the end of the step */
  tin: number;
  tend: number;
  /** what the thermostats are told during the step */
  setpoint: number;
  /** kr for the energy */
  cost: number;
}

export interface Plan {
  steps: PlannedStep[];
  /** kr, kWh, °C·h below comfort */
  cost: number;
  energy: number;
  shortfall: number;
}

export interface PlanOptions {
  /** hours per step */
  stepH: number;
  /** the room's heaters together, kW */
  maxKw: number;
  /** kr per °C·h below comfort */
  shortfallCost: number;
  /** shares of maxKw to choose from */
  levels?: number[];
  /** °C between grid points */
  grid?: number;
}

/**
 * The comfort band of each step: the floor is the comfort less `slack` (a cold comfort, at or below `cold`, has no
 * slack: it protects the house), the ceiling the highest comfort within the next `lookaheadSteps` plus `preheat`,
 * so the room may be warmed ahead of a warmer period but never far above what is coming.
 */
export function comfortBand(comfort: number[], opts: { slack: number; preheat: number; lookaheadSteps: number; cold: number }): { floor: number; ceiling: number }[] {
  return comfort.map((c, k) => {
    const ahead = comfort.slice(k, k + opts.lookaheadSteps + 1);
    return { floor: c > opts.cold ? c - opts.slack : c, ceiling: Math.max(...ahead) + opts.preheat };
  });
}

const HALF = (x: number, up: boolean) => (up ? Math.ceil(x * 2 - 1e-9) : Math.floor(x * 2 + 1e-9)) / 2;

/** A plan's totals from its steps. */
function totals(steps: PlannedStep[], stepH: number): Plan {
  return {
    steps,
    cost: steps.reduce((s, x) => s + x.cost, 0),
    energy: steps.reduce((s, x) => s + x.power * stepH, 0),
    shortfall: steps.reduce((s, x) => s + Math.max(0, x.comfort - x.tend) * stepH, 0),
  };
}

export function planRoom(m: RoomModel, t0: number, input: PlanInput[], opts: PlanOptions): Plan {
  const levels = opts.levels ?? [0, 0.25, 0.5, 0.75, 1];
  const g = opts.grid ?? 0.1;
  const dt = opts.stepH;
  const K = input.length;
  if (!K) return { steps: [], cost: 0, energy: 0, shortfall: 0 };
  const lo = Math.min(t0, ...input.map((s) => s.floor)) - 3;
  const hi = Math.max(t0, ...input.map((s) => s.ceiling)) + 2;
  const N = Math.round((hi - lo) / g) + 1;
  const temp = (i: number) => lo + i * g;
  const meanPrice = input.reduce((s, x) => s + x.price, 0) / K;
  // heat missing at the end, at what a degree costs to make up (1/a kWh per °C) at the mean price
  const last = input[K - 1]!;
  const value = (v: Float64Array, t: number) => {
    const x = (t - lo) / g;
    if (x <= 0) return v[0]! + (lo - t) * 1000; // off the grid: steeply worse
    if (x >= N - 1) return v[N - 1]!;
    const i = Math.floor(x);
    const f = x - i;
    return v[i]! * (1 - f) + v[i + 1]! * f;
  };
  // the cost of one step from temperature t with level l, plus what comes after (Infinity when not allowed)
  const stepCost = (k: number, t: number, l: number, after: Float64Array) => {
    const s = input[k]!;
    const p = l * opts.maxKw;
    const te = step(m, t, s.tout, p, s.sun, dt);
    if (l > 0 && te > s.ceiling + 0.05) return { te, c: Infinity };
    let c = p * dt * s.price + Math.max(0, s.comfort - te) * dt * opts.shortfallCost;
    if (te < s.floor) c += (s.floor - te) * dt * 1000; // below the floor: only when even full power cannot help
    return { te, c: c + value(after, te) };
  };
  // backward: values[k][i] = the cheapest cost from step k on, starting at grid temperature i
  const values: Float64Array[] = new Array(K + 1);
  values[K] = Float64Array.from({ length: N }, (_, i) => (Math.max(0, last.comfort - temp(i)) / m.a) * meanPrice);
  for (let k = K - 1; k >= 0; k--) {
    const after = values[k + 1]!;
    const cur = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      let best = Infinity;
      for (const l of levels) best = Math.min(best, stepCost(k, temp(i), l, after).c);
      cur[i] = best === Infinity ? stepCost(k, temp(i), 0, after).c : best; // only "no heat" is left
    }
    values[k] = cur;
  }
  // forward: follow the best choice from the measured temperature, chosen exactly (not from the grid)
  const steps: PlannedStep[] = [];
  let t = t0;
  for (let k = 0; k < K; k++) {
    const s = input[k]!;
    let best = Infinity;
    let bl = 0;
    for (const l of levels) {
      const { c } = stepCost(k, t, l, values[k + 1]!);
      if (c < best) {
        best = c;
        bl = l;
      }
    }
    const power = bl * opts.maxKw;
    const te = step(m, t, s.tout, power, s.sun, dt);
    const setpoint = power > 0 ? Math.max(HALF(te, true), HALF(s.floor, true)) : HALF(s.floor, true);
    steps.push({ ...s, power, tin: t, tend: te, setpoint, cost: power * dt * s.price });
    t = te;
  }
  return totals(steps, dt);
}

/**
 * What following the schedule costs: an ideal thermostat that reaches each step's `setpoint` by its end, within the
 * heaters' power. The comparison for the program's plan.
 */
export function followSetpoints(m: RoomModel, t0: number, input: (PlanInput & { setpoint: number })[], opts: PlanOptions): Plan {
  const dt = opts.stepH;
  const e = Math.exp(-m.b * dt);
  const steps: PlannedStep[] = [];
  let t = t0;
  for (const s of input) {
    // the power whose steady state brings t to the setpoint in one step
    const tInf = (s.setpoint - t * e) / (1 - e);
    const want = (m.b * tInf - m.b * s.tout - m.c * s.sun - m.d) / m.a;
    const power = Math.min(Math.max(want, 0), opts.maxKw);
    const te = step(m, t, s.tout, power, s.sun, dt);
    steps.push({ ...s, power, tin: t, tend: te, cost: power * dt * s.price });
    t = te;
  }
  return totals(steps, dt);
}
