/**
 * The engine: a spreadsheet evaluator with edge-triggered rules, events and timed sequences. Everything happens in passes taken from a FIFO queue, each with a single cause, so
 * every trace reads as "because X happened, these cells changed, these rules fired, these actions went out".
 */
import { formula } from '../formula/index.js';
import { FormulaError, type Ast, type EvalContext } from '../formula/api.js';
import { Timestamp, formatValue, parseLiteral, type Value } from '../formula/values.js';
import { localParts } from '../formula/time.js';
import type { ActionDef, ActionToken, Config, DeviceDef, RuleDef, ScheduleTime, SequenceDef } from '../config/model.js';
import { settingString } from '../config/loader.js';
import { parseActions } from '../config/actions.js';
import type { Clock, TimerHandle } from './clock.js';
import { DependencyGraph } from './graph.js';
import { parseTargets, type RawState } from './kinds.js';
import { CellStore, type CellChange, type StoreSnapshot } from './store.js';
import type { SunProvider } from './sun.js';
import type { Transport } from './transport.js';

export interface RuleTrace {
  id: string;
  fired: boolean;
  cond: Value;
  reason: string;
}

export interface ActionTrace {
  source: string;
  detail: string;
  topic?: string;
  payload?: string;
  dryRun: boolean;
  error?: string;
}

export interface SequenceTrace {
  id: string;
  event: 'started' | 'step' | 'waiting' | 'cancelled' | 'finished';
  step?: number;
  reason?: string;
}

export interface Trace {
  cause: string;
  at: number;
  changed: CellChange[];
  derived: CellChange[];
  rules: RuleTrace[];
  actions: ActionTrace[];
  sequences: SequenceTrace[];
  errors: string[];
}

export interface ScriptRunner {
  run(file: string, args: string[], engine: Engine): Promise<void> | void;
}

export interface EngineDeps {
  clock: Clock;
  transport: Transport;
  sun: SunProvider;
  dryRun: boolean;
  scripts?: ScriptRunner;
  /** Fires sun/tick timers. Tests may turn it off to keep passes fully explicit. */
  timers?: boolean;
}

interface SequenceInstance {
  id: string;
  /** index into steps of the step waiting to run */
  next: number;
  startedAt: number;
  timer: TimerHandle | null;
  dueAt: number | null;
}

interface QueuedPass {
  cause: string;
  apply: (trace: Trace) => void;
  depth: number;
}

export interface EngineSnapshot {
  store: StoreSnapshot;
  sequences: { id: string; next: number; startedAt: number; dueAt: number | null }[];
  lastCond: Record<string, unknown>;
}

const MAX_CHAIN_DEPTH = 20;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 10;

export class Engine {
  config: Config;
  readonly store: CellStore;
  private graph: DependencyGraph;
  private readonly clock: Clock;
  private readonly transport: Transport;
  private readonly sun: SunProvider;
  private readonly dryRun: boolean;
  private readonly scripts: ScriptRunner | undefined;
  private readonly timersEnabled: boolean;

  private queue: QueuedPass[] = [];
  private running = false;
  private lastCond = new Map<string, Value>();
  private sequences = new Map<string, SequenceInstance>();
  private timers: TimerHandle[] = [];
  private traceListeners: ((t: Trace) => void)[] = [];
  private changeListeners: ((changes: CellChange[], at: number) => void)[] = [];
  private rateLog = new Map<string, number[]>();
  private topicToDevice = new Map<string, DeviceDef>();
  private subscribed = false;
  /** last error banner for the UI; null when the config is healthy */
  configError: string | null = null;

  constructor(config: Config, deps: EngineDeps) {
    this.config = config;
    this.clock = deps.clock;
    this.transport = deps.transport;
    this.sun = deps.sun;
    this.dryRun = deps.dryRun;
    this.scripts = deps.scripts;
    this.timersEnabled = deps.timers ?? true;
    this.store = new CellStore(config);
    this.graph = new DependencyGraph(config);
    this.indexTopics();
    this.subscribeAll();
    this.updateSun(false);
    this.baseline();
    this.armTimers();
  }

  // ---- public API -------------------------------------------------------------------------

  onTrace(cb: (t: Trace) => void): void {
    this.traceListeners.push(cb);
  }

  onChanges(cb: (changes: CellChange[], at: number) => void): void {
    this.changeListeners.push(cb);
  }

  now(): number {
    return this.clock.now();
  }

  /** Applies an external change to a cell (used by the simulator, the CLI and the HTTP API). */
  applyInput(cell: string, value: Value, cause = `set ${cell}`): void {
    this.enqueue(cause, (trace) => {
      const id = this.store.resolve(cell);
      if (!this.config.cells.has(id)) {
        trace.errors.push(`unknown cell ${cell}`);
        return;
      }
      const ch = this.store.set(id, value, this.clock.now());
      if (ch) trace.changed.push(ch);
    });
  }

  /** Applies several cell changes as one pass (one MQTT message can update many cells). */
  applyInputs(changes: { cell: string; value: Value }[], cause: string): void {
    this.enqueue(cause, (trace) => {
      const now = this.clock.now();
      for (const c of changes) {
        const ch = this.store.set(c.cell, c.value, now);
        if (ch) trace.changed.push(ch);
      }
    });
  }

  dispatchEvent(name: string, cause = `event ${name}`): void {
    this.enqueue(cause, (trace) => {
      const ch = this.store.set('event', name, this.clock.now());
      if (ch) trace.changed.push(ch);
    });
  }

  /** Runs an action string right away (UI buttons, `home set`). */
  runAction(text: string, cause = `action ${text}`): void {
    const classify = (name: string) => (this.config.devices.has(name) ? 'device' : this.config.vars.has(name) ? 'var' : undefined);
    this.enqueue(cause, (trace) => {
      let defs: ActionDef[];
      try {
        defs = parseActions(text, { classify });
      } catch (e) {
        trace.errors.push((e as Error).message);
        return;
      }
      for (const a of defs) this.execute(a, trace, 1);
    });
  }

  /** Swaps in a new configuration without firing anything. Returns false if the graph could not be built. */
  reload(config: Config): void {
    this.config = config;
    this.store.adopt(config);
    this.graph = new DependencyGraph(config);
    this.indexTopics();
    this.subscribeAll();
    for (const [id, inst] of this.sequences) {
      if (!config.sequences.has(id)) {
        if (inst.timer !== null) this.clock.clear(inst.timer);
        this.sequences.delete(id);
      }
    }
    this.lastCond.clear();
    this.baseline();
    this.armTimers();
    this.configError = null;
  }

  snapshot(): EngineSnapshot {
    return {
      store: this.store.snapshot(this.clock.now()),
      sequences: [...this.sequences.values()].map((s) => ({ id: s.id, next: s.next, startedAt: s.startedAt, dueAt: s.dueAt })),
      lastCond: Object.fromEntries([...this.lastCond].map(([k, v]) => [k, v])),
    };
  }

  restore(snap: EngineSnapshot): void {
    const skip = (id: string) => {
      const def = this.config.cells.get(id);
      return !def || def.kind === 'derived' || def.kind === 'setting' || def.kind === 'system';
    };
    this.store.restore(snap.store, skip);
    this.baseline();
    for (const s of snap.sequences) {
      const def = this.config.sequences.get(s.id);
      if (!def || s.next >= def.steps.length) continue;
      const inst: SequenceInstance = { id: s.id, next: s.next, startedAt: s.startedAt, timer: null, dueAt: s.dueAt };
      this.sequences.set(s.id, inst);
      const at = s.dueAt ?? this.clock.now();
      inst.timer = this.clock.setTimer(Math.max(at, this.clock.now()), () => this.enqueue(`sequence ${s.id} step ${s.next + 1}`, (trace) => this.runStep(inst, def, trace, 1)));
    }
  }

  /** Flips a rule's `enabled` flag at runtime (simulator `enable`/`disable`, UI). Returns false for unknown rules. */
  setRuleEnabled(id: string, enabled: boolean): boolean {
    const rule = this.config.rules.find((r) => r.id === id);
    if (!rule) return false;
    rule.enabled = enabled;
    if (enabled && rule.trigger.kind === 'edge' && rule.condition) {
      // baseline so an already-true condition does not fire the moment the rule is enabled
      const trace: Trace = { cause: `enable ${id}`, at: this.clock.now(), changed: [], derived: [], rules: [], actions: [], sequences: [], errors: [] };
      this.lastCond.set(id, this.safeEval(rule.condition, trace, `rule ${id}`));
    }
    return true;
  }

  runningSequences(): string[] {
    return [...this.sequences.keys()];
  }

  isRunning(sequence: string): boolean {
    return this.sequences.has(sequence);
  }

  /** Evaluates a formula against the live store (CLI `home eval`, UI). */
  evaluate(ast: Ast): Value {
    return formula.evaluate(ast, this.evalContext());
  }

  /** Feeds a raw MQTT message (real adapter or simulator). */
  handleMessage(topic: string, payload: string): void {
    const dev = this.topicToDevice.get(topic);
    if (dev) {
      let raw: RawState;
      try {
        raw = JSON.parse(payload) as RawState;
      } catch {
        return;
      }
      if (!raw || typeof raw !== 'object') return;
      const cells = dev.kind.fromPayload(raw);
      const changes = Object.entries(cells).map(([prop, value]) => ({ cell: `${dev.id}.${prop}`, value }));
      const seen = typeof raw['last_seen'] === 'string' ? Date.parse(raw['last_seen']) : typeof raw['last_seen'] === 'number' ? raw['last_seen'] : this.clock.now();
      changes.push({ cell: `${dev.id}.last_seen`, value: new Timestamp(Number.isNaN(seen) ? this.clock.now() : seen) });
      this.applyInputs(changes, `mqtt ${topic}`);
      return;
    }
    const avail = this.topicToDevice.get(topic.replace(/\/availability$/, ''));
    if (avail && topic.endsWith('/availability')) {
      let state = payload.trim().toLowerCase();
      try {
        const o = JSON.parse(payload) as { state?: string };
        if (o && typeof o.state === 'string') state = o.state.toLowerCase();
      } catch {
        /* plain string */
      }
      this.applyInputs([{ cell: `${avail.id}.available`, value: state === 'online' }], `mqtt ${topic}`);
    }
  }

  // ---- passes -----------------------------------------------------------------------------

  private enqueue(cause: string, apply: (trace: Trace) => void, depth = 0): void {
    if (depth > MAX_CHAIN_DEPTH) {
      this.emit({ cause, at: this.clock.now(), changed: [], derived: [], rules: [], actions: [], sequences: [], errors: [`chain of ${MAX_CHAIN_DEPTH} passes exceeded, dropping "${cause}" (rules feeding each other?)`] });
      return;
    }
    this.queue.push({ cause, apply, depth });
    if (!this.running) this.drain();
  }

  private drain(): void {
    this.running = true;
    try {
      while (this.queue.length) {
        const p = this.queue.shift()!;
        this.runPass(p);
      }
    } finally {
      this.running = false;
    }
  }

  private runPass(p: QueuedPass): void {
    const now = this.clock.now();
    const trace: Trace = { cause: p.cause, at: now, changed: [], derived: [], rules: [], actions: [], sequences: [], errors: [] };
    this.store.beginPass();
    try {
      p.apply(trace);
      const isTick = p.cause === 'tick';
      const changedIds = trace.changed.map((c) => c.cell);
      // 1. recompute affected derived cells (plus all time-dependent ones on a tick)
      const affected = new Set(this.graph.affected(changedIds));
      if (isTick) for (const id of this.graph.timeDependent) affected.add(id);
      for (const id of this.graph.topo) {
        if (!affected.has(id)) continue;
        const def = this.config.derived.get(id)!;
        const value = this.safeEval(def.formula, trace, `derived ${id}`);
        const ch = this.store.set(id, value, now);
        if (ch) {
          trace.derived.push(ch);
          for (const dep of this.graph.readersOf(id)) affected.add(dep);
        }
      }
      const allChanged = new Set([...changedIds, ...trace.derived.map((c) => c.cell)]);
      // 2. rules
      for (const rule of this.config.rules) {
        if (!rule.enabled) continue;
        this.evaluateRule(rule, allChanged, isTick, trace, p.depth);
      }
      // 3. sequences waiting on a step: cancel conditions
      for (const inst of [...this.sequences.values()]) {
        const def = this.config.sequences.get(inst.id);
        if (!def || inst.timer === null) continue;
        const step = def.steps[inst.next];
        const reasons: { ast: Ast; src: string }[] = [];
        if (def.cancelIf) reasons.push({ ast: def.cancelIf, src: def.cancelIfSource });
        if (step?.cancelIf) reasons.push({ ast: step.cancelIf, src: step.cancelIfSource });
        for (const r of reasons) {
          if (this.safeEval(r.ast, trace, `cancel_if of ${inst.id}`) === true) {
            this.cancelSequence(inst.id, trace, `cancel_if ${r.src} became TRUE`);
            break;
          }
        }
      }
    } catch (e) {
      trace.errors.push(`internal error: ${(e as Error).stack ?? String(e)}`);
    } finally {
      this.store.refreshSeen(now);
      this.store.endPass();
      this.store.clearTransients();
    }
    const quiet = isQuietTick(p.cause, trace);
    if (!quiet) this.emit(trace);
    if (trace.changed.length || trace.derived.length) {
      const all = [...trace.changed, ...trace.derived];
      for (const cb of this.changeListeners) cb(all, now);
    }
  }

  private evaluateRule(rule: RuleDef, changed: Set<string>, isTick: boolean, trace: Trace, depth: number): void {
    const relevant = rule.conditionRefs.some((r) => changed.has(r)) || (isTick && rule.conditionTimeDependent);
    switch (rule.trigger.kind) {
      case 'edge': {
        if (!relevant) return;
        const cond = this.safeEval(rule.condition!, trace, `rule ${rule.id}`);
        const was = this.lastCond.get(rule.id);
        this.lastCond.set(rule.id, cond);
        const fire = cond === true && was !== true;
        trace.rules.push({ id: rule.id, fired: fire, cond, reason: fire ? 'rising edge' : cond === true ? 'already true' : `${rule.conditionSource} = ${formatValue(cond)}` });
        if (fire) this.fire(rule, trace, depth);
        return;
      }
      case 'change': {
        if (!changed.has(this.store.resolve(rule.trigger.cell))) return;
        const cond = rule.condition ? this.safeEval(rule.condition, trace, `rule ${rule.id}`) : true;
        const fire = cond === true;
        trace.rules.push({ id: rule.id, fired: fire, cond, reason: fire ? `${rule.trigger.cell} changed` : `${rule.conditionSource} = ${formatValue(cond)}` });
        if (fire) this.fire(rule, trace, depth);
        return;
      }
      case 'event': {
        if (!changed.has('event')) return;
        const cond = rule.condition ? this.safeEval(rule.condition, trace, `rule ${rule.id}`) : true;
        const fire = cond === true;
        trace.rules.push({ id: rule.id, fired: fire, cond, reason: fire ? 'event' : `${rule.conditionSource} = ${formatValue(cond)}` });
        if (fire) this.fire(rule, trace, depth);
        return;
      }
      case 'at':
        // fired by its own timer pass, see armTimers
        return;
    }
  }

  private fire(rule: RuleDef, trace: Trace, depth: number): void {
    for (const a of rule.actions) this.execute(a, trace, depth + 1, rule.id);
  }

  // ---- actions ----------------------------------------------------------------------------

  private execute(action: ActionDef, trace: Trace, depth: number, origin = ''): void {
    const tag = origin ? `${origin}: ${action.source}` : action.source;
    try {
      switch (action.kind) {
        case 'set-device':
          this.setDevice(action.device, action.tokens.map((t) => this.render(t)), trace, tag);
          return;
        case 'fade': {
          const tokens = action.tokens.map((t) => this.render(t));
          tokens.push(`transition=${action.overMs / 1000}s`);
          this.setDevice(action.device, tokens, trace, tag);
          return;
        }
        case 'set-var': {
          const def = this.config.vars.get(action.var)!;
          const text = this.render(action.value);
          const value = parseLiteral(text, def.type);
          this.enqueue(`set ${action.var} ${text}`, (t) => {
            const ch = this.store.set(action.var, value, this.clock.now());
            if (ch) t.changed.push(ch);
          }, depth);
          trace.actions.push({ source: tag, detail: `${action.var} <- ${formatValue(value)}`, dryRun: false });
          return;
        }
        case 'scene': {
          const scene = this.config.scenes.get(action.scene)!;
          let count = 0;
          for (const target of scene.targets) {
            const dev = this.config.devices.get(target.device);
            if (!dev) continue;
            if (action.room && dev.room !== action.room) continue;
            this.setDevice(target.device, target.tokens, trace, `${tag} (${target.device})`);
            count++;
          }
          if (count === 0) trace.actions.push({ source: tag, detail: 'scene has no matching devices', dryRun: false });
          return;
        }
        case 'event':
          this.enqueue(`event ${action.name}`, (t) => {
            const ch = this.store.set('event', action.name, this.clock.now());
            if (ch) t.changed.push(ch);
          }, depth);
          trace.actions.push({ source: tag, detail: `event ${action.name}`, dryRun: false });
          return;
        case 'start':
          this.startSequence(action.sequence, action.unlessRunning, trace, depth);
          return;
        case 'cancel':
          this.cancelSequence(action.sequence, trace, 'cancelled by action');
          return;
        case 'notify': {
          const text = this.render(action.text);
          this.publish('home/notify', text, false, trace, tag, `notify "${text}"`);
          return;
        }
        case 'log':
          trace.actions.push({ source: tag, detail: `log "${this.render(action.text)}"`, dryRun: false });
          return;
        case 'script':
          if (!this.scripts) {
            trace.actions.push({ source: tag, detail: `script ${action.file}`, dryRun: this.dryRun, error: 'no script runner configured' });
            return;
          }
          trace.actions.push({ source: tag, detail: `script ${action.file} ${action.args.join(' ')}`.trim(), dryRun: this.dryRun });
          if (!this.dryRun) void this.scripts.run(action.file, action.args, this);
          return;
      }
    } catch (e) {
      trace.actions.push({ source: tag, detail: action.source, dryRun: this.dryRun, error: (e as Error).message });
    }
  }

  private render(tokens: ActionToken[]): string {
    return tokens
      .map((t) => {
        if (t.kind === 'text') return t.text;
        const v = formula.evaluate(t.ast, this.evalContext());
        if (typeof v === 'string') return v;
        return formatValue(v);
      })
      .join('');
  }

  private setDevice(deviceId: string, tokens: string[], trace: Trace, tag: string): void {
    const dev = this.config.devices.get(deviceId);
    if (!dev) throw new Error(`unknown device ${deviceId}`);
    const targets = parseTargets(tokens.flatMap((t) => t.split(/\s+/)).filter(Boolean));
    const payload = dev.kind.toPayload(targets, (prop) => this.store.get(`${dev.id}.${prop}`));
    const topic = dev.source.type === 'z2m' ? `${this.z2mBase()}/${dev.source.friendly}/set` : `${dev.source.topic}/set`;
    if (!this.rateOk(dev.id)) {
      trace.actions.push({ source: tag, detail: `set ${dev.id} ${tokens.join(' ')}`, topic, dryRun: this.dryRun, error: `rate guard: more than ${RATE_MAX} commands to ${dev.id} in ${RATE_WINDOW_MS / 1000}s, dropped` });
      return;
    }
    this.publish(topic, JSON.stringify(payload), false, trace, tag, `set ${dev.id} ${tokens.join(' ')}`);
  }

  private publish(topic: string, payload: string, retain: boolean, trace: Trace, source: string, detail: string): void {
    trace.actions.push({ source, detail, topic, payload, dryRun: this.dryRun });
    if (!this.dryRun) this.transport.publish(topic, payload, { retain });
  }

  private rateOk(deviceId: string): boolean {
    const now = this.clock.now();
    const log = (this.rateLog.get(deviceId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (log.length >= RATE_MAX) {
      this.rateLog.set(deviceId, log);
      return false;
    }
    log.push(now);
    this.rateLog.set(deviceId, log);
    return true;
  }

  // ---- sequences --------------------------------------------------------------------------

  private startSequence(id: string, unlessRunning: boolean, trace: Trace, depth: number): void {
    const def = this.config.sequences.get(id);
    if (!def) throw new Error(`unknown sequence ${id}`);
    const existing = this.sequences.get(id);
    if (existing) {
      if (unlessRunning) {
        trace.sequences.push({ id, event: 'waiting', step: existing.next + 1, reason: 'already running, left alone' });
        return;
      }
      this.cancelSequence(id, trace, 'restarted');
    }
    const inst: SequenceInstance = { id, next: 0, startedAt: this.clock.now(), timer: null, dueAt: null };
    this.sequences.set(id, inst);
    trace.sequences.push({ id, event: 'started' });
    this.scheduleStep(inst, def, trace, depth);
  }

  /** Runs the step at inst.next if it is due now (after = 0) or arms its timer. */
  private scheduleStep(inst: SequenceInstance, def: SequenceDef, trace: Trace, depth: number): void {
    if (inst.next >= def.steps.length) {
      this.sequences.delete(inst.id);
      trace.sequences.push({ id: inst.id, event: 'finished' });
      return;
    }
    const step = def.steps[inst.next]!;
    if (step.afterMs === 0) {
      this.runStep(inst, def, trace, depth);
      return;
    }
    inst.dueAt = this.clock.now() + step.afterMs;
    trace.sequences.push({ id: inst.id, event: 'waiting', step: step.step, reason: `in ${step.afterMs / 1000}s` });
    inst.timer = this.clock.setTimer(inst.dueAt, () => {
      inst.timer = null;
      if (this.sequences.get(inst.id) !== inst) return;
      this.enqueue(`sequence ${inst.id} step ${step.step}`, (t) => this.runStep(inst, def, t, 0));
    });
  }

  private runStep(inst: SequenceInstance, def: SequenceDef, trace: Trace, depth: number): void {
    const step = def.steps[inst.next];
    if (!step) {
      this.sequences.delete(inst.id);
      trace.sequences.push({ id: inst.id, event: 'finished' });
      return;
    }
    inst.timer = null;
    inst.dueAt = null;
    trace.sequences.push({ id: inst.id, event: 'step', step: step.step });
    if (step.action) this.execute(step.action, trace, depth + 1, `sequence ${inst.id} step ${step.step}`);
    inst.next++;
    this.scheduleStep(inst, def, trace, depth);
  }

  private cancelSequence(id: string, trace: Trace, reason: string): void {
    const inst = this.sequences.get(id);
    if (!inst) {
      trace.sequences.push({ id, event: 'cancelled', reason: 'was not running' });
      return;
    }
    if (inst.timer !== null) this.clock.clear(inst.timer);
    this.sequences.delete(id);
    trace.sequences.push({ id, event: 'cancelled', step: (this.config.sequences.get(id)?.steps[inst.next]?.step ?? inst.next + 1), reason });
  }

  // ---- evaluation -------------------------------------------------------------------------

  private evalContext(): EvalContext {
    const tz = this.config.timezone;
    return {
      get: (ref) => this.store.get(ref),
      prev: (ref) => this.store.prev(ref),
      changed: (ref) => this.store.changed(ref),
      since: (ref, value) => this.store.since(ref, this.clock.now(), value),
      now: () => this.clock.now(),
      tz,
      sunrise: (ms) => this.sun.sunrise(ms, localParts(ms, tz).midnightMs),
      sunset: (ms) => this.sun.sunset(ms, localParts(ms, tz).midnightMs),
    };
  }

  private safeEval(ast: Ast, trace: Trace, what: string): Value {
    try {
      return formula.evaluate(ast, this.evalContext());
    } catch (e) {
      trace.errors.push(`${what}: ${e instanceof FormulaError ? e.message : String(e)}`);
      return null;
    }
  }

  /** Evaluates every derived cell and every rule condition without firing anything. */
  private baseline(): void {
    const trace: Trace = { cause: 'baseline', at: this.clock.now(), changed: [], derived: [], rules: [], actions: [], sequences: [], errors: [] };
    this.store.beginPass();
    const now = this.clock.now();
    for (const id of this.graph.topo) {
      const def = this.config.derived.get(id)!;
      const ch = this.store.set(id, this.safeEval(def.formula, trace, `derived ${id}`), now);
      if (ch) trace.derived.push(ch);
    }
    for (const rule of this.config.rules) {
      if (rule.trigger.kind === 'edge' && rule.condition) this.lastCond.set(rule.id, this.safeEval(rule.condition, trace, `rule ${rule.id}`));
    }
    this.store.endPass();
    if (trace.errors.length) this.emit(trace);
  }

  // ---- transport wiring -------------------------------------------------------------------

  private z2mBase(): string {
    return settingString(this.config, 'z2m_base', 'zigbee2mqtt');
  }

  private indexTopics(): void {
    this.topicToDevice.clear();
    for (const dev of this.config.devices.values()) this.topicToDevice.set(this.stateTopic(dev), dev);
  }

  stateTopic(dev: DeviceDef): string {
    return dev.source.type === 'z2m' ? `${this.z2mBase()}/${dev.source.friendly}` : dev.source.topic;
  }

  private subscribeAll(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    this.transport.subscribe(`${this.z2mBase()}/+`, (t, p) => this.handleMessage(t, p));
    this.transport.subscribe(`${this.z2mBase()}/+/availability`, (t, p) => this.handleMessage(t, p));
    const bases = new Set<string>();
    for (const dev of this.config.devices.values()) if (dev.source.type === 'mqtt') bases.add(dev.source.topic.split('/')[0] ?? '');
    for (const b of bases) if (b) this.transport.subscribe(`${b}/#`, (t, p) => this.handleMessage(t, p));
  }

  // ---- timers -----------------------------------------------------------------------------

  private armTimers(): void {
    for (const h of this.timers) this.clock.clear(h);
    this.timers = [];
    if (!this.timersEnabled) return;
    const needsTick = this.graph.timeDependent.length > 0 || this.config.rules.some((r) => r.conditionTimeDependent) || [...this.config.sequences.values()].some((s) => s.cancelIf || s.steps.some((st) => st.cancelIf));
    if (needsTick) this.timers.push(this.clock.setInterval(1000, () => this.enqueue('tick', () => undefined)));
    this.timers.push(this.clock.setInterval(60_000, () => this.updateSun(true)));
    for (const rule of this.config.rules) if (rule.enabled && rule.trigger.kind === 'at') this.armAtRule(rule);
  }

  private updateSun(asPass: boolean): void {
    const now = this.clock.now();
    const parts = localParts(now, this.config.timezone);
    const elevation = Math.round(this.sun.elevation(now) * 100) / 100;
    const azimuth = Math.round(this.sun.azimuth(now) * 10) / 10;
    const changes = [
      { cell: 'sun.elevation', value: elevation as Value },
      { cell: 'sun.azimuth', value: azimuth as Value },
      { cell: 'sun.up', value: (now >= this.sun.sunrise(now, parts.midnightMs) && now < this.sun.sunset(now, parts.midnightMs)) as Value },
    ];
    if (asPass) this.applyInputs(changes, 'sun');
    else for (const c of changes) this.store.set(c.cell, c.value, now);
  }

  /** Next epoch ms strictly after `fromMs` at which the schedule time occurs on an allowed day. */
  nextOccurrence(time: ScheduleTime, days: Set<number>, fromMs: number): number {
    const tz = this.config.timezone;
    let parts = localParts(fromMs, tz);
    for (let i = 0; i < 400; i++) {
      const midnight = parts.midnightMs;
      let at: number;
      if (time.kind === 'clock') at = midnight + time.msSinceMidnight;
      else at = (time.event === 'sunrise' ? this.sun.sunrise(midnight + 43_200_000, midnight) : this.sun.sunset(midnight + 43_200_000, midnight)) + time.offsetMs;
      // Clock times are wall-clock: re-derive through the tz so DST shifts land on the right instant.
      if (time.kind === 'clock') {
        const guess = midnight + time.msSinceMidnight;
        const gp = localParts(guess, tz);
        at = guess - (gp.msSinceMidnight - time.msSinceMidnight);
      }
      if (at > fromMs && days.has(localParts(at, tz).weekday)) return at;
      parts = localParts(midnight + 36 * 3_600_000, tz); // move to next local day
      parts = localParts(parts.midnightMs, tz);
    }
    throw new Error('no occurrence found within 400 days');
  }

  private armAtRule(rule: RuleDef): void {
    if (rule.trigger.kind !== 'at') return;
    const trig = rule.trigger;
    const at = this.nextOccurrence(trig.time, trig.days, this.clock.now());
    const handle = this.clock.setTimer(at, () => {
      this.timers = this.timers.filter((h) => h !== handle);
      this.enqueue(`at ${trig.text} rule ${rule.id}`, (trace) => {
        const cond = rule.condition ? this.safeEval(rule.condition, trace, `rule ${rule.id}`) : true;
        const fire = cond === true;
        trace.rules.push({ id: rule.id, fired: fire, cond, reason: fire ? 'scheduled time' : `${rule.conditionSource} = ${formatValue(cond)}` });
        if (fire) this.fire(rule, trace, 1);
      });
      this.armAtRule(rule);
    });
    this.timers.push(handle);
  }

  /** Stops all timers (shutdown / tests). */
  dispose(): void {
    for (const h of this.timers) this.clock.clear(h);
    this.timers = [];
    for (const inst of this.sequences.values()) if (inst.timer !== null) this.clock.clear(inst.timer);
  }

  private emit(trace: Trace): void {
    for (const cb of this.traceListeners) cb(trace);
  }
}

function isQuietTick(cause: string, trace: Trace): boolean {
  if (cause !== 'tick' && cause !== 'sun') return false;
  return trace.changed.length === 0 && trace.derived.length === 0 && !trace.rules.some((r) => r.fired) && trace.actions.length === 0 && trace.sequences.length === 0 && trace.errors.length === 0;
}

