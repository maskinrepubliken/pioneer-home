/**
 * The simulator: the real engine wired to a fake clock, a fake transport and a fixed sun.
 * Commands sent to devices are echoed back as device state, so traces show consequences.
 */
import { loadConfig, type LoadResult } from '../config/loader.js';
import type { Config, DeviceDef } from '../config/model.js';
import { ConfigLoadError } from '../config/errors.js';
import { SimClock } from '../core/clock.js';
import { Engine, type Trace } from '../core/engine.js';
import type { RawState } from '../core/kinds.js';
import { fixedSun } from '../core/sun.js';
import { FakeTransport, type PublishedMessage } from '../core/transport.js';
import { localParts } from '../formula/time.js';
import { parseLiteral, type Value } from '../formula/values.js';

export interface SimulatorOptions {
  /** epoch ms to start at */
  at: number;
  /** echo /set commands back as device state (default true) */
  echo?: boolean;
}

export class Simulator {
  readonly clock: SimClock;
  readonly transport = new FakeTransport();
  readonly sun = fixedSun(10);
  readonly engine: Engine;
  readonly traces: Trace[] = [];
  readonly config: Config;
  private deviceState = new Map<string, RawState>();

  constructor(config: Config, opts: SimulatorOptions) {
    this.config = config;
    this.clock = new SimClock(opts.at);
    if (opts.echo ?? true) this.transport.onPublish((m) => this.echo(m));
    this.engine = new Engine(config, { clock: this.clock, transport: this.transport, sun: this.sun, dryRun: false });
    this.engine.onTrace((t) => this.traces.push(t));
  }

  static fromDir(dir: string, opts: SimulatorOptions): Simulator {
    const res: LoadResult = loadConfig(dir);
    if (!res.ok) throw new ConfigLoadError(res.errors);
    return new Simulator(res.config, opts);
  }

  get tz(): string {
    return this.config.timezone;
  }

  /** Sets a cell from literal text, typed by the cell's declared type. */
  set(cell: string, text: string): void {
    const id = this.engine.store.resolve(cell);
    const def = this.config.cells.get(id);
    if (!def) throw new Error(`unknown cell "${cell}"`);
    const value = parseLiteral(text, def.type === 'any' ? undefined : def.type);
    if (id === 'sun.elevation' && typeof value === 'number') this.sun.setElevation(value);
    // Device cells: also keep the echo state coherent so a later /set merges correctly.
    if (def.device && def.prop) this.rememberRaw(def.device, def.prop, value);
    this.engine.applyInput(id, value, `set ${cell} ${text}`);
  }

  event(name: string): void {
    this.engine.dispatchEvent(name);
  }

  mqtt(topic: string, payload: string): void {
    this.transport.inject(topic, payload);
  }

  action(text: string): void {
    this.engine.runAction(text);
  }

  advance(ms: number): void {
    this.clock.advance(ms);
  }

  advanceTo(epochMs: number): void {
    this.clock.advanceTo(epochMs);
  }

  now(): number {
    return this.clock.now();
  }

  published(fromIndex = 0): PublishedMessage[] {
    return this.transport.since(fromIndex);
  }

  get(cell: string): Value {
    return this.engine.store.get(cell);
  }

  private echo(m: PublishedMessage): void {
    if (!m.topic.endsWith('/set')) return;
    const stateTopic = m.topic.slice(0, -4);
    const dev = [...this.config.devices.values()].find((d) => this.engine.stateTopic(d) === stateTopic);
    if (!dev) return;
    let set: RawState;
    try {
      set = JSON.parse(m.payload) as RawState;
    } catch {
      return;
    }
    const next = dev.kind.applySet(this.deviceState.get(dev.id) ?? {}, set);
    this.deviceState.set(dev.id, next);
    this.transport.inject(stateTopic, JSON.stringify(next));
  }

  /** Keeps the raw echo state in step when a scenario sets a device cell directly. */
  private rememberRaw(deviceId: string, prop: string, value: Value): void {
    const dev: DeviceDef | undefined = this.config.devices.get(deviceId);
    if (!dev) return;
    const raw = { ...(this.deviceState.get(deviceId) ?? {}) };
    switch (dev.kind.name) {
      case 'light':
        if (prop === 'state') raw['state'] = value ? 'ON' : 'OFF';
        else if (prop === 'brightness' && typeof value === 'number') raw['brightness'] = Math.round((value / 100) * 254);
        else if (prop === 'color_temp' && typeof value === 'number' && value > 0) raw['color_temp'] = Math.round(1_000_000 / value);
        else raw[prop] = value;
        break;
      case 'plug':
        if (prop === 'state') raw['state'] = value ? 'ON' : 'OFF';
        else raw[prop] = value;
        break;
      case 'thermostat':
        if (prop === 'temperature') raw['local_temperature'] = value;
        else if (prop === 'setpoint') raw['occupied_heating_setpoint'] = value;
        else if (prop === 'demand') raw['pi_heating_demand'] = value;
        else if (prop === 'mode') raw['system_mode'] = value;
        else raw[prop] = value;
        break;
      default:
        raw[prop] = value;
    }
    this.deviceState.set(deviceId, raw);
  }
}

/** Parses "2026-09-23T21:00" (local wall time in tz) or a full ISO string with offset. */
export function parseWhen(text: string, tz: string): number {
  const t = text.trim();
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(t)) {
    const ms = Date.parse(t);
    if (Number.isNaN(ms)) throw new Error(`bad timestamp "${text}"`);
    return ms;
  }
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) throw new Error(`bad timestamp "${text}" (expected YYYY-MM-DDTHH:MM)`);
  const [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  // Interpret as wall time in tz: start from the UTC guess and correct by the zone offset at that instant.
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const p = localParts(guess, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const first = guess - (wall - guess);
  // one more round handles the offset changing between guess and result (DST edge)
  const p2 = localParts(first, tz);
  const wall2 = Date.UTC(p2.year, p2.month - 1, p2.day, p2.hour, p2.minute, p2.second);
  return first - (wall2 - guess);
}
