import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/loader.js';
import { modesInSlot, slotKey, type WeekSchedule } from '../../src/core/schedule.js';

describe('week schedule', () => {
  const week: WeekSchedule = {
    modes: ['home', 'sleep'],
    slots: new Map([
      [slotKey(1, 18), ['home']],
      [slotKey(1, 19), ['sleep']],
      [slotKey(1, 20), ['sleep']],
      [slotKey(7, 23), ['home']],
      [slotKey(1, 0), ['sleep']],
      [slotKey(2, 5), ['home', 'sleep']],
    ]),
  };
  it('makes the first hour of a new mode a transition with the one before', () => {
    expect(modesInSlot(week, slotKey(1, 18))).toEqual(['home']);
    expect(modesInSlot(week, slotKey(1, 19))).toEqual(['home', 'sleep']);
    expect(modesInSlot(week, slotKey(1, 20))).toEqual(['sleep']);
  });
  it('wraps from Sunday 23 to Monday 00', () => {
    expect(modesInSlot(week, slotKey(1, 0))).toEqual(['home', 'sleep']);
  });
  it('keeps an hour with no mode, or with two given, as it is', () => {
    expect(modesInSlot(week, slotKey(3, 12))).toEqual([]);
    expect(modesInSlot(week, slotKey(2, 5))).toEqual(['home', 'sleep']);
  });
});

describe('modes.tsv', () => {
  const dir = (files: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), 'pioneer-modes-'));
    const base: Record<string, string> = {
      'settings.tsv': 'key\tvalue\ntimezone\tEurope/Stockholm\nlatitude\t57\nlongitude\t12\n',
      'rooms.tsv': 'id\tname\nliving_room\tliving room\n',
      'devices.tsv': 'id\troom\tkind\tsource\n',
      'cells.tsv': 'id\tformula\tinitial\ttype\nheat_cold\t12\t\t\nheat_overlap_slack\t1\t\t\nheat_mode\t\tprogram\tstring\n',
    };
    for (const [f, t] of Object.entries({ ...base, ...files })) writeFileSync(join(d, f), t);
    return d;
  };
  it('compiles each mode to heat_use_<mode>, <room>_<mode>, and the room comfort', () => {
    const res = loadConfig(dir({ 'modes.tsv': 'id\tname\tliving_room\nhome\tHemma\t18\nsleep\tSova\t\n' }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const id of ['heat_use_home', 'heat_use_sleep', 'living_room_home', 'living_room_sleep', 'heat_transition', 'living_room_comfort']) expect(res.config.derived.has(id)).toBe(true);
    expect(res.config.cells.has('week.home')).toBe(true);
    expect(res.config.derived.get('living_room_sleep')!.source).toBe('heat_cold');
  });
  it('reads until (how long a mode holds when chosen) as a column of its own, not a room', () => {
    const ok = loadConfig(dir({ 'modes.tsv': 'id\tname\tuntil\tliving_room\nhome\tHemma\ttoday\t18\naway\tBorta\t\t\n' }));
    expect(ok.ok).toBe(true);
    const bad = loadConfig(dir({ 'modes.tsv': 'id\tname\tuntil\tliving_room\nhome\tHemma\tforever\t18\n' }));
    expect(bad.ok ? '' : bad.errors.map((e) => e.message).join('\n')).toContain('until must be none, today or tomorrow');
  });
  it('refuses a room column that is not a room, and a mode the week does not know', () => {
    const bad = loadConfig(dir({ 'modes.tsv': 'id\tname\tkitchen\nhome\tHemma\t18\n', 'week.tsv': 'hour\tmon\n07\tparty\n' }));
    expect(bad.ok).toBe(false);
    const messages = bad.ok ? [] : bad.errors.map((e) => e.message).join('\n');
    expect(messages).toContain('column "kitchen" is not a room');
    expect(messages).toContain('unknown mode "party"');
  });
});
