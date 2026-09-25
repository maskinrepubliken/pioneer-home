/**
 * Renders engine traces as the compact text an agent (or a human) reads in the CLI and the UI.
 */
import { localParts } from '../formula/time.js';
import { formatValue } from '../formula/values.js';
import type { Trace } from '../core/engine.js';

export function formatClockTime(epochMs: number, tz: string): string {
  const p = localParts(epochMs, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

export function formatDateTime(epochMs: number, tz: string): string {
  const p = localParts(epochMs, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

export function formatTrace(t: Trace, tz: string, opts: { showQuietRules?: boolean } = {}): string {
  const lines: string[] = [`${formatClockTime(t.at, tz)} ${t.cause}`];
  const col = (s: string, w: number) => s.padEnd(w);
  for (const c of t.changed) lines.push(`  ${col('changed', 8)} ${col(c.cell, 30)} ${formatValue(c.from)} -> ${formatValue(c.to)}`);
  for (const c of t.derived) lines.push(`  ${col('derived', 8)} ${col(c.cell, 30)} ${formatValue(c.from)} -> ${formatValue(c.to)}`);
  for (const r of t.rules) {
    if (!r.fired && !opts.showQuietRules) continue;
    lines.push(`  ${col('rule', 8)} ${col(r.id, 30)} ${r.fired ? 'FIRED' : '-'}  ${r.reason}`);
  }
  for (const a of t.actions) {
    const where = a.topic ? ` -> ${a.topic} ${a.payload ?? ''}`.trimEnd() : '';
    const flag = a.error ? `  ERROR ${a.error}` : a.dryRun ? '  (dry run)' : '';
    lines.push(`  ${col('action', 8)} ${a.detail}${where}${flag}`);
  }
  for (const s of t.sequences) {
    const step = s.step !== undefined ? ` step ${s.step}` : '';
    lines.push(`  ${col('seq', 8)} ${s.id} ${s.event}${step}${s.reason ? `: ${s.reason}` : ''}`);
  }
  for (const e of t.errors) lines.push(`  ${col('error', 8)} ${e}`);
  return lines.join('\n');
}

export function summarize(traces: Trace[]): string {
  const fired = traces.reduce((n, t) => n + t.rules.filter((r) => r.fired).length, 0);
  const actions = traces.reduce((n, t) => n + t.actions.length, 0);
  const errors = traces.reduce((n, t) => n + t.errors.length + t.actions.filter((a) => a.error).length, 0);
  return `summary: ${traces.length} passes, ${fired} rules fired, ${actions} actions, ${errors} errors`;
}
