/**
 * The week schedule (week.tsv): for every hour of the week, the heating modes in force. One mode is that mode;
 * two or more are a transition between them. The engine keeps a boolean system cell `week.<mode>` per mode on
 * the current hour, and the program planner reads the schedule ahead. Pure functions.
 */
import { localParts } from '../formula/time.js';

/** week.tsv's day columns, Monday first (ISO weekday 1..7). */
export const WEEKDAY_IDS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export interface WeekSchedule {
  /** every mode the schedule (or a heat_use_<mode> cell) knows, in first-seen order */
  modes: string[];
  /** (weekday - 1) * 24 + hour -> the modes in force that hour; an hour not in the table has none */
  slots: Map<number, string[]>;
}

export const EMPTY_SCHEDULE: WeekSchedule = { modes: [], slots: new Map() };

export function slotKey(weekday: number, hour: number): number {
  return (weekday - 1) * 24 + hour;
}

/** The modes in force at an instant, in the house's time zone. */
export function scheduleAt(s: WeekSchedule, epochMs: number, tz: string): string[] {
  const p = localParts(epochMs, tz);
  return s.slots.get(slotKey(p.weekday, p.hour)) ?? [];
}

/** The next local full hour after an instant (time zone offsets are whole hours here, so DST needs nothing more). */
export function nextHour(epochMs: number, tz: string): number {
  const p = localParts(epochMs, tz);
  return epochMs - (p.msSinceMidnight % 3_600_000) + 3_600_000;
}

/** Mode ids of one schedule cell: separated by spaces, commas or `+`. */
export function parseModes(text: string): string[] {
  return text
    .split(/[\s,+]+/)
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean);
}
