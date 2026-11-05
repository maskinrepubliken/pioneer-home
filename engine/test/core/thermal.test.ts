import { describe, expect, it } from 'vitest';
import { buildSamples, fitModel, holdingPower, iconOctas, meanOver, solarElevation, step, sunFactor, usable, type RoomModel, type ThermalSample } from '../../src/core/thermal.js';
import { comfortBand, followSetpoints, planRoom, type PlanInput } from '../../src/core/planner.js';

const LAT = 57.6;
const LON = 13.15;
const model: RoomModel = { a: 0.33, b: 0.021, c: 0.6, d: 0.04, n: 0, r2: 1, stepS: 3600, from: 0, to: 0 };

describe('thermal model', () => {
  it('solar elevation: about 17° at noon in early November at 57.6° N, below the horizon at night', () => {
    expect(solarElevation(Date.parse('2026-11-04T10:40:00Z'), LAT, LON)).toBeCloseTo(17.4, 0);
    expect(solarElevation(Date.parse('2026-11-04T22:00:00Z'), LAT, LON)).toBeLessThan(-40);
    expect(solarElevation(Date.parse('2026-06-21T11:00:00Z'), LAT, LON)).toBeCloseTo(55.8, 0);
  });

  it('sun factor: full at the zenith in a clear sky, a quarter left when overcast, none at night', () => {
    expect(sunFactor(90, 0)).toBeCloseTo(1);
    expect(sunFactor(90, 8)).toBeCloseTo(0.25);
    expect(sunFactor(-5, 0)).toBe(0);
    expect(iconOctas('04d')).toBe(7);
    expect(iconOctas('10n')).toBe(8);
    expect(iconOctas(null)).toBeNull();
  });

  it('meanOver: time-weighted, each value held until the next or at most holdS', () => {
    const pts: [number, number][] = [
      [0, 10],
      [30, 20],
    ];
    expect(meanOver(pts, 0, 60, 3600)).toBe(15);
    expect(meanOver(pts, 30, 90, 3600)).toBe(20);
    // the last value is held only 30 s: 30 of 60 s covered, below 60 %
    expect(meanOver(pts, 30, 90, 30)).toBeNull();
  });

  it('fits back the coefficients of data made by the model', () => {
    const samples: ThermalSample[] = [];
    let tin = 17;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 600; k++) {
      const tout = 5 + 6 * Math.sin(k / 12) + rnd() * 2;
      const power = rnd() < 0.5 ? 0 : rnd() * 1.7;
      const sun = Math.max(0, Math.sin((k % 24) / 24 * 2 * Math.PI - Math.PI / 2)) * rnd();
      samples.push({ t: k * 3600, tin, tout, power, sun });
      // one hour of constant conditions, forward with the linearised step used by the fit
      tin += model.a * power - model.b * (tin - tout) + model.c * sun + model.d;
    }
    const fit = fitModel(samples, 3600)!;
    expect(fit.a).toBeCloseTo(model.a, 3);
    expect(fit.b).toBeCloseTo(model.b, 3);
    expect(fit.c).toBeCloseTo(model.c, 3);
    expect(fit.d).toBeCloseTo(model.d, 3);
    expect(fit.r2).toBeGreaterThan(0.99);
    expect(usable(fit)).toBe(true);
    expect(usable({ ...fit, r2: 0.1 })).toBe(false);
  });

  it('builds samples only where every input is known', () => {
    const hour = 3600;
    // hourly points, as the history rows come (on change and as heartbeats)
    const flat = (v: number): [number, number][] => [0, 1, 2, 3].map((h) => [h * hour, v]);
    const samples = buildSamples({
      temperatures: [flat(18), flat(17)],
      heaters: [{ demand: [[0, 50], [hour, 50], [2 * hour, 0]], kw: 1 }],
      outdoor: flat(4),
      clouds: flat(8),
      latitude: LAT,
      longitude: LON,
      from: 0,
      to: 4 * hour,
      stepS: hour,
    });
    // the demand is held at most an hour from its last row, so the hour from 3 h has no known power
    expect(samples.map((s) => s.power)).toEqual([0.5, 0.5, 0]);
    expect(samples[0]!.tin).toBe(17.5);
  });

  it('heating curve and step', () => {
    // b (18 - 5) - d = 0.233 °C/h lost, a = 0.33 per kW -> about 0.71 kW
    expect(holdingPower(model, 18, 5)).toBeCloseTo(0.706, 2);
    expect(holdingPower(model, 18, 20)).toBe(0);
    const held = step(model, 18, 5, holdingPower(model, 18, 5), 0, 10);
    expect(held).toBeCloseTo(18, 6);
  });
});

describe('planner', () => {
  const quarter = 0.25;
  const opts = { stepH: quarter, maxKw: 1.7, shortfallCost: 1 };
  // 24 h from midnight: cheap night (0.5 kr), dear day (3 kr); comfort 18 from 06 to 22, 12 otherwise
  const day = (cheapUntil = 6): PlanInput[] => {
    const comfort = Array.from({ length: 96 }, (_, k) => (k / 4 >= 6 && k / 4 < 22 ? 18 : 12));
    const band = comfortBand(comfort, { slack: 1, preheat: 1.5, lookaheadSteps: 32, cold: 12 });
    return comfort.map((c, k) => ({ t: k * 900_000, tout: 2, sun: 0, price: k / 4 < cheapUntil ? 0.5 : 3, comfort: c, ...band[k]! }));
  };

  it('warms up during the cheap hours before a dear comfort period, and never drops below the floor', () => {
    // from 17 °C: full power gains about 0.3 °C/h, so the night is enough to get above the comfort by 06
    const plan = planRoom(model, 17, day(), opts);
    const nightEnergy = plan.steps.filter((s) => s.t < 6 * 3_600_000).reduce((n, s) => n + s.power, 0);
    expect(nightEnergy).toBeGreaterThan(0);
    // within the 0.1 °C grid; the thermostats are told the floor besides
    for (const s of plan.steps) expect(s.tend).toBeGreaterThanOrEqual(s.floor - 0.1);
    // preheated above the comfort when the dear period starts, within the ceiling
    const at6 = plan.steps.find((s) => s.t === 6 * 3_600_000)!;
    expect(at6.tin).toBeGreaterThan(17.5);
    expect(Math.max(...plan.steps.map((s) => s.tend))).toBeLessThanOrEqual(19.55);
  });

  it('costs less than holding the schedule exactly', () => {
    const input = day();
    const plan = planRoom(model, 18, input, opts);
    const schedule = followSetpoints(model, 18, input.map((s) => ({ ...s, setpoint: s.comfort })), opts);
    expect(plan.cost).toBeLessThan(schedule.cost);
  });

  it('does not heat a warm room whose comfort is low, and tells the thermostats the floor', () => {
    const input = day().slice(0, 8); // 00-02: comfort 12
    const plan = planRoom(model, 18, input, opts);
    expect(plan.energy).toBe(0);
    expect(plan.steps[0]!.setpoint).toBe(12);
  });

  it('a heating step asks for the temperature it plans to reach, rounded up to half a degree', () => {
    const plan = planRoom(model, 15, day(), opts);
    const heating = plan.steps.find((s) => s.power > 0)!;
    expect(heating.setpoint).toBeGreaterThanOrEqual(heating.tend);
    expect(heating.setpoint * 2).toBe(Math.round(heating.setpoint * 2));
  });
});
