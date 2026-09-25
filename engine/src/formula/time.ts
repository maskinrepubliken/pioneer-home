/**
 * Time-zone helpers built on Intl.DateTimeFormat. Used by the time functions of the formula
 * language (TIME, WEEKDAY, TODAY, ...) and reusable by the scheduler.
 *
 * All functions take an IANA zone name (e.g. 'Europe/Stockholm') and work in epoch milliseconds.
 */

export interface LocalParts {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
  /** 0-23 */
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday, 1 = Monday .. 7 = Sunday */
  weekday: number;
  /** Epoch ms of local midnight at the start of the local day containing the instant. */
  midnightMs: number;
  /**
   * Wall-clock milliseconds since midnight, i.e. what a clock on the wall shows
   * (hour * 3600 + minute * 60 + second) * 1000 + sub-second ms. This matches the TimeOfDay
   * value model. On a DST transition day it differs from `epochMs - midnightMs` by the
   * length of the shifted hour, which is intended: 12:00 on the wall is 12:00.
   */
  msSinceMidnight: number;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function wallClock(epochMs: number, tz: string): WallClock {
  const parts = formatter(tz).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    // Some engines render midnight as "24" even with hourCycle h23; normalise defensively.
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** UTC offset of `tz` at the given instant, in ms (positive east of Greenwich), rounded to the minute. */
export function offsetAt(epochMs: number, tz: string): number {
  const w = wallClock(epochMs, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - epochMs) / 60_000) * 60_000;
}

/**
 * Epoch ms of the instant at which the wall clock in `tz` reads the given local date and
 * milliseconds since midnight.
 *
 * Two passes: a first guess using the offset in force around the wall-clock instant, then a
 * correction using the offset in force at that guess. This is exact except when the requested
 * wall-clock time falls inside a DST gap (the skipped hour, mapped forward) or overlap (the
 * repeated hour, where the later occurrence is returned).
 */
export function wallClockToEpoch(year: number, month: number, day: number, msSinceMidnight: number, tz: string): number {
  const utcWall = Date.UTC(year, month - 1, day) + msSinceMidnight;
  const guess = utcWall - offsetAt(utcWall, tz);
  return utcWall - offsetAt(guess, tz);
}

/** Splits an instant into its local calendar/clock parts in `tz`. */
export function localParts(epochMs: number, tz: string): LocalParts {
  const w = wallClock(epochMs, tz);
  const msSinceMidnight = (w.hour * 3600 + w.minute * 60 + w.second) * 1000 + mod(epochMs, 1000);
  const midnightMs = wallClockToEpoch(w.year, w.month, w.day, 0, tz);
  return { ...w, midnightMs, msSinceMidnight };
}

/**
 * Epoch ms of the wall-clock time `msSinceMidnight` on the local day (in `tz`) that contains
 * `epochMs`. TODAY(07:30) is `todayAt(now, tz, 7.5h)`.
 */
export function todayAt(epochMs: number, tz: string, msSinceMidnight: number): number {
  const w = wallClock(epochMs, tz);
  return wallClockToEpoch(w.year, w.month, w.day, msSinceMidnight, tz);
}
