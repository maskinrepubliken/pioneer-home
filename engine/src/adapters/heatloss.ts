/**
 * The house's heat loss per era between the events in events.tsv (core/heatloss.ts), kept up to date by itself:
 * every hour it measures the nights not measured yet (heating, climate and weather history of each night's window,
 * at most HISTORY_DAYS back), and fits again with the events as they are now. Served as GET /api/heatloss and shown
 * on Kostnader. Nights are kept in STATE_DIR/heatloss.json, so history is read once per night.
 *
 * Tuning in cells.tsv, all optional: `heatloss_from` and `heatloss_to` (timeofday, the night window, default 02:00 and
 * 05:00), `heatloss_steady` (°C the zone may warm or cool over the window and still count, default 0.3). Extra heat
 * is found as the program finds it: the room's `<room>_extra_heat_sensor` more than `program_extra_heat_margin` °C
 * (default 2) above the room's thermostats while they heat at under a fifth of their power.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Logger } from 'pino';
import type { Engine } from '../core/engine.js';
import { fitHeatLoss, nightOf, type Era, type HeatLossResult, type Night, type ZoneSample } from '../core/heatloss.js';
import { buildSamples, meanOver, type Points } from '../core/thermal.js';
import { localParts, wallClockToEpoch } from '../formula/time.js';
import { TimeOfDay } from '../formula/values.js';
import type { HistoryQuery } from './pocketbase.js';
import { extraHeatSensor, heatedRooms } from './program.js';

const HISTORY_DAYS = 180;
const STEP_S = 900;
const LOOKBACK_S = 8 * 3600;
const CHUNK_NIGHTS = 14;
const RUN_EVERY_MS = 3_600_000;

export interface HeatLossState extends HeatLossResult {
  /** epoch ms of the last run */
  at: number;
  /** the night window, HH:MM local */
  window: { from: string; to: string };
  steady: number;
  /** the rooms of the zone (ids) */
  rooms: string[];
  errors: string[];
}

interface Saved {
  key: string;
  /** local date (YYYY-MM-DD) of the last night looked at, measured or not */
  through: string | null;
  nights: Night[];
}

type Row = Record<string, unknown>;

/** Heating rows of a silent device: a run with the very same `current` and `pi` keeps only its last row (as lib/cost.ts). */
function liveRows(rows: Row[]): Row[] {
  const key = (r: Row | undefined) => (r ? `${String(r['current'])}|${String(r['pi'])}` : undefined);
  return rows.filter((r, i) => {
    const own = key(r);
    return i === 0 || i === rows.length - 1 || own !== key(rows[i - 1]) || own !== key(rows[i + 1]);
  });
}

export class HeatLossService {
  private saved: Saved = { key: '', through: null, nights: [] };
  private state: HeatLossState = { at: 0, window: { from: '02:00', to: '05:00' }, steady: 0.3, rooms: [], freeHeat: null, eras: [], measured: 0, counted: 0, extra: 0, unsteady: 0, errors: [] };
  private running = false;

  constructor(
    private engine: Engine,
    private opts: { history: HistoryQuery; stateFile: string },
    private log: Logger,
  ) {
    if (existsSync(opts.stateFile)) {
      try {
        this.saved = JSON.parse(readFileSync(opts.stateFile, 'utf8')) as Saved;
      } catch {
        this.saved = { key: '', through: null, nights: [] };
      }
    }
  }

  get current(): HeatLossState {
    return this.state;
  }

  start(): () => void {
    const tick = () => void this.run().catch((e: unknown) => this.log.warn({ err: (e as Error).message }, 'heat loss run failed'));
    // after the program's first fit, which reads the same history
    const first = setTimeout(tick, 120_000);
    const timer = setInterval(tick, RUN_EVERY_MS);
    first.unref();
    timer.unref();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }

  private cell(id: string): unknown {
    return this.engine.store.has(id) ? this.engine.store.get(id) : null;
  }
  private time(id: string, fallbackMs: number): number {
    const v = this.cell(id);
    return v instanceof TimeOfDay ? v.ms : fallbackMs;
  }
  private num(id: string, fallback: number): number {
    const v = this.cell(id);
    return typeof v === 'number' ? v : fallback;
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const errors: string[] = [];
    try {
      const cfg = this.engine.config;
      const tz = cfg.timezone;
      const rooms = heatedRooms(cfg);
      const fromMs = this.time('heatloss_from', 2 * 3_600_000);
      const toMs = this.time('heatloss_to', 5 * 3_600_000);
      const winS = (((toMs - fromMs) % 86_400_000) + 86_400_000) % 86_400_000 / 1000;
      const steady = this.num('heatloss_steady', 0.3);
      const margin = this.num('program_extra_heat_margin', 2);
      const extra = rooms.map((r) => extraHeatSensor(this.engine, r.id));
      const key = JSON.stringify([rooms, fromMs, toMs, extra, margin]);
      if (key !== this.saved.key) this.saved = { key, through: null, nights: [] };

      // the nights to measure: each local date after the last one looked at whose window ended an hour ago
      const now = Date.now();
      const dates: { date: string; from: number }[] = [];
      const start = this.saved.through ? Date.parse(`${this.saved.through}T12:00:00Z`) + 86_400_000 : now - HISTORY_DAYS * 86_400_000;
      for (let d = start; ; d += 86_400_000) {
        const p = localParts(d, tz);
        const from = wallClockToEpoch(p.year, p.month, p.day, fromMs, tz);
        if (from + winS * 1000 + 3_600_000 > now) break;
        dates.push({ date: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`, from });
      }
      for (let i = 0; i < dates.length && rooms.length; i += CHUNK_NIGHTS) {
        const chunk = dates.slice(i, i + CHUNK_NIGHTS);
        const nights = await this.measure(rooms, extra, margin, chunk, winS);
        this.saved.nights.push(...nights);
        this.saved.through = chunk[chunk.length - 1]!.date;
      }
      if (dates.length) {
        this.saved.nights.sort((a, b) => a.t - b.t);
        writeFileSync(this.opts.stateFile, JSON.stringify(this.saved));
        this.log.info({ nights: dates.length, measured: this.saved.nights.length }, 'heat loss nights measured');
      }

      const first = this.saved.nights[0];
      const events = [...cfg.events].sort((a, b) => a.ms - b.ms);
      const eras: Era[] = [{ from: 0, at: first?.date ?? '', title: '' }, ...events.filter((e) => !first || e.ms > first.t * 1000).map((e) => ({ from: e.ms, at: e.at, title: e.title }))];
      const hhmm = (ms: number) => `${String(Math.floor(ms / 3_600_000)).padStart(2, '0')}:${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0')}`;
      this.state = { at: now, window: { from: hhmm(fromMs), to: hhmm(toMs) }, steady, rooms: rooms.map((r) => r.id), ...fitHeatLoss(this.saved.nights, eras, steady), errors };
      if (!rooms.length) this.state.errors.push('inga uppvärmda rum (ett rum behöver en <rum>_target-cell och termostater med watts och historik)');
    } catch (e) {
      errors.push((e as Error).message);
      this.state = { ...this.state, at: Date.now(), errors };
      throw e;
    } finally {
      this.running = false;
    }
  }

  /** The nights of one chunk of dates, from one read of history. */
  private async measure(rooms: ReturnType<typeof heatedRooms>, extra: (string | null)[], margin: number, chunk: { date: string; from: number }[], winS: number): Promise<Night[]> {
    const since = chunk[0]!.from - LOOKBACK_S * 1000 - 3_600_000;
    const until = chunk[chunk.length - 1]!.from + winS * 1000 + 2 * 3_600_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    const [heating, weather, climate] = await Promise.all([
      this.opts.history.query('heating', iso(since), iso(until)),
      this.opts.history.query('weather', iso(since), iso(until)),
      extra.some(Boolean) ? this.opts.history.query('climate', iso(since), iso(until)) : Promise.resolve([] as Row[]),
    ]);
    const ts = (r: Row) => (typeof r['when'] === 'string' ? Date.parse(r['when'].replace(' ', 'T')) / 1000 : NaN);
    const series = (rows: Row[], field: string): Points =>
      rows
        .map((r) => [ts(r), r[field]] as [number, unknown])
        .filter((p): p is [number, number] => Number.isFinite(p[0]) && typeof p[1] === 'number' && Number.isFinite(p[1]))
        .sort((a, b) => a[0] - b[0]);
    const outdoor = series(weather, 'temperature');
    // clouds only matter for the sun, and the window is at night: clear, every hour
    const clouds: Points = [];
    for (let t = since / 1000; t <= until / 1000; t += 3600) clouds.push([t, 0]);
    const bySensor = (sensor: string) => liveRows(heating.filter((r) => r['sensor'] === sensor).sort((a, b) => ts(a) - ts(b)));
    const cfg = this.engine.config;
    // each room's quarters
    const perRoom = rooms.map((room, k) => {
      const samples = buildSamples({
        temperatures: room.heaters.map((h) => series(bySensor(h.sensor), 'current')),
        heaters: room.heaters.map((h) => ({ demand: series(bySensor(h.sensor), 'pi'), kw: h.kw })),
        outdoor,
        clouds,
        latitude: cfg.latitude,
        longitude: cfg.longitude,
        from: since / 1000,
        to: until / 1000,
        stepS: STEP_S,
      });
      const ref = extra[k];
      const refTemps = ref ? series(climate.filter((r) => r['sensor'] === ref), 'temperature') : [];
      const maxKw = room.heaters.reduce((n, h) => n + h.kw, 0);
      return new Map(
        samples.map((s) => {
          const y = ref ? meanOver(refTemps, s.t, s.t + STEP_S, 2 * 3600) : null;
          return [s.t, { ...s, extra: y !== null && y - s.tin > margin && s.power < 0.2 * maxKw }];
        }),
      );
    });
    // the zone: quarters every room knows
    const zone: ZoneSample[] = [];
    for (const [t, s0] of perRoom[0] ?? new Map()) {
      const all = perRoom.map((m) => m.get(t));
      if (all.some((s) => !s)) continue;
      const xs = all as NonNullable<(typeof all)[number]>[];
      zone.push({ t, tin: xs.reduce((a, s) => a + s.tin, 0) / xs.length, tout: s0.tout, power: xs.reduce((a, s) => a + s.power, 0), extra: xs.some((s) => s.extra) });
    }
    zone.sort((a, b) => a.t - b.t);
    return chunk.map((c) => nightOf(zone, c.from / 1000, c.from / 1000 + winS, c.date, STEP_S, LOOKBACK_S)).filter((n): n is Night => n !== null);
  }
}
