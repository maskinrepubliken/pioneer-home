/**
 * Runs scenario tables (scenarios/*.tsv) against the simulator.
 *
 * Columns: step | at | do | expect | note
 *   at      absolute "2026-09-23T21:00" (wall time in the configured tz) or "+5m" to advance the clock
 *   do      set <cell> <value> | event <name> | mqtt <topic> <json> | action <action text> | enable <rule...> | disable <rule...>
 *   expect  one or more, separated by ";":
 *             sent <device> [k=v ...]     a /set command to the device carrying these fields was published this step
 *             nothing sent                no /set command was published this step
 *             fired <rule> | not fired <rule>
 *             running <sequence> | not running <sequence>
 *             bedroom.auto = FALSE  (or any formula that must evaluate to TRUE)
 * The clock advance happens first, then `do`, then every `expect` is checked against what happened in the step.
 */
import { basename } from 'node:path';
import { readTsv } from '../config/tsv.js';
import type { Config } from '../config/model.js';
import type { Trace } from '../core/engine.js';
import { formula } from '../formula/index.js';
import { parseDuration, formatValue } from '../formula/values.js';
import { Simulator, parseWhen } from './simulator.js';
import { formatTrace } from './trace.js';
import { splitActions, tokenize } from '../config/actions.js';

export interface ScenarioFailure {
  line: number;
  step: string;
  message: string;
}

export interface ScenarioResult {
  file: string;
  steps: number;
  failures: ScenarioFailure[];
  trace: string;
}

export function runScenario(config: Config, path: string): ScenarioResult {
  const table = readTsv(path, basename(path));
  const failures: ScenarioFailure[] = [];
  const traceLines: string[] = [];
  let sim: Simulator | null = null;
  let tracesSeen = 0;

  const flushTraces = (label: string) => {
    if (!sim) return;
    const fresh = sim.traces.slice(tracesSeen);
    if (fresh.length) traceLines.push(`--- ${label}`);
    for (const t of fresh) traceLines.push(formatTrace(t, config.timezone));
    tracesSeen = sim.traces.length;
  };

  for (const row of table.rows) {
    const step = row.cells['step'] || String(row.line);
    const at = row.cells['at'] ?? '';
    const doText = row.cells['do'] ?? '';
    const expectText = row.cells['expect'] ?? '';
    const fail = (message: string) => failures.push({ line: row.line, step, message });

    let first = false;
    if (!sim) {
      first = true;
      if (!at || at.startsWith('+')) {
        fail('the first row must have an absolute time in "at", e.g. 2026-09-23T21:00');
        return { file: table.file, steps: 0, failures, trace: traceLines.join('\n') };
      }
      sim = new Simulator(config, { at: parseWhen(at, config.timezone) });
      // Let the baseline settle; nothing should have been published.
      tracesSeen = sim.traces.length;
    }
    // Capture before advancing: timers firing during the advance belong to this step.
    const publishedBefore = sim.published().length;
    const tracesBefore = sim.traces.length;
    if (at && !first) {
      try {
        if (at.startsWith('+')) {
          const d = parseDuration(at.slice(1).trim());
          if (!d) throw new Error(`bad duration "${at}"`);
          sim.advance(d.ms);
        } else {
          sim.advanceTo(parseWhen(at, config.timezone));
        }
      } catch (e) {
        fail((e as Error).message);
        continue;
      }
    }

    if (doText) {
      try {
        runCommand(sim, doText);
      } catch (e) {
        fail(`do "${doText}": ${(e as Error).message}`);
      }
    }

    const stepPublished = sim.published(publishedBefore);
    const stepTraces: Trace[] = sim.traces.slice(tracesBefore);
    flushTraces(`step ${step}${at ? ` at ${at}` : ''}${doText ? `: ${doText}` : ''}`);

    for (const exp of splitActions(expectText)) {
      const problem = checkExpectation(sim, exp, stepPublished.map((m) => ({ topic: m.topic, payload: m.payload })), stepTraces);
      if (problem) fail(`expected "${exp}": ${problem}`);
    }
  }

  return { file: table.file, steps: table.rows.length, failures, trace: traceLines.join('\n') };
}

function runCommand(sim: Simulator, text: string): void {
  const tokens = tokenize(text);
  const verb = (tokens[0] ?? '').toLowerCase();
  switch (verb) {
    case 'set': {
      if (tokens.length < 3) throw new Error('set <cell> <value>');
      sim.set(tokens[1]!, tokens.slice(2).join(' '));
      return;
    }
    case 'event':
      if (!tokens[1]) throw new Error('event <name>');
      sim.event(tokens[1]);
      return;
    case 'mqtt': {
      if (tokens.length < 3) throw new Error('mqtt <topic> <json>');
      sim.mqtt(tokens[1]!, text.slice(text.indexOf(tokens[1]!) + tokens[1]!.length).trim());
      return;
    }
    case 'action':
      sim.action(text.slice(6).trim());
      return;
    case 'enable':
    case 'disable':
      for (const id of tokens.slice(1)) {
        if (!sim.engine.setRuleEnabled(id, verb === 'enable')) throw new Error(`unknown rule "${id}"`);
      }
      return;
    default:
      throw new Error(`unknown command "${verb}" (set, event, mqtt, action, enable, disable)`);
  }
}

function checkExpectation(sim: Simulator, exp: string, published: { topic: string; payload: string }[], traces: Trace[]): string | null {
  const t = exp.trim();
  const lower = t.toLowerCase();
  const sets = published.filter((m) => m.topic.endsWith('/set'));

  if (lower === 'nothing sent') {
    return sets.length === 0 ? null : `these were sent: ${sets.map((m) => `${m.topic} ${m.payload}`).join(' | ')}`;
  }
  let m = t.match(/^sent\s+(\S+)(?:\s+(.*))?$/i);
  if (m) {
    const device = sim.config.devices.get(m[1]!);
    if (!device) return `unknown device "${m[1]}"`;
    const topic = `${sim.engine.stateTopic(device)}/set`;
    const wanted = (m[2] ?? '').split(/\s+/).filter(Boolean).map((kv) => {
      const i = kv.indexOf('=');
      return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)];
    });
    const candidates = sets.filter((s) => s.topic === topic);
    if (!candidates.length) return `nothing was sent to ${m[1]}${sets.length ? ` (sent: ${sets.map((s) => `${s.topic} ${s.payload}`).join(' | ')})` : ''}`;
    for (const c of candidates) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(c.payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      const ok = wanted.every(([k, v]) => k !== undefined && k in payload && looselyEqual(payload[k], v ?? ''));
      if (ok) return null;
    }
    return `sent to ${m[1]} but not with ${m[2]}: ${candidates.map((c) => c.payload).join(' | ')}`;
  }
  m = t.match(/^(not\s+)?fired\s+(\S+)$/i);
  if (m) {
    const fired = traces.some((tr) => tr.rules.some((r) => r.id === m![2] && r.fired));
    if (m[1]) return fired ? `rule ${m[2]} fired` : null;
    return fired ? null : `rule ${m[2]} did not fire${describeRules(traces, m[2]!)}`;
  }
  m = t.match(/^(not\s+)?running\s+(\S+)$/i);
  if (m) {
    const running = sim.engine.isRunning(m[2]!);
    if (m[1]) return running ? `sequence ${m[2]} is running` : null;
    return running ? null : `sequence ${m[2]} is not running`;
  }
  // formula
  try {
    const ast = formula.parse(t);
    const v = sim.engine.evaluate(ast);
    if (v === true) return null;
    const refs = formula.refs(ast).map((r) => `${r} = ${formatValue(sim.get(r))}`);
    return `evaluates to ${formatValue(v)}${refs.length ? ` (${refs.join(', ')})` : ''}`;
  } catch (e) {
    return `cannot evaluate: ${(e as Error).message}`;
  }
}

function describeRules(traces: Trace[], id: string): string {
  const seen = traces.flatMap((t) => t.rules.filter((r) => r.id === id));
  if (!seen.length) return ' (it was not evaluated in this step)';
  return ` (${seen.map((r) => r.reason).join('; ')})`;
}

function looselyEqual(actual: unknown, wanted: string): boolean {
  if (actual === null || actual === undefined) return wanted === '' || wanted.toLowerCase() === 'null';
  if (typeof actual === 'object') return JSON.stringify(actual) === wanted || JSON.stringify(actual).toLowerCase().includes(wanted.toLowerCase());
  const a = String(actual);
  if (a === wanted) return true;
  if (a.toLowerCase() === wanted.toLowerCase()) return true;
  const na = Number(a);
  const nw = Number(wanted);
  return !Number.isNaN(na) && !Number.isNaN(nw) && Math.abs(na - nw) < 1e-9;
}
