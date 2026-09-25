import { describe, expect, it } from 'vitest';
import { formula, FormulaError, type Ast } from '../../src/formula/index.js';
import { stripSpans } from './helpers.js';

const parse = (s: string): Ast => formula.parse(s);

function syntaxError(source: string): FormulaError {
  try {
    parse(source);
  } catch (e) {
    if (e instanceof FormulaError) return e;
    throw e;
  }
  throw new Error(`expected "${source}" to fail`);
}

describe('lexer: literals', () => {
  it('lexes durations greedily', () => {
    expect(parse('10m')).toMatchObject({ kind: 'duration', ms: 600_000, span: { start: 0, end: 3 } });
    expect(parse('1h30m')).toMatchObject({ kind: 'duration', ms: 5_400_000 });
    expect(parse('500ms')).toMatchObject({ kind: 'duration', ms: 500 });
    expect(parse('2d')).toMatchObject({ kind: 'duration', ms: 172_800_000 });
    expect(parse('1.5h')).toMatchObject({ kind: 'duration', ms: 5_400_000 });
  });

  it('treats a bare unit letter as a cell reference', () => {
    expect(parse('m')).toMatchObject({ kind: 'ref', name: 'm' });
    expect(parse('s.h')).toMatchObject({ kind: 'ref', name: 's.h' });
  });

  it('rejects a number separated from its unit', () => {
    const e = syntaxError('10 m');
    expect(e.message).toBe('Unexpected token "m" at 3');
    expect(e.span).toEqual({ start: 3, end: 4 });
  });

  it('rejects unknown units glued to a number', () => {
    expect(syntaxError('10min').message).toBe('Invalid literal "10min" at 0');
    expect(syntaxError('1.').message).toBe('Invalid literal "1." at 0');
    expect(syntaxError('1h30').message).toBe('Invalid literal "1h30" at 0');
  });

  it('lexes numbers', () => {
    expect(parse('42')).toMatchObject({ kind: 'number', value: 42 });
    expect(parse('3.25')).toMatchObject({ kind: 'number', value: 3.25 });
  });

  it('lexes time-of-day literals before numbers', () => {
    expect(parse('07:30')).toMatchObject({ kind: 'timeofday', ms: 27_000_000, span: { start: 0, end: 5 } });
    expect(parse('7:30')).toMatchObject({ kind: 'timeofday', ms: 27_000_000 });
    expect(parse('23:59:59')).toMatchObject({ kind: 'timeofday', ms: 86_399_000 });
    expect(parse('00:00')).toMatchObject({ kind: 'timeofday', ms: 0 });
    expect(syntaxError('25:00').message).toBe('Invalid time of day "25:00" at 0');
    expect(syntaxError('12:60').message).toBe('Invalid time of day "12:60" at 0');
  });

  it('lexes strings with doubled-quote escapes', () => {
    expect(parse('"hello"')).toMatchObject({ kind: 'string', value: 'hello' });
    expect(parse("'hello'")).toMatchObject({ kind: 'string', value: 'hello' });
    expect(parse('"say ""hi"""')).toMatchObject({ kind: 'string', value: 'say "hi"' });
    expect(parse("'it''s'")).toMatchObject({ kind: 'string', value: "it's" });
    expect(parse('"a\'b"')).toMatchObject({ kind: 'string', value: "a'b" });
    expect(parse('""')).toMatchObject({ kind: 'string', value: '' });
    expect(syntaxError('"abc').message).toBe('Unterminated string at 0');
  });

  it('lexes keywords case-insensitively', () => {
    expect(parse('TRUE')).toMatchObject({ kind: 'boolean', value: true });
    expect(parse('false')).toMatchObject({ kind: 'boolean', value: false });
    expect(parse('True')).toMatchObject({ kind: 'boolean', value: true });
    expect(parse('NULL')).toMatchObject({ kind: 'null' });
    expect(parse('null')).toMatchObject({ kind: 'null' });
  });

  it('lexes refs and function names', () => {
    expect(parse('hall.light_1')).toMatchObject({ kind: 'ref', name: 'hall.light_1' });
    expect(parse('and(TRUE, FALSE)')).toMatchObject({ kind: 'call', name: 'AND' });
    expect(parse('AND (TRUE)')).toMatchObject({ kind: 'call', name: 'AND', span: { start: 0, end: 10 } });
    expect(parse('Now()')).toMatchObject({ kind: 'call', name: 'NOW', args: [] });
  });

  it('rejects uppercase cell references', () => {
    const e = syntaxError('Hall.light');
    expect(e.message).toMatch(/^Invalid cell reference "Hall.light" at 0/);
    expect(e.span).toEqual({ start: 0, end: 10 });
    expect(syntaxError('hall.Light').message).toMatch(/Invalid cell reference/);
    expect(syntaxError('a.').message).toMatch(/Unexpected character "\." at 1/);
  });

  it('rejects stray characters', () => {
    expect(syntaxError('1 # 2').message).toBe('Unexpected character "#" at 2');
    expect(syntaxError('a ! b').span).toEqual({ start: 2, end: 3 });
  });
});

describe('parser: structure and precedence', () => {
  it('multiplication binds tighter than addition', () => {
    expect(stripSpans(parse('1 + 2 * 3'))).toEqual({
      kind: 'binary',
      op: '+',
      left: { kind: 'number', value: 1 },
      right: { kind: 'binary', op: '*', left: { kind: 'number', value: 2 }, right: { kind: 'number', value: 3 } },
    });
  });

  it('unary minus binds tighter than multiplication', () => {
    expect(stripSpans(parse('-2 * 3'))).toEqual({
      kind: 'binary',
      op: '*',
      left: { kind: 'unary', op: '-', operand: { kind: 'number', value: 2 } },
      right: { kind: 'number', value: 3 },
    });
  });

  it('concatenation is left-associative at the additive level', () => {
    expect(stripSpans(parse('a & "x" & b'))).toEqual({
      kind: 'binary',
      op: '&',
      left: { kind: 'binary', op: '&', left: { kind: 'ref', name: 'a' }, right: { kind: 'string', value: 'x' } },
      right: { kind: 'ref', name: 'b' },
    });
    expect(stripSpans(parse('1 - 2 - 3'))).toEqual(stripSpans(parse('(1 - 2) - 3')));
    expect(stripSpans(parse('8 / 2 / 2'))).toEqual(stripSpans(parse('(8 / 2) / 2')));
  });

  it('parentheses override precedence', () => {
    expect(stripSpans(parse('(1 + 2) * 3'))).toEqual({
      kind: 'binary',
      op: '*',
      left: { kind: 'binary', op: '+', left: { kind: 'number', value: 1 }, right: { kind: 'number', value: 2 } },
      right: { kind: 'number', value: 3 },
    });
  });

  it('comparison has the lowest precedence and is non-associative', () => {
    expect(stripSpans(parse('a + 1 > b * 2'))).toMatchObject({ kind: 'binary', op: '>' });
    const e = syntaxError('1 = 2 = 3');
    expect(e.message).toBe('Unexpected token "=" at 6: comparisons cannot be chained');
    expect(e.span).toEqual({ start: 6, end: 7 });
    expect(syntaxError('1 < 2 > 3').message).toMatch(/cannot be chained/);
    // ...but an explicitly parenthesized comparison may be compared again.
    expect(parse('(1 = 2) = FALSE')).toMatchObject({ kind: 'binary', op: '=' });
  });

  it('parses all comparison operators', () => {
    for (const op of ['=', '<>', '<', '<=', '>', '>=']) {
      expect(parse(`a ${op} b`)).toMatchObject({ kind: 'binary', op });
    }
  });

  it('parses calls with zero, one and several arguments', () => {
    expect(stripSpans(parse('NOW()'))).toEqual({ kind: 'call', name: 'NOW', args: [] });
    expect(stripSpans(parse('NOT(a)'))).toEqual({ kind: 'call', name: 'NOT', args: [{ kind: 'ref', name: 'a' }] });
    expect(stripSpans(parse('IF(a > 1, "x", b & "y")'))).toMatchObject({ kind: 'call', name: 'IF', args: [{ op: '>' }, { value: 'x' }, { op: '&' }] });
    expect(parse('MAX(1, MIN(2, 3))')).toMatchObject({ kind: 'call', args: [{ kind: 'number' }, { kind: 'call', name: 'MIN' }] });
  });

  it('records spans', () => {
    const ast = parse('1 + 2 * 3');
    expect(ast.span).toEqual({ start: 0, end: 9 });
    expect((ast as Extract<Ast, { kind: 'binary' }>).right.span).toEqual({ start: 4, end: 9 });
    expect(parse('IF(a, 1, 2)').span).toEqual({ start: 0, end: 11 });
    expect(parse('  -x ').span).toEqual({ start: 2, end: 4 });
    const call = parse('SUM(a.b, 10m)') as Extract<Ast, { kind: 'call' }>;
    expect(call.args[0]!.span).toEqual({ start: 4, end: 7 });
    expect(call.args[1]!.span).toEqual({ start: 9, end: 12 });
  });

  it('reports syntax errors with the offending token', () => {
    expect(syntaxError('1 + )').message).toBe('Unexpected token ")" at 4');
    expect(syntaxError('1 + )').span).toEqual({ start: 4, end: 5 });
    expect(syntaxError('(1 + 2').message).toBe('Unexpected end of input at 6');
    expect(syntaxError('1 2').message).toBe('Unexpected token "2" at 2');
    expect(syntaxError('SUM(1,)').message).toBe('Unexpected token ")" at 6');
    expect(syntaxError('SUM(1 2)').message).toBe('Unexpected token "2" at 6');
    expect(syntaxError('').message).toBe('Unexpected end of input at 0');
    expect(syntaxError('a +').message).toBe('Unexpected end of input at 3');
  });
});

describe('format', () => {
  const cases: Array<[string, string]> = [
    ['1+2*3', '1 + 2 * 3'],
    ['(1+2)*3', '(1 + 2) * 3'],
    ['1-(2-3)', '1 - (2 - 3)'],
    ['(1-2)-3', '1 - 2 - 3'],
    ['2*(3/4)', '2 * (3 / 4)'],
    ['-(1+2)', '-(1 + 2)'],
    ['-2*3', '-2 * 3'],
    ['-(2*3)', '-(2 * 3)'],
    ['a&"x"&b', 'a & "x" & b'],
    ['a&(b+c)', 'a & (b + c)'],
    ['(a=b)=FALSE', '(a = b) = FALSE'],
    ["'it''s'", '"it\'s"'],
    ['"say ""hi"""', '"say ""hi"""'],
    ['and(a,   not(b))', 'AND(a, NOT(b))'],
    ['90m', '1h30m'],
    ['1.5h', '1h30m'],
    ['500ms', '500ms'],
    ['7:30', '07:30'],
    ['07:30:15', '07:30:15'],
    ['true', 'TRUE'],
    ['null', 'NULL'],
    ['if(time()>=07:30,1,2)', 'IF(TIME() >= 07:30, 1, 2)'],
    ['(a)', 'a'],
    ['((1+2))*3', '(1 + 2) * 3'],
    ['a<>b', 'a <> b'],
    ['3.25', '3.25'],
    ['--2', '--2'],
  ];

  it.each(cases)('formats %s as %s', (source, expected) => {
    expect(formula.format(parse(source))).toBe(expected);
  });

  it.each(cases)('round-trips %s', (source) => {
    const ast = parse(source);
    const again = parse(formula.format(ast));
    expect(stripSpans(again)).toEqual(stripSpans(ast));
    expect(formula.format(again)).toBe(formula.format(ast));
  });
});
