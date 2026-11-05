/**
 * The program: learns each heated room's thermal model from history and plans its heating for the coming hours at
 * the lowest cost (core/thermal.ts, core/planner.ts). Feeds the system cells `program.<room>` (the setpoint for now)
 * and GET /api/program (models, heating curves, the plan and the thermostats' setpoints ahead).
 *
 * A room takes part when it has a `<room>_target` cell and thermostats with rated watts (devices.tsv). Its comfort
 * for each quarter comes from the modes in force: the week schedule (week.tsv) in heat_mode program, else the
 * mode chosen; the warmest of the modes' `<room>_<mode>` temperatures, less `heat_overlap_slack` in a transition
 * (two modes at once), never below `heat_cold`. The comparison holds that comfort exactly, without planning. Tuning lives in cells.tsv: `program_slack` (°C the room may be short, default 1),
 * `program_preheat` (°C above the coming comfort it may be warmed, default 1.5) and `program_shortfall_cost`
 * (kr per °C·h short, default 0.5); `heat_cold` is a comfort that is never undercut.
 *
 * The plan reaches 36 hours ahead; quarters beyond the published prices are priced as the same quarter a day
 * earlier (an estimate; `pricesUntil` says where it starts). Models are refitted every 6 hours on the last 28 days (heating, weather) and kept in STATE_DIR/program.json; the
 * plan is redone every quarter from the temperature measured now, so its own errors are corrected as it goes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Logger } from 'pino';
import type { Engine } from '../core/engine.js';
import { comfortBand, planRoom, type Plan, type PlanInput } from '../core/planner.js';
import { buildSamples, fitModel, holdingPower, iconOctas, solarElevation, sunFactor, usable, type Points, type RoomModel } from '../core/thermal.js';
import type { Value } from '../formula/values.js';
import { scheduleAt } from '../core/schedule.js';
import { forecastAt, type ForecastService } from './forecast.js';
import type { HistoryQuery } from './pocketbase.js';
import type { PriceService } from './prices.js';

const QUARTER_MS = 900_000;
const STEP_H = 0.25;
const HORIZON_MS = 36 * 3_600_000;
const FIT_DAYS = 28;
const FIT_EVERY_MS = 6 * 3_600_000;
const FIT_STEP_S = 3600;

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
  plan: Plan | null;
  /** what the room's thermostats are set to, quarter by quarter: the plan's setpoints, or the comfort without a plan */
  setpoints: { t: number; setpoint: number }[];
  /** the setpoint fed to program.<room> now */
  setpoint: number | null;
  note: string | null;
}

export interface ProgramState {
  at: number;
  fittedAt: number | null;
  forecast: { created: number; fetched: number } | null;
  /** end of the known prices (epoch ms) */
  pricesUntil: number | null;
  rooms: ProgramRoom[];
  errors: string[];
}

export class ProgramService {
  private models = new Map<string, { model: RoomModel | null; observed: { tout: number; kw: number }[] }>();
  private fittedAt: number | null = null;
  private state: ProgramState = { at: 0, fittedAt: null, forecast: null, pricesUntil: null, rooms: [], errors: [] };
  private running = false;

  constructor(
    private engine: Engine,
    private opts: { history: HistoryQuery; prices?: PriceService; forecast?: ForecastService; stateFile: string },
    private log: Logger,
  ) {
    if (existsSync(opts.stateFile)) {
      try {
        const saved = JSON.parse(readFileSync(opts.stateFile, 'utf8')) as { fittedAt: number; models: Record<string, { model: RoomModel | null; observed: { tout: number; kw: number }[] }> };
        this.fittedAt = saved.fittedAt;
        for (const [k, v] of Object.entries(saved.models)) this.models.set(k, v);
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

  private async fit(rooms: { id: string; heaters: Heater[] }[]): Promise<void> {
    const until = Date.now();
    const since = until - FIT_DAYS * 86_400_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    const [heating, weather] = await Promise.all([this.opts.history.query('heating', iso(since), iso(until)), this.opts.history.query('weather', iso(since), iso(until))]);
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
      const model = fitModel(samples, FIT_STEP_S);
      // the observed curve: hourly outdoor temperature against mean heating power, at most ~300 points
      const every = Math.max(1, Math.ceil(samples.length / 300));
      const observed = samples.filter((_, i) => i % every === 0).map((s) => ({ tout: Math.round(s.tout * 10) / 10, kw: Math.round(s.power * 1000) / 1000 }));
      this.models.set(room.id, { model, observed });
      this.log.info({ room: room.id, samples: samples.length, model }, 'program model fitted');
    }
    this.fittedAt = Date.now();
    writeFileSync(this.opts.stateFile, JSON.stringify({ fittedAt: this.fittedAt, models: Object.fromEntries(this.models) }));
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const errors: string[] = [];
    try {
      const rooms = this.rooms();
      if (!this.fittedAt || Date.now() - this.fittedAt > FIT_EVERY_MS || rooms.some((r) => !this.models.has(r.id))) {
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
      const modesAt = times.map((t) => (fixed ? [fixed] : scheduleAt(cfg.week, t + QUARTER_MS / 2, cfg.timezone)));
      const overlapSlack = this.num('heat_overlap_slack', 1);
      const out: ProgramRoom[] = [];
      const inputs: { cell: string; value: Value }[] = [];
      for (const room of rooms) {
        const saved = this.models.get(room.id);
        const model = saved?.model ?? null;
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
          usable: usable(model),
          curve: model && model.a > 0 && model.b > 0 ? [-15, -10, -5, 0, 5, 10, 15].map((tout) => ({ tout, kw: Math.round(holdingPower(model!, curveTemp, tout) * 1000) / 1000 })) : [],
          observed: saved?.observed ?? [],
          curveTemp,
          plan: null,
          setpoints: comfort.every((c) => typeof c === 'number') ? times.map((t, k) => ({ t, setpoint: comfort[k] as number })) : [],
          setpoint: null,
          note: null,
        };
        if (!model) entry.note = 'för lite historik för en modell';
        else if (!usable(model)) entry.note = 'modellen är för osäker att styra efter, så schemat gäller';
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
      if (inputs.length) this.engine.applyInputs(inputs, 'program');
      this.state = {
        at: now,
        fittedAt: this.fittedAt,
        forecast: forecast ? { created: forecast.created, fetched: forecast.fetched } : null,
        pricesUntil,
        rooms: out,
        errors,
      };
    } finally {
      this.running = false;
    }
  }
}
