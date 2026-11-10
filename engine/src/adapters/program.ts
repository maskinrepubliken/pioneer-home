/**
 * The program: learns each heated room's thermal model from history and plans its heating for the coming hours at
 * the lowest cost (core/thermal.ts, core/planner.ts). Feeds the system cells `program.<room>` (the setpoint for now)
 * and GET /api/program (models, heating curves, the plan and the thermostats' setpoints ahead).
 *
 * A room takes part when it has a `<room>_target` cell and thermostats with rated watts (devices.tsv). Its comfort
 * for each quarter comes from the modes in force: the week schedule (week.tsv) in heat_mode program, else the
 * mode chosen (until `heat_until` when it is set, the week schedule after); the warmest of the modes' `<room>_<mode>` temperatures, less `heat_overlap_slack` in a transition
 * (two modes at once), never below `heat_cold`. Tuning lives in cells.tsv: `program_slack` (°C the room may be short, default 1),
 * `program_preheat` (°C above the coming comfort it may be warmed, default 1.5) and `program_shortfall_cost`
 * (kr per °C·h short, default 0.5); `heat_cold` is a comfort that is never undercut.
 *
 * The plan reaches 36 hours ahead; quarters beyond the published prices are priced as the same quarter a day
 * earlier (an estimate; `pricesUntil` says where it starts). Models are refitted every hour on the last 28 days
 * (heating, weather; core/thermal.ts fitTrajectory, quarter-hour steps, 8-hour windows), a day `program_learn_halflife`
 * days old weighing half (default 7), and nothing before the date in `program_learn_since` (a held string
 * `YYYY-MM-DD`, empty = the whole 28 days; set when the house has changed, e.g. a renovation step). Each model is then
 * run over the last 7 days from measured starts (`backtest`); when it misses by more than `program_max_error` °C
 * (root mean square, default 0.5; or by more than three times that at worst) it is not steered by: the room's target is its comfort, no preheating, until the
 * model has learnt. Kept in STATE_DIR/program.json. The plan is redone every quarter from the temperature measured
 * now, so its own errors are corrected as it goes. The check counts only the misses where the model thinks the room
 * warmer than it is (a plan from it would heat too little or too late); a model that thinks the room slower to warm
 * than it is only starts early. Extra heat the model cannot know (a wood stove) is left out of the fit and the check:
 * quarters when the room's `<room>_extra_heat_sensor` (a device id, e.g. a sensor near the stove) reads more than
 * `program_extra_heat_margin` °C (default 2) above the room's thermostats while they heat at under a fifth of their power.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Logger } from 'pino';
import type { Engine } from '../core/engine.js';
import { comfortBand, planRoom, type Plan, type PlanInput } from '../core/planner.js';
import { backtest, buildSamples, fitLocalHeater, fitTrajectory, holdingPower, iconOctas, localDemand, meanOver, solarElevation, sunFactor, usable, type LocalHeaterModel, type LocalSample, type Points, type RoomModel } from '../core/thermal.js';
import { Timestamp, type Value } from '../formula/values.js';
import { scheduleAt } from '../core/schedule.js';
import { forecastAt, type ForecastService } from './forecast.js';
import type { HistoryQuery } from './pocketbase.js';
import type { PriceService } from './prices.js';

const QUARTER_MS = 900_000;
const STEP_H = 0.25;
const HORIZON_MS = 36 * 3_600_000;
const FIT_DAYS = 28;
const FIT_EVERY_MS = 3_600_000;
const FIT_STEP_S = 900;
/** the trajectory windows: 8 hours, about as far ahead as the planner preheats */
const FIT_HORIZON_STEPS = 32;
/** fewest days to learn from after program_learn_since */
const MIN_LEARN_DAYS = 2;
const CHECK_DAYS = 7;
const CHECK_SHOWN_H = 48;

/** How well a model held over the last days: run from measured starts, compared with the measured temperature. */
export interface ModelCheck {
  /** root mean square and largest miss over the last CHECK_DAYS, °C */
  rmse: number;
  max: number;
  /** the same over the misses where the model thinks the room warmer than it is: what the trust is decided on */
  overRmse: number;
  overMax: number;
  /** quarters of the fit left out as extra heat (a wood stove, see <room>_extra_heat_sensor) */
  extra: number;
  /** the last CHECK_SHOWN_H hours: epoch ms, measured °C, model °C */
  points: [number, number, number][];
}

interface Saved {
  model: RoomModel | null;
  observed: { tout: number; kw: number }[];
  check: ModelCheck | null;
}

interface Heater {
  id: string;
  kw: number;
  /** the `sensor` constant of its heating history record */
  sensor: string;
}

export interface ProgramRoom {
  id: string;
  name: string;
  heaters: { id: string; kw: number }[];
  model: RoomModel | null;
  usable: boolean;
  /** kW to hold 18 °C (or the room's comfort) at outdoor -15..15 °C without sun: the heating curve */
  curve: { tout: number; kw: number }[];
  /** hourly history the model was fitted on: outdoor °C, mean kW (thinned) */
  observed: { tout: number; kw: number }[];
  /** the temperature the curve is drawn for */
  curveTemp: number;
  /** the model run over the last days against the measured temperature */
  check: ModelCheck | null;
  plan: Plan | null;
  /** what the room's thermostats are set to, quarter by quarter: the plan's setpoints, or the comfort without a plan */
  setpoints: { t: number; setpoint: number }[];
  /** the setpoint fed to program.<room> now */
  setpoint: number | null;
  note: string | null;
}

/** A heater with its own clock (kind heater, source estimate): what it is estimated to do now, and its model. */
export interface LocalHeaterState {
  id: string;
  name: string;
  room: string;
  kw: number;
  model: LocalHeaterModel | null;
  /** the room temperature (its other sensors), the setpoint by its clock, the estimated share of time it heats */
  temperature: number | null;
  setpoint: number | null;
  demand: number | null;
  note: string | null;
}

export interface ProgramState {
  at: number;
  fittedAt: number | null;
  /** what the models learn from: the first day (epoch ms), the half-life in days, the date set in program_learn_since */
  learn: { from: number; halfLifeDays: number; since: string | null; maxError: number };
  forecast: { created: number; fetched: number } | null;
  /** end of the known prices (epoch ms) */
  pricesUntil: number | null;
  /** every quarter ahead, planned or not: epoch ms, outdoor °C (forecast), kr/kWh paid */
  ahead: { t: number; tout: number; price: number }[];
  rooms: ProgramRoom[];
  local: LocalHeaterState[];
  errors: string[];
}

export class ProgramService {
  private models = new Map<string, Saved>();
  private localModels = new Map<string, LocalHeaterModel | null>();
  private fittedAt: number | null = null;
  /** what the models were fitted with (learnKey): a change refits at once */
  private fittedWith = '';
  private learnFrom = 0;
  private state: ProgramState = { at: 0, fittedAt: null, learn: { from: 0, halfLifeDays: 7, since: null, maxError: 0.5 }, forecast: null, pricesUntil: null, ahead: [], rooms: [], local: [], errors: [] };
  private running = false;

  constructor(
    private engine: Engine,
    private opts: { history: HistoryQuery; prices?: PriceService; forecast?: ForecastService; stateFile: string },
    private log: Logger,
  ) {
    if (existsSync(opts.stateFile)) {
      try {
        const saved = JSON.parse(readFileSync(opts.stateFile, 'utf8')) as { fittedAt: number; fittedWith?: string; learnFrom?: number; models: Record<string, Saved>; local?: Record<string, LocalHeaterModel | null> };
        // models saved before the trajectory fit or the one-sided check lack what is decided on: fit again
        if (Object.values(saved.models).every((v) => 'check' in v && (!v.check || 'overRmse' in v.check) && (!v.model || 'rmse' in v.model))) {
          this.fittedAt = saved.fittedAt;
          this.fittedWith = saved.fittedWith ?? '';
          this.learnFrom = saved.learnFrom ?? 0;
          for (const [k, v] of Object.entries(saved.models)) this.models.set(k, v);
          for (const [k, v] of Object.entries(saved.local ?? {})) this.localModels.set(k, v);
        }
      } catch {
        this.fittedAt = null;
      }
    }
  }

  get current(): ProgramState {
    return this.state;
  }

  start(): () => void {
    const tick = () => void this.run().catch((e: unknown) => this.log.warn({ err: (e as Error).message }, 'program run failed'));
    tick();
    // on the quarter, plus a few seconds so the new price slot is in place
    const delay = QUARTER_MS - (Date.now() % QUARTER_MS) + 5000;
    let timer: NodeJS.Timeout | undefined;
    const first = setTimeout(() => {
      tick();
      timer = setInterval(tick, QUARTER_MS);
      timer.unref();
    }, delay);
    first.unref();
    return () => {
      clearTimeout(first);
      if (timer) clearInterval(timer);
    };
  }

  private num(id: string, fallback: number): number {
    if (!this.engine.store.has(id)) return fallback;
    const v = this.engine.store.get(id);
    return typeof v === 'number' ? v : fallback;
  }

  /** program_learn_since as epoch ms (local midnight of that date), or null when empty or not a date. */
  private learnSince(): { text: string | null; ms: number | null } {
    const v = this.engine.store.has('program_learn_since') ? this.engine.store.get('program_learn_since') : null;
    const text = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null;
    if (!text) return { text: null, ms: null };
    const [y, m, d] = text.split('-').map(Number) as [number, number, number];
    const ms = new Date(y, m - 1, d).getTime();
    return Number.isNaN(ms) ? { text: null, ms: null } : { text, ms };
  }
  /** What the models were learnt with: a change (a date to learn from, the half-life, extra heat settings) refits at once. */
  private learnKey(): string {
    const cell = (id: string) => (this.engine.store.has(id) ? String(this.engine.store.get(id) ?? '') : '');
    const extra = [...this.engine.config.rooms.keys()].map((r) => cell(`${r}_extra_heat_sensor`)).join(',');
    return [this.learnSince().text ?? '', this.halfLifeDays(), extra, cell('program_extra_heat_margin')].join('|');
  }
  private halfLifeDays(): number {
    return Math.max(0.5, this.num('program_learn_halflife', 7));
  }

  /** Heated rooms: a `_target` cell and thermostats with watts whose heating history record names them. */
  private rooms(): { id: string; name: string; heaters: Heater[] }[] {
    const cfg = this.engine.config;
    const sensorOf = new Map<string, string>();
    for (const rec of cfg.history) {
      if (rec.collection !== 'heating') continue;
      const constant = rec.fields.find((f) => f.field === 'sensor')?.source.match(/^"(.*)"$/)?.[1];
      const device = rec.refs.map((r) => r.split('.')[0]!).find((d) => cfg.devices.get(d)?.kind.name === 'thermostat');
      if (constant && device && !sensorOf.has(device)) sensorOf.set(device, constant);
    }
    const out: { id: string; name: string; heaters: Heater[] }[] = [];
    for (const room of cfg.rooms.values()) {
      if (!cfg.cells.has(`${room.id}_target`)) continue;
      const heaters = [...cfg.devices.values()]
        .filter((d) => d.room === room.id && d.kind.name === 'thermostat' && d.watts && sensorOf.has(d.id))
        .map((d) => ({ id: d.id, kw: d.watts! / 1000, sensor: sensorOf.get(d.id)! }));
      if (heaters.length) out.push({ id: room.id, name: room.name, heaters });
    }
    return out;
  }

  /**
   * Heaters with their own clock (kind heater, source estimate, with watts) and the `sensor` constant of the heating
   * history record that writes their estimate (it is also what their model learns from).
   */
  private localHeaters(): { id: string; name: string; room: string; kw: number; sensor: string | null }[] {
    const cfg = this.engine.config;
    return [...cfg.devices.values()]
      .filter((d) => d.kind.name === 'heater' && d.source.type === 'estimate' && d.watts)
      .map((d) => {
        const rec = cfg.history.find((r) => r.collection === 'heating' && r.refs.some((x) => x.split('.')[0] === d.id));
        const sensor = rec?.fields.find((f) => f.field === 'sensor')?.source.match(/^"(.*)"$/)?.[1] ?? null;
        return { id: d.id, name: d.name, room: d.room, kw: d.watts! / 1000, sensor };
      });
  }

  /** A room's temperature now: the mean of its other reachable sensors, leaving out the setting reading_exclude. */
  private roomTemperature(room: string, except: string): number | null {
    const ex = this.engine.store.has('reading_exclude') ? String(this.engine.store.get('reading_exclude') ?? '') : '';
    const excluded = new Set(ex.split(/[\s,]+/).filter(Boolean));
    const vals = [...this.engine.config.devices.values()]
      .filter((d) => d.room === room && d.id !== except && this.engine.store.get(`${d.id}.available`) !== false && !excluded.has(`${d.id}.temperature`))
      .map((d) => (this.engine.store.has(`${d.id}.temperature`) ? this.engine.store.get(`${d.id}.temperature`) : null))
      .filter((v): v is number => typeof v === 'number');
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }

  /**
   * The estimate written so far, revised by what the model knows now: each of the heater's own history rows gets the
   * share it would get today (its room temperature and setpoint, the outdoor temperature then). In the hold band the
   * rows were written as 0 before there was a model (unknown cannot be stored), so a new model fills them in.
   */
  private async reviseLocal(h: { id: string; kw: number }, model: LocalHeaterModel, rows: Record<string, unknown>[], outdoor: Points): Promise<void> {
    const update = this.opts.history.update?.bind(this.opts.history);
    if (!update) return;
    let changed = 0;
    for (const r of rows) {
      const id = r['id'];
      const t = typeof r['when'] === 'string' ? Date.parse(r['when'].replace(' ', 'T')) / 1000 : NaN;
      const tin = r['current'];
      const sp = r['target'];
      const tout = meanOver(outdoor, t - 1800, t + 1800, 3 * 3600);
      if (typeof id !== 'string' || !Number.isFinite(t) || typeof tin !== 'number' || typeof sp !== 'number' || tout === null) continue;
      const pi = localDemand(model, tin, tout, sp, h.kw);
      if (pi === null || Math.abs(pi - (typeof r['pi'] === 'number' ? r['pi'] : -1)) < 1) continue;
      try {
        await update('heating', id, { pi, heating: pi > 0 });
        changed++;
      } catch (e) {
        this.log.warn({ heater: h.id, id, err: (e as Error).message }, 'could not revise a heater history row');
        return;
      }
    }
    if (changed) this.log.info({ heater: h.id, rows: changed }, 'heater history revised by the new model');
  }

  private async fit(rooms: { id: string; heaters: Heater[] }[]): Promise<void> {
    const until = Date.now();
    const learn = this.learnSince();
    const since = Math.max(until - FIT_DAYS * 86_400_000, learn.ms ?? 0);
    const halfLife = this.halfLifeDays();
    const iso = (ms: number) => new Date(ms).toISOString();
    const [heating, weather] = await Promise.all([this.opts.history.query('heating', iso(since), iso(until)), this.opts.history.query('weather', iso(since), iso(until))]);
    // a room's extra heat sensor (<room>_extra_heat_sensor, a device id): the `sensor` constant of its climate history
    const cfg0 = this.engine.config;
    const extraSensorOf = (room: string): string | null => {
      const cell = `${room}_extra_heat_sensor`;
      const dev = this.engine.store.has(cell) ? this.engine.store.get(cell) : null;
      if (typeof dev !== 'string' || !dev) return null;
      const rec = cfg0.history.find((r) => r.collection === 'climate' && r.refs.some((x) => x.split('.')[0] === dev));
      return rec?.fields.find((f) => f.field === 'sensor')?.source.match(/^"(.*)"$/)?.[1] ?? null;
    };
    const extraMargin = this.num('program_extra_heat_margin', 2);
    const climate = rooms.some((r) => extraSensorOf(r.id)) ? await this.opts.history.query('climate', iso(since), iso(until)) : [];
    const ts = (r: Record<string, unknown>) => (typeof r['when'] === 'string' ? Date.parse(r['when'].replace(' ', 'T')) / 1000 : NaN);
    const series = (rows: Record<string, unknown>[], pick: (r: Record<string, unknown>) => unknown): Points =>
      rows
        .map((r) => [ts(r), pick(r)] as [number, unknown])
        .filter((p): p is [number, number] => Number.isFinite(p[0]) && typeof p[1] === 'number' && Number.isFinite(p[1]))
        .sort((a, b) => a[0] - b[0]);
    const outdoor = series(weather, (r) => r['temperature']);
    const clouds = series(weather, (r) => iconOctas(typeof r['icon'] === 'string' ? r['icon'] : null));
    const cfg = this.engine.config;
    for (const room of rooms) {
      const rows = (sensor: string) => heating.filter((r) => r['sensor'] === sensor);
      const samples = buildSamples({
        temperatures: room.heaters.map((h) => series(rows(h.sensor), (r) => r['current'])),
        heaters: room.heaters.map((h) => ({ demand: series(rows(h.sensor), (r) => r['pi']), kw: h.kw })),
        outdoor,
        clouds,
        latitude: cfg.latitude,
        longitude: cfg.longitude,
        from: since / 1000,
        to: until / 1000,
        stepS: FIT_STEP_S,
      });
      // extra heat (a wood stove): the room's <room>_extra_heat_sensor clearly warmer than its thermostats while they
      // hardly heat; those quarters are left out of the fit and the check, so the model learns the room without it
      const ref = extraSensorOf(room.id);
      if (ref) {
        const refTemps = series(climate.filter((r) => r['sensor'] === ref), (r) => r['temperature']);
        const maxKw = room.heaters.reduce((n, h) => n + h.kw, 0);
        for (const sm of samples) {
          const y = meanOver(refTemps, sm.t, sm.t + FIT_STEP_S, 2 * 3600);
          sm.extra = y !== null && y - sm.tin > extraMargin && sm.power < 0.2 * maxKw;
        }
      }
      const enough = until - since >= MIN_LEARN_DAYS * 86_400_000;
      const model = enough ? fitTrajectory(samples, { stepS: FIT_STEP_S, horizonSteps: FIT_HORIZON_STEPS, halfLifeS: halfLife * 86_400, now: until / 1000 }) : null;
      let check: ModelCheck | null = null;
      if (model) {
        const bt = backtest(model, samples, until / 1000 - CHECK_DAYS * 86_400, until / 1000, FIT_HORIZON_STEPS);
        if (bt) {
          const shownFrom = until / 1000 - CHECK_SHOWN_H * 3600;
          const r = (v: number) => Math.round(v * 100) / 100;
          check = { rmse: r(bt.rmse), max: r(bt.max), overRmse: r(bt.overRmse), overMax: r(bt.overMax), extra: samples.filter((x) => x.extra).length, points: bt.points.filter((p) => p[0] >= shownFrom).map((p) => [p[0] * 1000, r(p[1]), r(p[2])]) };
        }
      }
      // the observed curve: hourly outdoor temperature against mean heating power, at most ~300 points
      const hourly = samples.filter((s) => s.t % 3600 === 0);
      const every = Math.max(1, Math.ceil(hourly.length / 300));
      const observed = hourly.filter((_, i) => i % every === 0).map((s) => ({ tout: Math.round(s.tout * 10) / 10, kw: Math.round(s.power * 1000) / 1000 }));
      this.models.set(room.id, { model, observed, check });
      this.log.info({ room: room.id, samples: samples.length, model, check: check && { rmse: check.rmse, max: check.max } }, 'program model fitted');
    }
    // heaters with their own clock: from their own history rows (room temperature, setpoint), outdoor from the weather
    for (const h of this.localHeaters()) {
      if (!h.sensor) {
        this.localModels.set(h.id, null);
        continue;
      }
      const rows = heating.filter((r) => r['sensor'] === h.sensor);
      const tin = series(rows, (r) => r['current']);
      const target = series(rows, (r) => r['target']);
      const samples: LocalSample[] = [];
      for (let a = Math.ceil(since / 1000 / FIT_STEP_S) * FIT_STEP_S; a + FIT_STEP_S <= until / 1000; a += FIT_STEP_S) {
        const t = meanOver(tin, a, a + FIT_STEP_S, 2 * 3600);
        const sp = meanOver(target, a, a + FIT_STEP_S, 2 * 3600);
        const out = meanOver(outdoor, a, a + FIT_STEP_S, 3 * 3600);
        if (t !== null && sp !== null && out !== null) samples.push({ t: a, tin: t, tout: out, setpoint: sp });
      }
      const model = fitLocalHeater(samples, h.kw, FIT_STEP_S);
      this.localModels.set(h.id, model);
      this.log.info({ heater: h.id, samples: samples.length, model }, 'local heater model fitted');
      if (model) await this.reviseLocal(h, model, rows, outdoor);
    }
    this.fittedAt = Date.now();
    this.fittedWith = this.learnKey();
    this.learnFrom = since;
    writeFileSync(this.opts.stateFile, JSON.stringify({ fittedAt: this.fittedAt, fittedWith: this.fittedWith, learnFrom: this.learnFrom, models: Object.fromEntries(this.models), local: Object.fromEntries(this.localModels) }));
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const errors: string[] = [];
    try {
      const rooms = this.rooms();
      const learn = this.learnSince();
      const refit = this.learnKey() !== this.fittedWith;
      if (refit || !this.fittedAt || Date.now() - this.fittedAt > FIT_EVERY_MS || rooms.some((r) => !this.models.has(r.id)) || this.localHeaters().some((h) => !this.localModels.has(h.id))) {
        try {
          await this.fit(rooms);
        } catch (e) {
          errors.push(`modellen kunde inte tränas: ${(e as Error).message}`);
        }
      }
      const now = Date.now();
      const start = Math.floor(now / QUARTER_MS) * QUARTER_MS;
      const forecast = this.opts.forecast ? await this.opts.forecast.get() : null;
      if (!forecast) errors.push('ingen väderprognos');
      // prices from a day back: where tomorrow's are not published yet (before ~13:00), the same quarter a day earlier stands in
      const slots = this.opts.prices ? await this.opts.prices.query(start - 86_400_000, start + HORIZON_MS) : [];
      const known = slots.filter((s) => s.end * 1000 > start);
      const pricesUntil = known.length ? Math.max(...known.map((s) => s.end)) * 1000 : null;
      const end = start + HORIZON_MS;
      const vat = this.num('electricity_vat', 1.25);
      const surcharge = this.num('electricity_surcharge', 0);
      const spotMean = slots.length ? slots.reduce((s, x) => s + x.sek, 0) / slots.length : 1;
      const cfg = this.engine.config;
      const times: number[] = [];
      for (let t = start; t < end; t += QUARTER_MS) times.push(t);
      const env = times.map((t) => {
        const mid = t + QUARTER_MS / 2;
        const at = (from: number) => slots.filter((s) => s.start * 1000 < from + QUARTER_MS && s.end * 1000 > from);
        const inSlot = at(t).length ? at(t) : at(t - 86_400_000);
        const spot = inSlot.length ? inSlot.reduce((s, x) => s + x.sek, 0) / inSlot.length : spotMean;
        const toutNow = this.num('weather.temperature', 5);
        const tout = forecast ? (forecastAt(forecast.points, mid, 'temperature') ?? toutNow) : toutNow;
        const octas = forecast ? (forecastAt(forecast.points, mid, 'octas') ?? 8) : 8;
        return { t, tout, sun: sunFactor(solarElevation(mid, cfg.latitude, cfg.longitude), octas), price: spot * vat + surcharge };
      });
      const slack = this.num('program_slack', 1);
      const preheat = this.num('program_preheat', 1.5);
      const shortfallCost = this.num('program_shortfall_cost', 0.5);
      // the modes each quarter asks for: the week schedule in heat_mode program (and in manual, for the plan shown),
      // or the mode chosen
      const heatMode = this.engine.store.has('heat_mode') ? this.engine.store.get('heat_mode') : null;
      const fixed = typeof heatMode === 'string' && cfg.week.modes.includes(heatMode) ? heatMode : null;
      // a mode chosen with an end (heat_until, Värme's quick choices) holds until then; after it, the week schedule
      const untilCell = this.engine.store.has('heat_until') ? this.engine.store.get('heat_until') : null;
      const until = untilCell instanceof Timestamp ? untilCell.ms : null;
      const modesAt = times.map((t) => (fixed && (until === null || t < until) ? [fixed] : scheduleAt(cfg.week, t + QUARTER_MS / 2, cfg.timezone)));
      const overlapSlack = this.num('heat_overlap_slack', 1);
      const maxError = this.num('program_max_error', 0.5);
      const out: ProgramRoom[] = [];
      const inputs: { cell: string; value: Value }[] = [];
      for (const room of rooms) {
        const saved = this.models.get(room.id);
        const model = saved?.model ?? null;
        const check = saved?.check ?? null;
        const trusted = usable(model, check, maxError);
        const heaters = room.heaters.filter((h) => this.engine.store.get(`${h.id}.available`) !== false);
        const temps = heaters.map((h) => this.engine.store.get(`${h.id}.temperature`)).filter((v): v is number => typeof v === 'number');
        // comfort: the warmest of the modes in force (<room>_<mode>), less heat_overlap_slack in a transition, never below heat_cold
        const modeTemp = (m: string) => this.engine.store.has(`${room.id}_${m}`) ? this.engine.store.get(`${room.id}_${m}`) : null;
        const allTemps = cfg.week.modes.map(modeTemp).filter((v): v is number => typeof v === 'number');
        const cold = this.num('heat_cold', allTemps.length ? Math.min(...allTemps) : 12);
        const comfort: (number | null)[] = modesAt.map((modes) => {
          const temps = modes.map(modeTemp).filter((v): v is number => typeof v === 'number');
          if (!temps.length) return modes.length ? null : cold;
          return Math.max(cold, Math.max(...temps) - (modes.length > 1 ? overlapSlack : 0));
        });
        const curveTemp = Math.max(...comfort.filter((c): c is number => typeof c === 'number'), 18);
        const entry: ProgramRoom = {
          id: room.id,
          name: room.name,
          heaters: room.heaters.map((h) => ({ id: h.id, kw: h.kw })),
          model,
          usable: trusted,
          curve: model && model.a > 0 && model.b > 0 ? [-15, -10, -5, 0, 5, 10, 15].map((tout) => ({ tout, kw: Math.round(holdingPower(model!, curveTemp, tout) * 1000) / 1000 })) : [],
          observed: saved?.observed ?? [],
          check,
          curveTemp,
          plan: null,
          setpoints: comfort.every((c) => typeof c === 'number') ? times.map((t, k) => ({ t, setpoint: comfort[k] as number })) : [],
          setpoint: null,
          note: null,
        };
        if (!model) entry.note = learn.ms !== null && Date.now() - learn.ms < MIN_LEARN_DAYS * 86_400_000 ? `lär om sedan ${learn.text}, behöver ${MIN_LEARN_DAYS} dygn` : 'för lite historik för en modell';
        else if (!trusted)
          entry.note =
            check && (check.overRmse > maxError || check.overMax > 3 * maxError)
              ? `modellen tror att rummet är varmare än det är, senaste veckan med ${check.overRmse.toLocaleString('sv-SE')} °C i snitt och som mest ${check.overMax.toLocaleString('sv-SE')} °C (gränserna är ${maxError.toLocaleString('sv-SE')} och ${(3 * maxError).toLocaleString('sv-SE')}), så lägenas temperaturer gäller utan förvärmning tills den har lärt sig`
              : 'modellen är orimlig, så lägenas temperaturer gäller';
        else if (!temps.length) entry.note = 'termostaterna rapporterar ingen temperatur';
        else if (comfort.some((c) => typeof c !== 'number')) entry.note = `${room.id}_<läge> saknas för något läge i schemat`;
        else {
          const t0 = temps.reduce((s, v) => s + v, 0) / temps.length;
          const maxKw = heaters.reduce((s, h) => s + h.kw, 0);
          const band = comfortBand(comfort as number[], { slack, preheat, lookaheadSteps: 8 * 4, cold });
          const input: PlanInput[] = env.map((e, k) => ({ ...e, comfort: comfort[k] as number, ...band[k]! }));
          const opts = { stepH: STEP_H, maxKw, shortfallCost };
          entry.plan = planRoom(model, t0, input, opts);
          entry.setpoints = entry.plan.steps.map((s) => ({ t: s.t, setpoint: s.setpoint }));
          entry.setpoint = entry.plan.steps[0]?.setpoint ?? null;
        }
        inputs.push({ cell: `program.${room.id}`, value: entry.setpoint });
        out.push(entry);
      }
      // heaters with their own clock: the room temperature, the setpoint by the clock (<room>_local_setpoint), the estimate
      const local: LocalHeaterState[] = [];
      const toutNow = this.engine.store.has('weather.temperature') ? this.engine.store.get('weather.temperature') : null;
      for (const h of this.localHeaters()) {
        const model = this.localModels.get(h.id) ?? null;
        const temperature = this.roomTemperature(h.room, h.id);
        const spCell = `${h.room}_local_setpoint`;
        const sp = this.engine.store.has(spCell) ? this.engine.store.get(spCell) : null;
        const setpoint = typeof sp === 'number' ? sp : null;
        const demand = temperature !== null && setpoint !== null && typeof toutNow === 'number' ? localDemand(model, temperature, toutNow, setpoint, h.kw) : null;
        const note =
          setpoint === null
            ? `cellen ${spCell} saknas: elementets inställning är okänd`
            : temperature === null
              ? 'ingen annan givare i rummet mäter temperaturen'
              : !h.sensor
                ? 'ingen värmehistorik i history.tsv för elementet, så modellen kan inte lära sig'
                : !model
                  ? 'lär sig ännu: behöver några uppvärmningar och avsvalningar, så länge räknas bara fullt och avslaget'
                  : null;
        inputs.push({ cell: `${h.id}.temperature`, value: temperature }, { cell: `${h.id}.setpoint`, value: setpoint }, { cell: `${h.id}.demand`, value: demand });
        local.push({ id: h.id, name: h.name, room: h.room, kw: h.kw, model, temperature, setpoint, demand, note });
      }
      if (inputs.length) this.engine.applyInputs(inputs, 'program');
      this.state = {
        at: now,
        fittedAt: this.fittedAt,
        learn: { from: this.learnFrom, halfLifeDays: this.halfLifeDays(), since: learn.text, maxError },
        forecast: forecast ? { created: forecast.created, fetched: forecast.fetched } : null,
        pricesUntil,
        ahead: env.map((e) => ({ t: e.t, tout: Math.round(e.tout * 10) / 10, price: Math.round(e.price * 1000) / 1000 })),
        rooms: out,
        local,
        errors,
      };
    } finally {
      this.running = false;
    }
  }
}
