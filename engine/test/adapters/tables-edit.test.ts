import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveTable, validateTable } from '../../src/adapters/tables-edit.js';

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'pioneer-edit-'));
  writeFileSync(join(d, 'settings.tsv'), 'key\tvalue\ntimezone\tEurope/Stockholm\n');
  writeFileSync(join(d, 'devices.tsv'), 'id\troom\tkind\tsource\nhall.light\thall\tlight\tz2m:Hall\n');
  writeFileSync(join(d, 'rules.tsv'), 'id\twhen\tif\tthen\n');
  return d;
}

describe('saveTable', () => {
  it('rejects an edit that breaks the configuration and leaves the file untouched', () => {
    const d = dir();
    const res = saveTable(d, 'rules.tsv', 'id\twhen\tif\tthen\nbad\t\thall.ligth\tset hall.light on\n', { git: false });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0]).toMatchObject({ file: 'rules.tsv', line: 2 });
    expect(readFileSync(join(d, 'rules.tsv'), 'utf8')).toBe('id\twhen\tif\tthen\n');
  });

  it('normalises and writes a valid edit', () => {
    const d = dir();
    const res = saveTable(d, 'rules.tsv', 'id\twhen\tif\tthen  \r\non\t\thall.light\tset hall.light on\t\t\r\n', { git: false });
    expect(res.ok).toBe(true);
    expect(readFileSync(join(d, 'rules.tsv'), 'utf8')).toBe('id\twhen\tif\tthen\non\t\thall.light\tset hall.light on\n');
  });

  it('refuses unknown files and validates without writing', () => {
    const d = dir();
    expect(saveTable(d, 'passwd', 'x', { git: false }).ok).toBe(false);
    expect(saveTable(d, 'notes.tsv', 'x', { git: false }).ok).toBe(false);
    expect(validateTable(d, 'devices.tsv', 'id\troom\tkind\tsource\nx\thall\tnope\tz2m:X\n')[0]?.message).toMatch(/unknown kind/);
    expect(readFileSync(join(d, 'devices.tsv'), 'utf8')).toContain('hall.light');
  });
});
