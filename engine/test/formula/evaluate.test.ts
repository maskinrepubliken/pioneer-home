import { describe, expect, it } from 'vitest';
import { Duration, FormulaError, TimeOfDay, Timestamp } from '../../src/formula/index.js';
import { localParts, todayAt } from '../../src/formula/time.js';
import { DEFAULT_NOW, TZ, ev, fakeCtx } from './helpers.js';

const dur = (ms: number): Duration => new Duration(ms);
const tod = (h: number, m = 0, s = 0): TimeOfDay => new TimeOfDay(((h * 60 + m) * 60 + s) * 1000);
const ts = (ms: number): Timestamp => new Timestamp(ms);
const MIN = 60_000;
const H = 3_600_000;

function runtimeError(source: string, ctx = fakeCtx()): FormulaError {
  try {
    ev(source, ctx);
  } catch (e) {
    if (e instanceof FormulaError) return e;
    throw e;
  }
  throw new Error(`expected "${source}" to throw`);
}

describe('literals and refs', () => {
  it('evaluates literals', () => {
    expect(ev('42')).toBe(42);
    expect(ev('"x"')).toBe('x');
    expect(ev('TRUE')).toBe(true);
    expect(ev('NULL')).toBeNull();
    expect(ev('10m')).toStrictEqual(dur(10 * MIN));
    expect(ev('07:30')).toStrictEqual(tod(7, 30));
  });

  it('reads cells from the context', () => {
    const ctx = fakeCtx({ values: { 'hall.temp': 21.5, 'hall.motion': true } });
    expect(ev('hall.temp', ctx)).toBe(21.5);
    expect(ev('hall.motion', ctx)).toBe(true);
    expect(ev('missing', ctx)).toBeNull();
  });
});

describe('arithmetic', () => {
  it('numbers', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('10 - 4 - 3')).toBe(3);
    expect(ev('7 / 2')).toBe(3.5);
    expect(ev('-2 * 3')).toBe(-6);
    expect(ev('-(2 * 3)')).toBe(-6);
    expect(ev('--2')).toBe(2);
  });

  it('division by zero yields NULL', () => {
    expect(ev('1 / 0')).toBeNull();
    expect(ev('10m / 0')).toBeNull();
    expect(ev('10m / 0s')).toBeNull();
  });

  it('durations', () => {
    expect(ev('10m + 20m')).toStrictEqual(dur(30 * MIN));
    expect(ev('1h - 15m')).toStrictEqual(dur(45 * MIN));
    expect(ev('2 * 10m')).toStrictEqual(dur(20 * MIN));
    expect(ev('10m * 2')).toStrictEqual(dur(20 * MIN));
    expect(ev('1h / 2')).toStrictEqual(dur(30 * MIN));
    expect(ev('1h / 15m')).toBe(4);
    expect(ev('-10m')).toStrictEqual(dur(-10 * MIN));
    expect(ev('1h30m')).toStrictEqual(dur(90 * MIN));
  });

  it('timestamps and durations', () => {
    const t0 = Date.UTC(2026, 0, 1, 12);
    const ctx = fakeCtx({ values: { t: ts(t0), u: ts(t0 + 90 * MIN) } });
    expect(ev('t + 1h', ctx)).toStrictEqual(ts(t0 + H));
    expect(ev('1h + t', ctx)).toStrictEqual(ts(t0 + H));
    expect(ev('t - 30m', ctx)).toStrictEqual(ts(t0 - 30 * MIN));
    expect(ev('u - t', ctx)).toStrictEqual(dur(90 * MIN));
    expect(ev('t - u', ctx)).toStrictEqual(dur(-90 * MIN));
    expect(ev('u > t', ctx)).toBe(true);
    expect(ev('u - t >= 1h', ctx)).toBe(true);
  });

  it('time of day and durations wrap at midnight', () => {
    expect(ev('07:30 + 1h')).toStrictEqual(tod(8, 30));
    expect(ev('23:00 + 2h')).toStrictEqual(tod(1));
    expect(ev('00:30 - 1h')).toStrictEqual(tod(23, 30));
    expect(ev('08:00 - 07:30')).toStrictEqual(dur(30 * MIN));
    expect(ev('01:00 - 02:00')).toStrictEqual(dur(-H));
  });

  it('rejects mismatched operand types at runtime', () => {
    const ctx = fakeCtx({ values: { s: 'x', n: 1 } });
    expect(runtimeError('n + s', ctx).message).toBe('Cannot add number and string');
    expect(runtimeError('n - 10m', ctx).message).toBe('Cannot subtract duration from number');
    expect(runtimeError('10m * 10m').message).toBe('Cannot multiply duration by duration');
    expect(runtimeError('1 / 10m').message).toBe('Cannot divide number by duration');
    expect(runtimeError('-s', ctx).message).toBe('Cannot negate string');
    expect(runtimeError('n + s', ctx).span).toEqual({ start: 0, end: 5 });
  });
});

describe('concatenation', () => {
  it('renders both sides as text', () => {
    expect(ev('"a" & "b"')).toBe('ab');
    expect(ev('"n=" & 1.5')).toBe('n=1.5');
    expect(ev('"a" & 1 & TRUE & 10m & 07:30')).toBe('a1TRUE10m07:30');
    expect(ev('NULL & "x"')).toBe('x');
    expect(ev('"x" & NULL')).toBe('x');
    expect(ev('1 + 2 & "!"')).toBe('3!');
  });
});

describe('comparison', () => {
  it('numbers and time types compare numerically', () => {
    expect(ev('1 < 2')).toBe(true);
    expect(ev('2 <= 2')).toBe(true);
    expect(ev('3 > 2')).toBe(true);
    expect(ev('3 >= 4')).toBe(false);
    expect(ev('1 = 1')).toBe(true);
    expect(ev('1 <> 1')).toBe(false);
    expect(ev('10m < 1h')).toBe(true);
    expect(ev('60m = 1h')).toBe(true);
    expect(ev('07:30 < 08:00')).toBe(true);
    expect(ev('07:30 = 7:30:00')).toBe(true);
  });

  it('strings compare case-sensitively and lexicographically', () => {
    expect(ev('"a" = "a"')).toBe(true);
    expect(ev('"a" = "A"')).toBe(false);
    expect(ev('"a" <> "b"')).toBe(true);
    expect(ev('"a" < "b"')).toBe(true);
    expect(ev('"b" > "abc"')).toBe(true);
  });

  it('booleans support only = and <>', () => {
    expect(ev('TRUE = TRUE')).toBe(true);
    expect(ev('TRUE <> FALSE')).toBe(true);
    expect(runtimeError('TRUE < FALSE').message).toBe('Cannot compare boolean values with <');
  });

  it('rejects comparing different types', () => {
    const e = runtimeError('1 = "x"');
    expect(e.message).toBe('Cannot compare number with string');
    expect(e.span).toEqual({ start: 0, end: 7 });
    expect(runtimeError('10m = 600').message).toBe('Cannot compare duration with number');
  });
});

describe('NULL semantics', () => {
  const table: Array<[string, unknown]> = [
    ['NULL + 1', null],
    ['1 - NULL', null],
    ['NULL * 10m', null],
    ['NULL / 2', null],
    ['-NULL', null],
    ['1 = NULL', null],
    ['NULL <> NULL', null],
    ['NULL < 1', null],
    ['AND(NULL, FALSE)', false],
    ['AND(FALSE, NULL)', false],
    ['AND(NULL, TRUE)', null],
    ['AND(TRUE, TRUE, NULL)', null],
    ['OR(NULL, TRUE)', true],
    ['OR(TRUE, NULL)', true],
    ['OR(NULL, FALSE)', null],
    ['NOT(NULL)', null],
    ['IF(NULL, 1, 2)', 2],
    ['COALESCE(NULL, NULL, 3)', 3],
    ['COALESCE(NULL)', null],
    ['ISBLANK(NULL)', true],
    ['ISBLANK(0)', false],
    ['ISBLANK("")', false],
    ['COUNT(NULL, 1, "a", NULL)', 2],
    ['COUNT(NULL)', 0],
    ['SUM(NULL, 1, 2)', 3],
    ['SUM(NULL, NULL)', null],
    ['AVG(NULL, 2, 4)', 3],
    ['MIN(NULL, 5, 3)', 3],
    ['MAX(NULL)', null],
    ['TEXT(NULL)', ''],
    ['ABS(NULL)', null],
    ['ROUND(NULL)', null],
    ['ROUND(1.234, NULL)', null],
    ['CLAMP(NULL, 0, 1)', null],
    ['BETWEEN(5, NULL, 10)', null],
    ['LOWER(NULL)', null],
    ['MINUTES(NULL)', null],
    ['TODAY(NULL)', null],
    ['1 / 0', null],
    ['(1 / 0) + 1', null],
  ];

  it.each(table)('%s -> %s', (source, expected) => {
    expect(ev(source)).toStrictEqual(expected);
  });

  it('IF evaluates only the taken branch', () => {
    expect(ev('IF(TRUE, 1, MINUTES("bad"))')).toBe(1);
  });
});

describe('logic functions', () => {
  it('AND / OR / NOT', () => {
    expect(ev('AND(TRUE, TRUE)')).toBe(true);
    expect(ev('AND(TRUE, FALSE)')).toBe(false);
    expect(ev('AND(TRUE)')).toBe(true);
    expect(ev('OR(FALSE, FALSE)')).toBe(false);
    expect(ev('OR(FALSE, TRUE, FALSE)')).toBe(true);
    expect(ev('NOT(TRUE)')).toBe(false);
    expect(ev('NOT(1 > 2)')).toBe(true);
    expect(runtimeError('AND(TRUE, 1)').message).toBe('AND expects a boolean as argument 2, got number');
  });

  it('IF / COALESCE / ISBLANK', () => {
    expect(ev('IF(1 < 2, "yes", "no")')).toBe('yes');
    expect(ev('IF(FALSE, 1, 2)')).toBe(2);
    expect(ev('IF(FALSE, 1, NULL)')).toBeNull();
    expect(ev('COALESCE(1, 2)')).toBe(1);
    expect(ev('COALESCE(NULL, "b", "c")')).toBe('b');
    expect(ev('ISBLANK(missing)')).toBe(true);
    expect(runtimeError('IF(1, 2, 3)').message).toBe('IF expects a boolean as argument 1, got number');
  });
});

describe('math functions', () => {
  it('aggregates over numbers', () => {
    expect(ev('SUM(1, 2, 3)')).toBe(6);
    expect(ev('AVG(1, 2, 3, 6)')).toBe(3);
    expect(ev('MIN(3, 1, 2)')).toBe(1);
    expect(ev('MAX(3, 1, 2)')).toBe(3);
    expect(ev('SUM(5)')).toBe(5);
  });

  it('aggregates over durations', () => {
    expect(ev('SUM(10m, 20m)')).toStrictEqual(dur(30 * MIN));
    expect(ev('AVG(1h, 2h)')).toStrictEqual(dur(90 * MIN));
    expect(ev('MIN(10m, 1h)')).toStrictEqual(dur(10 * MIN));
    expect(ev('MAX(10m, 1h)')).toStrictEqual(dur(H));
    expect(runtimeError('SUM(1, 10m)').message).toBe('SUM expects arguments of the same type, got number and duration');
    expect(runtimeError('MIN("a")').message).toBe('MIN expects a number or duration arguments, got string');
  });

  it('ABS / ROUND / CLAMP', () => {
    expect(ev('ABS(-3)')).toBe(3);
    expect(ev('ABS(3)')).toBe(3);
    expect(ev('ABS(-10m)')).toStrictEqual(dur(10 * MIN));
    expect(ev('ROUND(2.4)')).toBe(2);
    expect(ev('ROUND(2.5)')).toBe(3);
    expect(ev('ROUND(-2.5)')).toBe(-3);
    expect(ev('ROUND(3.14159, 2)')).toBe(3.14);
    expect(ev('ROUND(1234, -2)')).toBe(1200);
    expect(ev('CLAMP(15, 0, 10)')).toBe(10);
    expect(ev('CLAMP(-5, 0, 10)')).toBe(0);
    expect(ev('CLAMP(5, 0, 10)')).toBe(5);
    expect(ev('CLAMP(2h, 10m, 1h)')).toStrictEqual(dur(H));
    expect(ev('CLAMP(23:00, 07:00, 22:00)')).toStrictEqual(tod(22));
  });

  it('BETWEEN is inclusive and wraps midnight for time of day', () => {
    expect(ev('BETWEEN(5, 1, 10)')).toBe(true);
    expect(ev('BETWEEN(10, 1, 10)')).toBe(true);
    expect(ev('BETWEEN(1, 1, 10)')).toBe(true);
    expect(ev('BETWEEN(11, 1, 10)')).toBe(false);
    expect(ev('BETWEEN(30m, 10m, 1h)')).toBe(true);
    expect(ev('BETWEEN(12:00, 08:00, 17:00)')).toBe(true);
    expect(ev('BETWEEN(23:30, 22:00, 06:00)')).toBe(true);
    expect(ev('BETWEEN(02:00, 22:00, 06:00)')).toBe(true);
    expect(ev('BETWEEN(06:00, 22:00, 06:00)')).toBe(true);
    expect(ev('BETWEEN(12:00, 22:00, 06:00)')).toBe(false);
    expect(ev('BETWEEN(5, 10, 1)')).toBe(false);
  });

  it('COUNT counts non-null arguments of any type', () => {
    expect(ev('COUNT(1, "a", TRUE, 10m)')).toBe(4);
  });
});

describe('text functions', () => {
  it('TEXT / LOWER / UPPER', () => {
    expect(ev('TEXT(1.5)')).toBe('1.5');
    expect(ev('TEXT(2)')).toBe('2');
    expect(ev('TEXT(1 / 3)')).toBe('0.333');
    expect(ev('TEXT(TRUE)')).toBe('TRUE');
    expect(ev('TEXT(FALSE)')).toBe('FALSE');
    expect(ev('TEXT("x")')).toBe('x');
    expect(ev('TEXT(90m)')).toBe('1h30m');
    expect(ev('TEXT(07:30)')).toBe('07:30');
    expect(ev('LOWER("ABC")')).toBe('abc');
    expect(ev('UPPER("abc")')).toBe('ABC');
    expect(runtimeError('UPPER(1)').message).toBe('UPPER expects a string, got number');
  });
});

describe('time functions', () => {
  it('NOW / TIME / WEEKDAY / HOUR / MINUTE on an ordinary day', () => {
    const ctx = fakeCtx(); // Wednesday 2026-09-23 08:15:30 CEST
    expect(ev('NOW()', ctx)).toStrictEqual(ts(DEFAULT_NOW));
    expect(ev('TIME()', ctx)).toStrictEqual(tod(8, 15, 30));
    expect(ev('WEEKDAY()', ctx)).toBe(3);
    expect(ev('ISWEEKDAY()', ctx)).toBe(true);
    expect(ev('ISWEEKEND()', ctx)).toBe(false);
    expect(ev('HOUR()', ctx)).toBe(8);
    expect(ev('MINUTE()', ctx)).toBe(15);
    expect(ev('TIME() >= 07:30', ctx)).toBe(true);
    expect(ev('TODAY(07:30)', ctx)).toStrictEqual(ts(Date.UTC(2026, 8, 23, 5, 30)));
    expect(ev('TODAY(00:00)', ctx)).toStrictEqual(ts(Date.UTC(2026, 8, 22, 22)));
  });

  it('TIME() drops sub-second precision', () => {
    const ctx = fakeCtx({ now: DEFAULT_NOW + 750 });
    expect(ev('TIME()', ctx)).toStrictEqual(tod(8, 15, 30));
  });

  it('weekend detection', () => {
    const sat = fakeCtx({ now: Date.UTC(2026, 8, 26, 10) });
    const sun = fakeCtx({ now: Date.UTC(2026, 8, 27, 10) });
    const mon = fakeCtx({ now: Date.UTC(2026, 8, 28, 10) });
    expect(ev('WEEKDAY()', sat)).toBe(6);
    expect(ev('WEEKDAY()', sun)).toBe(7);
    expect(ev('WEEKDAY()', mon)).toBe(1);
    expect(ev('ISWEEKEND()', sat)).toBe(true);
    expect(ev('ISWEEKEND()', sun)).toBe(true);
    expect(ev('ISWEEKDAY()', mon)).toBe(true);
  });

  it('weekday is evaluated in the local zone, not UTC', () => {
    // 2026-09-27 23:30 CEST (Sunday) is 2026-09-27 21:30Z; 2026-09-28 00:30 CEST (Monday) is 22:30Z on the 27th.
    expect(ev('WEEKDAY()', fakeCtx({ now: Date.UTC(2026, 8, 27, 21, 30) }))).toBe(7);
    expect(ev('WEEKDAY()', fakeCtx({ now: Date.UTC(2026, 8, 27, 22, 30) }))).toBe(1);
    expect(ev('HOUR()', fakeCtx({ now: Date.UTC(2026, 8, 27, 22, 30) }))).toBe(0);
  });

  describe('Europe/Stockholm spring DST change (2026-03-29, 02:00 CET -> 03:00 CEST)', () => {
    it('after the change the wall clock is UTC+2', () => {
      const ctx = fakeCtx({ now: Date.UTC(2026, 2, 29, 10) }); // 12:00 CEST
      expect(ev('TIME()', ctx)).toStrictEqual(tod(12));
      expect(ev('HOUR()', ctx)).toBe(12);
      expect(ev('WEEKDAY()', ctx)).toBe(7);
      // Midnight was still CET (UTC+1).
      expect(ev('TODAY(00:00)', ctx)).toStrictEqual(ts(Date.UTC(2026, 2, 28, 23)));
      expect(ev('TODAY(01:30)', ctx)).toStrictEqual(ts(Date.UTC(2026, 2, 29, 0, 30)));
      // 07:30 is after the change, so CEST (UTC+2).
      expect(ev('TODAY(07:30)', ctx)).toStrictEqual(ts(Date.UTC(2026, 2, 29, 5, 30)));
      expect(ev('TODAY(12:00) = NOW()', ctx)).toBe(true);
    });

    it('before the change the wall clock is UTC+1', () => {
      const ctx = fakeCtx({ now: Date.UTC(2026, 2, 28, 23, 30) }); // 00:30 CET on the 29th
      expect(ev('TIME()', ctx)).toStrictEqual(tod(0, 30));
      expect(ev('WEEKDAY()', ctx)).toBe(7);
      expect(ev('TODAY(12:00)', ctx)).toStrictEqual(ts(Date.UTC(2026, 2, 29, 10)));
      expect(ev('TODAY(00:00)', ctx)).toStrictEqual(ts(Date.UTC(2026, 2, 28, 23)));
    });

    it('a time inside the skipped hour is mapped forward', () => {
      const ctx = fakeCtx({ now: Date.UTC(2026, 2, 29, 10) });
      expect(ev('TODAY(02:30)', ctx)).toStrictEqual(ts(Date.UTC(2026, 2, 29, 1, 30)));
    });
  });

  describe('Europe/Stockholm autumn DST change (2026-10-25, 03:00 CEST -> 02:00 CET)', () => {
    it('after the change the wall clock is UTC+1', () => {
      const ctx = fakeCtx({ now: Date.UTC(2026, 9, 25, 12) }); // 13:00 CET
      expect(ev('TIME()', ctx)).toStrictEqual(tod(13));
      expect(ev('HOUR()', ctx)).toBe(13);
      expect(ev('WEEKDAY()', ctx)).toBe(7);
      // Midnight was still CEST (UTC+2).
      expect(ev('TODAY(00:00)', ctx)).toStrictEqual(ts(Date.UTC(2026, 9, 24, 22)));
      expect(ev('TODAY(01:30)', ctx)).toStrictEqual(ts(Date.UTC(2026, 9, 24, 23, 30)));
      expect(ev('TODAY(12:00)', ctx)).toStrictEqual(ts(Date.UTC(2026, 9, 25, 11)));
    });

    it('before the change the wall clock is UTC+2', () => {
      const ctx = fakeCtx({ now: Date.UTC(2026, 9, 24, 22, 30) }); // 00:30 CEST on the 25th
      expect(ev('TIME()', ctx)).toStrictEqual(tod(0, 30));
      expect(ev('TODAY(12:00)', ctx)).toStrictEqual(ts(Date.UTC(2026, 9, 25, 11)));
    });
  });

  it('SUNRISE / SUNSET use the context for the current local day', () => {
    const ctx = fakeCtx();
    const midnight = Date.UTC(2026, 8, 22, 22);
    expect(ev('SUNRISE()', ctx)).toStrictEqual(ts(midnight + 6 * H));
    expect(ev('SUNSET()', ctx)).toStrictEqual(ts(midnight + 18 * H));
    expect(ev('NOW() > SUNRISE()', ctx)).toBe(true);
    expect(ev('SUNSET() - 30m < NOW()', ctx)).toBe(false);
  });

  it('duration accessors', () => {
    expect(ev('MINUTES(1h30m)')).toBe(90);
    expect(ev('HOURS(90m)')).toBe(1.5);
    expect(ev('SECONDS(1m)')).toBe(60);
    expect(ev('SECONDS(500ms)')).toBe(0.5);
    expect(runtimeError('MINUTES(5)').message).toBe('MINUTES expects a duration, got number');
  });
});

describe('time helpers', () => {
  it('localParts on a DST day', () => {
    const p = localParts(Date.UTC(2026, 2, 29, 10, 0, 5, 250), TZ);
    expect(p).toMatchObject({ year: 2026, month: 3, day: 29, hour: 12, minute: 0, second: 5, weekday: 7 });
    expect(p.midnightMs).toBe(Date.UTC(2026, 2, 28, 23));
    expect(p.msSinceMidnight).toBe(12 * H + 5250);
    expect(todayAt(Date.UTC(2026, 2, 29, 10), TZ, 12 * H)).toBe(Date.UTC(2026, 2, 29, 10));
  });

  it('localParts in another zone', () => {
    const p = localParts(Date.UTC(2026, 0, 1, 3), 'America/New_York'); // 22:00 on Dec 31 2025
    expect(p).toMatchObject({ year: 2025, month: 12, day: 31, hour: 22, weekday: 3 });
    expect(p.midnightMs).toBe(Date.UTC(2025, 11, 31, 5));
  });
});

describe('history functions', () => {
  const ctx = fakeCtx({
    values: { motion: true, door: false, temp: 21, count: 3 },
    prev: { temp: 20 },
    changed: ['temp'],
    since: {
      motion: dur(5 * MIN),
      'motion|FALSE': dur(15 * MIN),
      'door|TRUE': dur(2 * H),
      'count|3': dur(0),
    },
  });

  it('SINCE', () => {
    expect(ev('SINCE(motion)', ctx)).toStrictEqual(dur(5 * MIN));
    expect(ev('SINCE(motion, FALSE)', ctx)).toStrictEqual(dur(15 * MIN));
    expect(ev('SINCE(door, TRUE)', ctx)).toStrictEqual(dur(2 * H));
    expect(ev('SINCE(count, 3)', ctx)).toStrictEqual(dur(0));
    expect(ev('SINCE(door)', ctx)).toBeNull();
    expect(ev('SINCE(door, TRUE) > 1h', ctx)).toBe(true);
    expect(ev('MINUTES(SINCE(motion))', ctx)).toBe(5);
  });

  it('PREV / CHANGED', () => {
    expect(ev('PREV(temp)', ctx)).toBe(20);
    expect(ev('PREV(motion)', ctx)).toBeNull();
    expect(ev('temp - PREV(temp)', ctx)).toBe(1);
    expect(ev('CHANGED(temp)', ctx)).toBe(true);
    expect(ev('CHANGED(motion)', ctx)).toBe(false);
  });

  it('HOLD', () => {
    expect(ev('HOLD(motion, 10m)', ctx)).toBe(true);
    expect(ev('HOLD(motion, 15m)', ctx)).toBe(true);
    expect(ev('HOLD(motion, 20m)', ctx)).toBe(false);
    expect(ev('HOLD(door, 1m)', ctx)).toBe(false);
    expect(ev('HOLD(motion, NULL)', ctx)).toBeNull();
    // TRUE, but never seen FALSE: unknown how long.
    const fresh = fakeCtx({ values: { motion: true } });
    expect(ev('HOLD(motion, 1m)', fresh)).toBeNull();
    // NULL cell.
    expect(ev('HOLD(unknown, 1m)', fresh)).toBeNull();
    expect(runtimeError('HOLD(temp, 1m)', ctx).message).toBe('HOLD expects a boolean as argument 1, got number');
  });

  it('non-ref argument is a runtime error', () => {
    expect(runtimeError('SINCE(1 + 1)').message).toBe('SINCE expects a cell reference as argument 1');
  });
});

describe('runtime call errors', () => {
  it('unknown function and arity', () => {
    expect(runtimeError('FOO(1)').message).toBe('Unknown function FOO');
    expect(runtimeError('NOT(TRUE, FALSE)').message).toBe('NOT expects 1 argument, got 2');
  });
});
