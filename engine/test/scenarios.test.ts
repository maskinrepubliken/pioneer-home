/**
 * Runs every scenarios/*.tsv against tables/ (your own, gitignored config), or example/ when there is none.
 * This is the behaviour test of the home itself:
 * change a rule, add or adjust a scenario row, run `just test`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/loader.js';
import { runScenario } from '../src/sim/scenario.js';

const ROOT = existsSync(resolve(__dirname, '../../tables')) ? resolve(__dirname, '../..') : resolve(__dirname, '../../example');
const TABLES = resolve(ROOT, 'tables');
const SCENARIOS = resolve(ROOT, 'scenarios');

const res = loadConfig(TABLES);
if (!res.ok) throw new Error(res.errors.map((e) => `${e.file}:${e.line}: ${e.message}`).join('\n'));
const config = res.config;

const files = readdirSync(SCENARIOS).filter((f) => f.endsWith('.tsv')).sort();

describe('scenarios', () => {
  it.each(files)('%s', (file) => {
    const r = runScenario(config, join(SCENARIOS, file));
    if (r.failures.length) {
      const msg = r.failures.map((f) => `${r.file}:${f.line} step ${f.step}: ${f.message}`).join('\n');
      throw new Error(`${msg}\n\n${r.trace}`);
    }
    expect(r.failures).toEqual([]);
  });
});
