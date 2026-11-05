/**
 * week.tsv, the heating's week schedule, for the editor on the Program page: the modes of every hour of the week.
 * Pure functions, no Svelte. Mirrors engine/src/core/schedule.ts: columns `hour` (0-23) and mon..sun, one mode id per
 * cell, or several (a transition), separated by spaces.
 */
import { parseTsv } from './tsv';

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const DAY_NAMES = ['mån', 'tis', 'ons', 'tor', 'fre', 'lör', 'sön'];

/** [day 0..6, Monday first][hour 0..23] -> mode ids */
export type WeekGrid = string[][][];

export function emptyGrid(): WeekGrid {
  return DAYS.map(() => Array.from({ length: 24 }, () => [] as string[]));
}

export function parseWeek(text: string): WeekGrid {
  const grid = emptyGrid();
  const t = parseTsv(text);
  const hourCol = t.header.indexOf('hour');
  if (hourCol < 0) return grid;
  for (const row of t.rows) {
    const h = Number(row[hourCol]);
    if (!Number.isInteger(h) || h < 0 || h > 23) continue;
    DAYS.forEach((d, i) => {
      const col = t.header.indexOf(d);
      const cell = col < 0 ? '' : (row[col] ?? '');
      grid[i]![h] = cell.split(/[\s,+]+/).map((m) => m.trim().toLowerCase()).filter(Boolean);
    });
  }
  return grid;
}

/** The table text for a grid, keeping the comment lines of `previous` above the header. */
export function serializeWeek(grid: WeekGrid, previous = ''): string {
  const comments = parseTsv(previous).comments;
  const lines = [...comments, ['hour', ...DAYS].join('\t')];
  for (let h = 0; h < 24; h++) lines.push([String(h).padStart(2, '0'), ...DAYS.map((_, i) => grid[i]![h]!.join(' '))].join('\t'));
  return lines.join('\n') + '\n';
}

/** Day index (Monday 0) and hour of a moment, in the browser's time zone (the house's, in practice). */
export function slotOf(ms: number): { day: number; hour: number } {
  const d = new Date(ms);
  return { day: (d.getDay() + 6) % 7, hour: d.getHours() };
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((m) => b.includes(m));

/** The next hour (within a week) whose modes differ from now's: when, and its modes. */
export function nextChange(grid: WeekGrid, nowMs: number): { at: number; modes: string[] } | null {
  const { day, hour } = slotOf(nowMs);
  const current = grid[day]![hour]!;
  const startOfHour = new Date(nowMs);
  startOfHour.setMinutes(0, 0, 0);
  for (let k = 1; k <= 7 * 24; k++) {
    const at = new Date(startOfHour.getTime());
    at.setHours(at.getHours() + k);
    const s = slotOf(at.getTime());
    const modes = grid[s.day]![s.hour]!;
    if (!same(modes, current)) return { at: at.getTime(), modes };
  }
  return null;
}
