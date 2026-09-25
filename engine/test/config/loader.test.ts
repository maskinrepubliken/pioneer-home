import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseDays, parseScheduleTime, parseTrigger } from '../../src/config/loader.js';
import { parseTsv } from '../../src/config/tsv.js';

const EXAMPLE_TABLES = resolve(__dirname, '../../../example/tables');

function tablesDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pioneer-tables-'));
  const base: Record<string, string> = {
    'settings.tsv': 'key\tvalue\ntimezone\tEurope/Stockholm\nlatitude\t59.3\nlongitude\t18.1\n',
    'devices.tsv': 'id\troom\tkind\tsource\nhall.light\thall\tlight\tz2m:Hall\nhall.motion\thall\tmotion\tz2m:Motion\n',
  };
  for (const [name, text] of Object.entries({ ...base, ...files })) writeFileSync(join(dir, name), text);
  return dir;
}

describe('tsv reader', () => {
  it('ignores comments and blank lines, matches columns by header, tolerates missing trailing cells', () => {
    const t = parseTsv('# comment\n\nid\tformula\tnote\na\t1 + 1\n\nb\t2\tnoted\n', 'x.tsv');
    expect(t.header).toEqual(['id', 'formula', 'note']);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]).toEqual({ line: 4, cells: { id: 'a', formula: '1 + 1', note: '' } });
    expect(t.rows[1]?.cells['note']).toBe('noted');
  });
});

describe('small parsers', () => {
  it('parses day sets', () => {
    expect([...parseDays('mon-fri')!]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseDays('sat-sun')!]).toEqual([6, 7]);
    expect([...parseDays('mon,wed,fri')!]).toEqual([1, 3, 5]);
    expect([...parseDays('fri-mon')!].sort()).toEqual([1, 5, 6, 7]);
    expect(parseDays('daily')!.size).toBe(7);
    expect(parseDays('monday')).toBeNull();
  });
  it('parses schedule times', () => {
    expect(parseScheduleTime('06:30')).toEqual({ kind: 'clock', msSinceMidnight: 6.5 * 3_600_000 });
    expect(parseScheduleTime('sunset-30m')).toEqual({ kind: 'sun', event: 'sunset', offsetMs: -1_800_000 });
    expect(parseScheduleTime('sunrise+1h')).toEqual({ kind: 'sun', event: 'sunrise', offsetMs: 3_600_000 });
    expect(parseScheduleTime('noon')).toBeNull();
  });
  it('parses triggers', () => {
    expect(parseTrigger('')).toEqual({ kind: 'edge' });
    expect(parseTrigger('on hall.motion')).toEqual({ kind: 'change', cell: 'hall.motion' });
    expect(parseTrigger('on event')).toEqual({ kind: 'event' });
    const at = parseTrigger('at 08:00 mon-fri');
    expect(at?.kind).toBe('at');
    expect(parseTrigger('at sunset-30m')?.kind).toBe('at');
    expect(parseTrigger('at noonish')).toBeNull();
    expect(parseTrigger('when x')).toBeNull();
  });
});

describe('loadConfig', () => {
  it('loads the example tables without errors', () => {
    const res = loadConfig(EXAMPLE_TABLES);
    if (!res.ok) throw new Error(res.errors.map((e) => `${e.file}:${e.line}: ${e.message}`).join('\n'));
    expect(res.config.devices.size).toBeGreaterThanOrEqual(11);
    expect(res.config.aliases.get('fan')).toBe('fan.level');
    expect(res.config.cells.get('fan_target')?.type).toBe('number');
    expect(res.config.rooms.get('living_room')?.name).toBe('living room');
    expect(res.config.cells.get('motion1.room_name')?.type).toBe('string');
    expect(res.config.cells.get('night_window')?.type).toBe('boolean');
    expect(res.config.rules.find((r) => r.id === 'fan_follow')?.trigger).toEqual({ kind: 'change', cell: 'fan_wanted' });
    expect(res.config.history.find((h) => h.record === 'climate_1')?.fields).toHaveLength(4);
  });

  it('reports unknown cells with file and line', () => {
    const dir = tablesDir({ 'derived.tsv': 'id\tformula\ndark\thall.ligth = TRUE\n' });
    const res = loadConfig(dir);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0]).toMatchObject({ file: 'derived.tsv', line: 2, column: 'formula' });
    expect(res.errors[0]?.message).toMatch(/hall\.ligth/);
  });

  it('detects dependency cycles between derived cells', () => {
    const dir = tablesDir({ 'derived.tsv': 'id\tformula\na\tNOT(b)\nb\tNOT(a)\n' });
    const res = loadConfig(dir);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.some((e) => /cycle/.test(e.message))).toBe(true);
  });

  it('rejects an edge rule without a condition and a rule referring to an unknown scene', () => {
    const dir = tablesDir({ 'rules.tsv': 'id\twhen\tif\tthen\nnocond\t\t\tset hall.light on\nbadscene\ton hall.motion\t\tscene nope\n' });
    const res = loadConfig(dir);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.map((e) => e.message).join('\n')).toMatch(/needs an "if"/);
    expect(res.errors.map((e) => e.message).join('\n')).toMatch(/unknown scene "nope"/);
  });

  it('types derived cells in dependency order even when defined out of order', () => {
    const dir = tablesDir({ 'derived.tsv': 'id\tformula\nb\ta + 1\na\t2 * 3\n' });
    const res = loadConfig(dir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.derived.get('b')?.type).toBe('number');
  });

  it('rejects a non-boolean rule condition and a bad scene target', () => {
    const dir = tablesDir({
      'rules.tsv': 'id\twhen\tif\tthen\nr\t\thall.light.brightness + 1\tset hall.light on\n',
      'scenes.tsv': 'device\tevening\nhall.motion\ton\n',
    });
    const res = loadConfig(dir);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const msgs = res.errors.map((e) => `${e.file}:${e.line} ${e.message}`).join('\n');
    expect(msgs).toMatch(/rules.tsv:2 .*TRUE\/FALSE/);
    expect(msgs).toMatch(/scenes.tsv:2 .*read-only/);
  });
});

describe('rooms', () => {
  it('rejects a device in a room that rooms.tsv does not know, and exposes room cells', () => {
    const dir = tablesDir({ 'rooms.tsv': 'id\tname\nhall\tHallen\n', 'devices.tsv': 'id\troom\tkind\tsource\nlamp1\tkitchen\tlight\tz2m:LAMP1\n' });
    const res = loadConfig(dir);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0]?.message).toMatch(/unknown room "kitchen"/);
    const ok = loadConfig(tablesDir({ 'rooms.tsv': 'id\tname\nhall\tHallen\n', 'devices.tsv': 'id\troom\tkind\tsource\nlamp1\thall\tlight\tz2m:LAMP1\n' }));
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.config.cells.get('lamp1.room')?.type).toBe('string');
  });
});
