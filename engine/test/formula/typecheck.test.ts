import { describe, expect, it } from 'vitest';
import { Duration, TimeOfDay, formula, type RefTypes, type ValueType } from '../../src/formula/index.js';

const CELLS: Record<string, ValueType> = {
  n: 'number',
  n2: 'number',
  b: 'boolean',
  s: 'string',
  d: 'duration',
  t: 'timeofday',
  ts: 'timestamp',
  any: 'any',
  'hall.light': 'boolean',
};
const refTypes: RefTypes = (ref) => CELLS[ref];

function check(source: string) {
  return formula.typeCheck(formula.parse(source), refTypes);
}

function messages(source: string): string[] {
  return check(source).errors.map((e) => e.message);
}

describe('typeCheck: result types', () => {
  const cases: Array<[string, ValueType]> = [
    ['1', 'number'],
    ['"x"', 'string'],
    ['TRUE', 'boolean'],
    ['NULL', 'null'],
    ['10m', 'duration'],
    ['07:30', 'timeofday'],
    ['n + 1', 'number'],
    ['d + 10m', 'duration'],
    ['ts + d', 'timestamp'],
    ['d + ts', 'timestamp'],
    ['ts - d', 'timestamp'],
    ['ts - ts', 'duration'],
    ['t + d', 'timeofday'],
    ['t - t', 'duration'],
    ['t - d', 'timeofday'],
    ['n * d', 'duration'],
    ['d * n', 'duration'],
    ['d / n', 'duration'],
    ['d / d', 'number'],
    ['n / n2', 'number'],
    ['-n', 'number'],
    ['-d', 'duration'],
    ['n & s', 'string'],
    ['n = 1', 'boolean'],
    ['s < "a"', 'boolean'],
    ['NULL + 1', 'number'],
    ['NULL - n', 'number'],
    ['NULL + d', 'any'],
    ['NULL * n', 'any'],
    ['NULL + NULL', 'null'],
    ['any + 1', 'number'],
    ['any + d', 'any'],
    ['any - ts', 'duration'],
    ['any = 1', 'boolean'],
    ['-any', 'any'],
    ['IF(b, 1, 2)', 'number'],
    ['IF(b, 1, NULL)', 'number'],
    ['IF(b, NULL, "x")', 'string'],
    ['IF(b, any, 1)', 'any'],
    ['COALESCE(NULL, n, 1)', 'number'],
    ['COALESCE(NULL)', 'null'],
    ['AND(b, TRUE)', 'boolean'],
    ['NOT(b)', 'boolean'],
    ['ISBLANK(n)', 'boolean'],
    ['SUM(1, n)', 'number'],
    ['SUM(d, 10m)', 'duration'],
    ['MIN(any, any)', 'any'],
    ['MAX(NULL)', 'null'],
    ['ABS(d)', 'duration'],
    ['ROUND(n, 1)', 'number'],
    ['CLAMP(t, 07:00, 22:00)', 'timeofday'],
    ['BETWEEN(t, 22:00, 06:00)', 'boolean'],
    ['COUNT(n, s, b)', 'number'],
    ['TEXT(n)', 'string'],
    ['LOWER(s)', 'string'],
    ['NOW()', 'timestamp'],
    ['TIME()', 'timeofday'],
    ['WEEKDAY()', 'number'],
    ['ISWEEKDAY()', 'boolean'],
    ['ISWEEKEND()', 'boolean'],
    ['HOUR()', 'number'],
    ['MINUTE()', 'number'],
    ['TODAY(07:30)', 'timestamp'],
    ['SUNRISE()', 'timestamp'],
    ['SUNSET()', 'timestamp'],
    ['MINUTES(d)', 'number'],
    ['HOURS(d)', 'number'],
    ['SECONDS(d)', 'number'],
    ['SINCE(n)', 'duration'],
    ['SINCE(b, TRUE)', 'duration'],
    ['PREV(n)', 'number'],
    ['PREV(s)', 'string'],
    ['CHANGED(n)', 'boolean'],
    ['HOLD(b, 10m)', 'boolean'],
    ['HOLD(hall.light, d)', 'boolean'],
    ['NOW() > TODAY(07:30)', 'boolean'],
    ['SUNSET() - 30m', 'timestamp'],
  ];

  it.each(cases)('%s : %s', (source, type) => {
    const result = check(source);
    expect(result.errors).toEqual([]);
    expect(result.type).toBe(type);
  });
});

describe('typeCheck: errors', () => {
  it('unknown cell', () => {
    const r = check('hall.ligt');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toBe('Unknown cell hall.ligt');
    expect(r.errors[0]!.span).toEqual({ start: 0, end: 9 });
    expect(r.type).toBe('any');
  });

  it('unknown function', () => {
    const r = check('1 + FOO(2)');
    expect(r.errors[0]!.message).toBe('Unknown function FOO');
    expect(r.errors[0]!.span).toEqual({ start: 4, end: 10 });
  });

  it('arity', () => {
    expect(messages('IF(b, 1)')).toEqual(['IF expects 3 arguments, got 2']);
    expect(messages('ROUND(1, 2, 3)')).toEqual(['ROUND expects 1 to 2 arguments, got 3']);
    expect(messages('NOT()')).toEqual(['NOT expects 1 argument, got 0']);
    expect(messages('AND()')).toEqual(['AND expects at least 1 argument, got 0']);
    expect(messages('NOW(1)')).toEqual(['NOW expects 0 arguments, got 1']);
    expect(messages('SINCE(n, 1, 2)')).toEqual(['SINCE expects 1 to 2 arguments, got 3']);
    expect(check('NOT(b, b)').errors[0]!.span).toEqual({ start: 0, end: 9 });
  });

  it('incompatible comparison', () => {
    const r = check('n = s');
    expect(r.errors[0]!.message).toBe('Cannot compare number with string');
    expect(r.errors[0]!.span).toEqual({ start: 0, end: 5 });
    expect(r.type).toBe('boolean');
    expect(messages('d = 600')).toEqual(['Cannot compare duration with number']);
    expect(messages('b < TRUE')).toEqual(['Cannot compare boolean values with <']);
    expect(messages('t = ts')).toEqual(['Cannot compare timeofday with timestamp']);
  });

  it('incompatible arithmetic', () => {
    expect(messages('n + s')).toEqual(['Cannot add number and string']);
    expect(messages('n - d')).toEqual(['Cannot subtract duration from number']);
    expect(messages('d * d')).toEqual(['Cannot multiply duration by duration']);
    expect(messages('n / d')).toEqual(['Cannot divide number by duration']);
    expect(messages('ts + ts')).toEqual(['Cannot add timestamp and timestamp']);
    expect(messages('t + t')).toEqual(['Cannot add timeofday and timeofday']);
    expect(messages('b + 1')).toEqual(['Cannot add boolean and number']);
    expect(messages('NULL + s')).toEqual(['Cannot add null and string']);
    expect(messages('any + s')).toEqual(['Cannot add any and string']);
    expect(messages('-s')).toEqual(['Cannot negate string']);
    expect(check('-s').errors[0]!.span).toEqual({ start: 0, end: 2 });
  });

  it('function argument types', () => {
    expect(messages('NOT(n)')).toEqual(['NOT expects a boolean, got number']);
    expect(messages('AND(b, n)')).toEqual(['AND expects a boolean as argument 2, got number']);
    expect(check('AND(b, n)').errors[0]!.span).toEqual({ start: 7, end: 8 });
    expect(messages('IF(n, 1, 2)')).toEqual(['IF expects a boolean condition, got number']);
    expect(messages('IF(b, 1, "x")')).toEqual(['IF branches must have the same type, got number and string']);
    expect(check('IF(b, 1, "x")').errors[0]!.span).toEqual({ start: 9, end: 12 });
    expect(messages('IF(b, d, ts)')).toEqual(['IF branches must have the same type, got duration and timestamp']);
    expect(messages('COALESCE(n, s)')).toEqual(['COALESCE arguments must have the same type, got number and string']);
    expect(messages('SUM(n, d)')).toEqual(['SUM expects arguments of the same type, got number and duration']);
    expect(messages('MIN(s)')).toEqual(['MIN expects a number or duration, got string']);
    expect(messages('ABS(s)')).toEqual(['ABS expects a number or duration, got string']);
    expect(messages('ROUND(d)')).toEqual(['ROUND expects a number as argument 1, got duration']);
    expect(messages('ROUND(n, s)')).toEqual(['ROUND expects a number as argument 2, got string']);
    expect(messages('BETWEEN(t, 1, 2)')).toEqual([
      'BETWEEN expects arguments of the same type, got timeofday and number',
      'BETWEEN expects arguments of the same type, got timeofday and number',
    ]);
    expect(messages('CLAMP(b, b, b)')).toHaveLength(3);
    expect(messages('LOWER(n)')).toEqual(['LOWER expects a string, got number']);
    expect(messages('TODAY(n)')).toEqual(['TODAY expects a timeofday, got number']);
    expect(messages('MINUTES(n)')).toEqual(['MINUTES expects a duration, got number']);
    expect(messages('HOLD(n, 10m)')).toEqual(['HOLD expects a boolean cell as argument 1, got number']);
    expect(messages('HOLD(b, 5)')).toEqual(['HOLD expects a duration as argument 2, got number']);
  });

  it('history functions require a cell reference', () => {
    const r = check('SINCE(1 + 1)');
    expect(r.errors[0]!.message).toBe('SINCE expects a cell reference as argument 1');
    expect(r.errors[0]!.span).toEqual({ start: 6, end: 11 });
    expect(messages('PREV("x")')).toEqual(['PREV expects a cell reference as argument 1']);
    expect(messages('CHANGED(NOW())')).toEqual(['CHANGED expects a cell reference as argument 1']);
    expect(messages('HOLD(TRUE, 1m)')).toEqual(['HOLD expects a cell reference as argument 1']);
    expect(messages('SINCE(b, n)')).toEqual(['SINCE expects a literal value as argument 2']);
    expect(messages('SINCE(b, NOT(TRUE))')).toEqual(['SINCE expects a literal value as argument 2']);
  });

  it('unknown cell inside a history function is reported too', () => {
    expect(messages('SINCE(nope)')).toEqual(['Unknown cell nope']);
  });

  it('collects several errors', () => {
    const r = check('n + FOO(1) = s');
    expect(r.errors.map((e) => e.message)).toEqual(['Unknown function FOO', 'Cannot compare number with string']);
    expect(check('nope + s = NOT(n)').errors.map((e) => e.message)).toEqual([
      'Unknown cell nope',
      'Cannot add any and string',
      'NOT expects a boolean, got number',
    ]);
    expect(check('IF(n, s, d) + 1').errors.map((e) => e.message)).toEqual([
      'IF expects a boolean condition, got number',
      'IF branches must have the same type, got string and duration',
    ]);
  });

  it("'any' cells are compatible with everything", () => {
    expect(messages('any + 1')).toEqual([]);
    expect(messages('any = "x"')).toEqual([]);
    expect(messages('NOT(any)')).toEqual([]);
    expect(messages('IF(any, any, 1)')).toEqual([]);
    expect(messages('SUM(any, d)')).toEqual([]);
    expect(messages('HOLD(any, 10m)')).toEqual([]);
    expect(messages('TODAY(any)')).toEqual([]);
  });
});

describe('refs', () => {
  it('returns refs deduplicated in first-seen order', () => {
    const refs = (s: string) => formula.refs(formula.parse(s));
    expect(refs('a + b * a + c.d')).toEqual(['a', 'b', 'c.d']);
    expect(refs('IF(z, y, x) & z')).toEqual(['z', 'y', 'x']);
    expect(refs('SINCE(x) + PREV(y) + MINUTES(HOLD(x, 1m) - w)')).toEqual(['x', 'y', 'w']);
    expect(refs('1 + 2')).toEqual([]);
  });
});

describe('isTimeDependent', () => {
  const dep = (s: string) => formula.isTimeDependent(formula.parse(s));
  it('detects time functions anywhere in the tree', () => {
    for (const fn of ['NOW()', 'TIME()', 'WEEKDAY()', 'ISWEEKDAY()', 'ISWEEKEND()', 'HOUR()', 'MINUTE()', 'TODAY(07:00)', 'SUNRISE()', 'SUNSET()', 'SINCE(a)', 'HOLD(a, 1m)']) {
      expect(dep(fn), fn).toBe(true);
      expect(dep(`IF(b, TEXT(${fn}), "x")`), fn).toBe(true);
    }
  });
  it('is false for pure formulas', () => {
    for (const src of ['a + 1', 'PREV(a)', 'CHANGED(a)', 'MINUTES(10m)', 'BETWEEN(t, 22:00, 06:00)', 'IF(a, "x", "y")']) {
      expect(dep(src), src).toBe(false);
    }
  });
});

describe('sinceTargets', () => {
  const targets = (s: string) => formula.sinceTargets(formula.parse(s));
  it('collects SINCE and HOLD targets', () => {
    expect(targets('SINCE(a, TRUE) + SINCE(b)')).toEqual([
      { ref: 'a', value: true },
      { ref: 'b', value: undefined },
    ]);
    expect(targets('HOLD(a, 10m)')).toEqual([{ ref: 'a', value: false }]);
    expect(targets('SINCE(a, "on")')).toEqual([{ ref: 'a', value: 'on' }]);
    expect(targets('SINCE(a, 3)')).toEqual([{ ref: 'a', value: 3 }]);
    expect(targets('SINCE(a, NULL)')).toEqual([{ ref: 'a', value: null }]);
    expect(targets('SINCE(a, 10m)')).toStrictEqual([{ ref: 'a', value: new Duration(600_000) }]);
    expect(targets('SINCE(a, 07:30)')).toStrictEqual([{ ref: 'a', value: new TimeOfDay(27_000_000) }]);
  });
  it('deduplicates identical targets and ignores non-history functions', () => {
    expect(targets('SINCE(a, TRUE) + SINCE(a, TRUE) + SINCE(a, FALSE) + HOLD(a, 1m)')).toEqual([
      { ref: 'a', value: true },
      { ref: 'a', value: false },
    ]);
    expect(targets('SINCE(a) + SINCE(a)')).toEqual([{ ref: 'a', value: undefined }]);
    expect(targets('PREV(a) + CHANGED(b) + NOW()')).toEqual([]);
  });
});
