#!/usr/bin/env node
/**
 * `home` command line: validate tables, simulate, run scenarios, evaluate formulas, format tables.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { loadConfig } from './config/loader.js';
import { formatConfigError } from './config/errors.js';
import { normaliseTsvText } from './config/tsv.js';
import { formula } from './formula/index.js';
import { parseDuration, formatValue } from './formula/values.js';
import { Simulator, parseWhen } from './sim/simulator.js';
import { runScenario } from './sim/scenario.js';
import { formatDateTime, formatTrace, summarize } from './sim/trace.js';

const program = new Command();
program.name('home').description('pioneer-home: the home as a spreadsheet').version('0.1.0');

const tablesOpt = (cmd: Command) => cmd.option('-t, --tables <dir>', 'tables directory', defaultTablesDir());

function defaultTablesDir(): string {
  // Your own tables/ (gitignored) first, then the example config shipped with the repo.
  const roots = [resolve('.'), resolve('..'), resolve('../..')];
  for (const candidate of [...roots.map((r) => resolve(r, 'tables')), ...roots.map((r) => resolve(r, 'example', 'tables'))]) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* try next */
    }
  }
  return resolve('tables');
}

function load(dir: string) {
  const res = loadConfig(dir);
  for (const w of res.warnings) console.error(`warning: ${formatConfigError(w)}`);
  if (!res.ok) {
    for (const e of res.errors) console.error(formatConfigError(e));
    console.error(`\n${res.errors.length} error(s) in ${dir}`);
    process.exit(1);
  }
  return res.config;
}

tablesOpt(program.command('check').description('validate all tables')).action((opts: { tables: string }) => {
  const config = load(opts.tables);
  console.log(
    `ok: ${config.devices.size} devices, ${config.cells.size} cells, ${config.derived.size} derived, ${config.rules.length} rules, ${config.scenes.size} scenes, ${config.vars.size} held cells, ${config.sequences.size} sequences, ${config.history.length} history records`,
  );
});

tablesOpt(
  program
    .command('simulate')
    .description('run the engine against a fake clock and print the trace')
    .option('--at <time>', 'start time, e.g. 2026-09-23T21:00 (wall time in the configured tz)')
    .option('--set <cell=value...>', 'set cells before advancing (repeatable)', collect, [] as string[])
    .option('--event <name...>', 'dispatch events (repeatable)', collect, [] as string[])
    .option('--action <text...>', 'run actions (repeatable)', collect, [] as string[])
    .option('--advance <duration>', 'advance the clock afterwards, e.g. 10m')
    .option('--all-rules', 'also print rules that were evaluated but did not fire')
    .option('--json', 'print traces as JSON'),
).action((opts: { tables: string; at?: string; set: string[]; event: string[]; action: string[]; advance?: string; allRules?: boolean; json?: boolean }) => {
  const config = load(opts.tables);
  const at = opts.at ? parseWhen(opts.at, config.timezone) : Date.now();
  const sim = new Simulator(config, { at });
  console.log(`# start ${formatDateTime(at, config.timezone)} (${config.timezone})`);
  for (const s of opts.set) {
    const i = s.indexOf('=');
    if (i < 0) throw new Error(`--set expects cell=value, got "${s}"`);
    sim.set(s.slice(0, i), s.slice(i + 1));
  }
  for (const e of opts.event) sim.event(e);
  for (const a of opts.action) sim.action(a);
  if (opts.advance) {
    const d = parseDuration(opts.advance);
    if (!d) throw new Error(`bad duration "${opts.advance}"`);
    sim.advance(d.ms);
  }
  if (opts.json) console.log(JSON.stringify(sim.traces, null, 2));
  else for (const t of sim.traces) console.log(formatTrace(t, config.timezone, { showQuietRules: !!opts.allRules }));
  console.log(summarize(sim.traces));
});

tablesOpt(program.command('scenario').description('run scenario tables').argument('[files...]', 'scenario .tsv files or directories').option('-v, --verbose', 'print the trace of every scenario')).action(
  (files: string[], opts: { tables: string; verbose?: boolean }) => {
    const config = load(opts.tables);
    const paths = expandScenarioPaths(files.length ? files : [resolve(opts.tables, '..', 'scenarios')]);
    let failed = 0;
    for (const p of paths) {
      const r = runScenario(config, p);
      if (r.failures.length) {
        failed++;
        console.log(`FAIL ${r.file} (${r.failures.length} problem(s))`);
        for (const f of r.failures) console.log(`  ${r.file}:${f.line} step ${f.step}: ${f.message}`);
        console.log(r.trace.split('\n').map((l) => `    ${l}`).join('\n'));
      } else {
        console.log(`ok   ${r.file} (${r.steps} steps)`);
        if (opts.verbose) console.log(r.trace.split('\n').map((l) => `    ${l}`).join('\n'));
      }
    }
    console.log(`${paths.length - failed}/${paths.length} scenarios passed`);
    if (failed) process.exit(1);
  },
);

tablesOpt(
  program
    .command('eval')
    .description('evaluate a formula against the tables (with optional cell values)')
    .argument('<formula>')
    .option('--at <time>', 'clock time for TIME()/NOW()')
    .option('--set <cell=value...>', 'set cells first (repeatable)', collect, [] as string[]),
).action((src: string, opts: { tables: string; at?: string; set: string[] }) => {
  const config = load(opts.tables);
  const sim = new Simulator(config, { at: opts.at ? parseWhen(opts.at, config.timezone) : Date.now() });
  for (const s of opts.set) {
    const i = s.indexOf('=');
    sim.set(s.slice(0, i), s.slice(i + 1));
  }
  const ast = formula.parse(src);
  const check = formula.typeCheck(ast, (ref) => config.cells.get(config.aliases.get(ref) ?? ref)?.type);
  for (const e of check.errors) console.error(`type error: ${e.message}`);
  console.log(formatValue(sim.engine.evaluate(ast)));
});

tablesOpt(program.command('fmt').description('normalise TSV files in place (tabs, trimmed cells, LF)')).action((opts: { tables: string }) => {
  const dirs = [opts.tables, resolve(opts.tables, '..', 'scenarios')];
  let n = 0;
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.tsv'));
    } catch {
      continue;
    }
    for (const f of files) {
      const p = join(dir, f);
      const before = readFileSync(p, 'utf8');
      const after = normaliseTsvText(before);
      if (after !== before) {
        writeFileSync(p, after);
        console.log(`formatted ${p}`);
        n++;
      }
    }
  }
  console.log(n ? `${n} file(s) changed` : 'all tables already formatted');
});

tablesOpt(program.command('graph').description('print the dependency graph of derived cells and rules')).action((opts: { tables: string }) => {
  const config = load(opts.tables);
  for (const d of config.derived.values()) console.log(`${d.id}  <-  ${d.refs.join(', ') || '(constants)'}${d.timeDependent ? '  [time]' : ''}`);
  console.log('');
  for (const r of config.rules) {
    const trig = r.trigger.kind === 'edge' ? 'edge' : r.trigger.kind === 'change' ? `on ${r.trigger.cell}` : r.trigger.kind === 'event' ? 'on event' : 'at';
    console.log(`rule ${r.id}  [${trig}]  <-  ${r.conditionRefs.join(', ') || '(none)'}${r.enabled ? '' : '  (disabled)'}`);
  }
});

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function expandScenarioPaths(inputs: string[]): string[] {
  const out: string[] = [];
  for (const i of inputs) {
    const p = resolve(i);
    let st;
    try {
      st = statSync(p);
    } catch {
      console.error(`not found: ${p}`);
      process.exit(1);
    }
    if (st.isDirectory()) out.push(...readdirSync(p).filter((f) => f.endsWith('.tsv')).sort().map((f) => join(p, f)));
    else out.push(p);
  }
  return out;
}

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
