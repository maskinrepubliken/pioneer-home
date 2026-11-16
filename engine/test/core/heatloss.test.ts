import { describe, expect, it } from 'vitest';
import { coolingHours, fitCooling, fitHeatLoss, nightOf, steadyWindows, type Night, type ZoneSample } from '../../src/core/heatloss.js';

const night = (day: number, dT: number, ua: number, q: number, extra = false, change = 0): Night => ({
  t: Date.UTC(2026, 9, day, 1) / 1000,
  date: `2026-10-${String(day).padStart(2, '0')}`,
  kw: (ua * dT - q) / 1000,
  dT,
  tin: 18,
  tout: 18 - dT,
  change,
  extra,
});

describe('heat loss', () => {
  it('finds UA per era and the free heat shared by them', () => {
    const nights = [
      ...[6, 10, 14, 8, 12].map((dT, i) => night(i + 1, dT, 75, 200)),
      ...[7, 11, 15, 9].map((dT, i) => night(i + 10, dT, 50, 200)),
    ];
    const eras = [
      { from: 0, at: '2026-10-01', title: '' },
      { from: Date.UTC(2026, 9, 9) , at: '2026-10-09', title: 'Fönstren isolerade' },
    ];
    const r = fitHeatLoss(nights, eras, 0.3);
    expect(r.freeHeat).toBe(200);
    expect(r.eras.map((e) => e.ua)).toEqual([75, 50]);
    expect(r.eras[1]!.perNight.map((n) => n.ua)).toEqual([50, 50, 50, 50]);
    expect(r.counted).toBe(9);
  });

  it('leaves out nights with extra heat, a zone cooling or warming, and mild ones', () => {
    const nights = [6, 10, 14, 8, 12].map((dT, i) => night(i + 1, dT, 75, 200));
    nights.push(night(20, 9, 75, 900, true), night(21, 9, 75, 900, false, -0.8), night(22, 2, 75, 0));
    const r = fitHeatLoss(nights, [{ from: 0, at: '', title: '' }], 0.3);
    expect(r).toMatchObject({ measured: 8, counted: 5, extra: 1, unsteady: 1, freeHeat: 200 });
    expect(r.eras[0]!.ua).toBe(75);
  });

  it('says nothing until there are enough nights', () => {
    const r = fitHeatLoss([night(1, 10, 75, 200), night(2, 12, 75, 200)], [{ from: 0, at: '', title: '' }], 0.3);
    expect(r.freeHeat).toBeNull();
    expect(r.eras[0]).toMatchObject({ nights: 2, ua: null });
  });

  it('measures a night window from zone samples', () => {
    const from = Date.UTC(2026, 10, 7, 1) / 1000;
    const s: ZoneSample[] = [];
    for (let t = from - 9 * 3600; t < from + 4 * 3600; t += 900) s.push({ t, tin: 12, tout: 0, power: t >= from && t < from + 3 * 3600 ? 0.8 : 0.5, extra: t === from - 7 * 3600 });
    const n = nightOf(s, from, from + 3 * 3600, '2026-11-07', 900, 8 * 3600)!;
    expect(n).toMatchObject({ kw: 0.8, dT: 12, change: 0, extra: true });
    expect(nightOf(s, from, from + 3 * 3600, '2026-11-07', 900, 6 * 3600)!.extra).toBe(false);
    expect(nightOf(s.slice(0, 40), from, from + 3 * 3600, 'x', 900, 0)).toBeNull();
  });

  it('takes the steady three-hour windows in the dark, one after the other', () => {
    const day = Date.UTC(2026, 10, 7, 0) / 1000;
    const s: ZoneSample[] = [];
    for (let t = day - 9 * 3600; t < day + 30 * 3600; t += 900) {
      const h = (t - day) / 3600;
      // dark before 07 and after 16; the zone is warmed from 12 to 15 between 16 and 18 and cools back by 21
      const tin = h >= 16 && h < 18 ? 12 + 1.5 * (h - 16) : h >= 18 && h < 21 ? 12 + (21 - h) : 12;
      s.push({ t, tin, tout: 0, power: 0.8, sun: h >= 7 && h < 16 ? 0.4 : 0 });
    }
    const w = steadyWindows(s, day, day + 86400, 900, 8 * 3600, 3 * 3600, 0.3, (t) => String((t - day) / 3600));
    expect(w.map((n) => n.date)).toEqual(['0', '3', '22']);
  });

  it('learns the heat capacity where both measures exist and gives every era its value from cooling', () => {
    // C = 1.5 kWh/K, Q = 0.2 kW: −dT/dt = (UA·ΔT − Q)/C, UA 75 W/K before the event and 50 after
    const at = (day: number, h: number) => Date.UTC(2026, 9, day, h) / 1000;
    const hour = (t: number, ua: number, dT: number) => ({ t, dT, rate: -((ua / 1000) * dT - 0.2) / 1.5 });
    const hours = [...[8, 10, 12, 14, 9, 11].map((dT, i) => hour(at(1 + i, 20), 75, dT)), ...[8, 10, 12, 14, 9, 11].map((dT, i) => hour(at(20 + i, 20), 50, dT))];
    const eras = [
      { from: 0, at: '', title: '' },
      { from: Date.UTC(2026, 9, 15), at: '2026-10-15', title: 'Fönstren isolerade' },
    ];
    const r = fitCooling(hours, eras, [75, null], 200);
    expect(r.capacity).toBe(1.5);
    expect(r.eras.map((e) => e.ua)).toEqual([75, 50]);
  });

  it('finds the cooling hours: dark, heaters at rest an hour before as well, no room warming by itself', () => {
    const day = Date.UTC(2026, 10, 7, 0) / 1000;
    const s: ZoneSample[] = [];
    for (let t = day; t < day + 8 * 3600; t += 900) {
      const h = (t - day) / 3600;
      s.push({ t, tin: 18 - 0.4 * h, tout: 0, power: h < 2 ? 1.5 : 0, sun: 0, warming: h >= 6 && h < 6.25 });
    }
    const hrs = coolingHours(s, day, day + 8 * 3600, 900, 2 * 3600, 2.4);
    expect(hrs.map((x) => (x.t - day) / 3600)).toEqual([3, 4, 5]);
    expect(hrs[0]).toMatchObject({ rate: -0.4 });
  });
});
