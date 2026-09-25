/**
 * Tokenizer for the formula language.
 *
 * Numeric literals are disambiguated at lex time: `07:30` is a time of day, `10m` / `1h30m` a
 * duration, `10` a number. A bare word followed by `(` is a function name; TRUE/FALSE/NULL are
 * case-insensitive keywords; everything else must be a lowercase dotted cell reference.
 */
import { FormulaError, type SourceSpan } from './api.js';
import { parseDuration, parseTimeOfDay } from './values.js';

export type TokenType =
  | 'number'
  | 'string'
  | 'duration'
  | 'timeofday'
  | 'true'
  | 'false'
  | 'null'
  | 'ref'
  | 'func'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'eof';

export interface Token {
  type: TokenType;
  /** Source text of the token (for `ref` the dotted name, for `func` the name as written). */
  text: string;
  /** number: numeric value; string: unescaped contents; duration/timeofday: milliseconds. */
  value: number | string | null;
  span: SourceSpan;
}

const TIMEOFDAY_RE = /^\d{1,2}:\d{2}(?::\d{2})?/;
const DURATION_RE = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+/;
const NUMBER_RE = /^\d+(?:\.\d+)?/;
const WORD_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*/;
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const LITERAL_TAIL_RE = /^[A-Za-z0-9_.:]+/;
const TWO_CHAR_OPS = ['<>', '<=', '>='];
const ONE_CHAR_OPS = ['<', '>', '=', '+', '-', '*', '/', '&'];

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const n = src.length;
  let i = 0;

  const push = (type: TokenType, start: number, end: number, value: number | string | null = null): void => {
    tokens.push({ type, text: src.slice(start, end), value, span: { start, end } });
  };

  /** After a numeric literal, anything that could continue a literal is an error (`10min`, `1.`, `10 m` is fine). */
  const rejectLiteralTail = (start: number, end: number): void => {
    const tail = LITERAL_TAIL_RE.exec(src.slice(end));
    if (tail) {
      const text = src.slice(start, end + tail[0].length);
      throw new FormulaError(`Invalid literal "${text}" at ${start}`, { start, end: end + tail[0].length });
    }
  };

  while (i < n) {
    const ch = src[i]!;
    if (isSpace(ch)) {
      i++;
      continue;
    }
    const start = i;
    const rest = src.slice(i);

    if (ch >= '0' && ch <= '9') {
      const tod = TIMEOFDAY_RE.exec(rest);
      if (tod) {
        const text = tod[0];
        const end = start + text.length;
        const value = parseTimeOfDay(text);
        if (!value) throw new FormulaError(`Invalid time of day "${text}" at ${start}`, { start, end });
        rejectLiteralTail(start, end);
        push('timeofday', start, end, value.ms);
        i = end;
        continue;
      }
      const dur = DURATION_RE.exec(rest);
      if (dur) {
        const text = dur[0];
        const end = start + text.length;
        rejectLiteralTail(start, end);
        const value = parseDuration(text);
        if (!value) throw new FormulaError(`Invalid duration "${text}" at ${start}`, { start, end });
        push('duration', start, end, value.ms);
        i = end;
        continue;
      }
      const num = NUMBER_RE.exec(rest)!;
      const end = start + num[0].length;
      rejectLiteralTail(start, end);
      push('number', start, end, Number(num[0]));
      i = end;
      continue;
    }

    const word = WORD_RE.exec(rest);
    if (word) {
      const text = word[0];
      const end = start + text.length;
      // Function name: a bare word followed (after optional spaces) by "(".
      if (!text.includes('.')) {
        let k = end;
        while (k < n && isSpace(src[k]!)) k++;
        if (src[k] === '(') {
          push('func', start, end);
          i = end;
          continue;
        }
        const lower = text.toLowerCase();
        if (lower === 'true' || lower === 'false' || lower === 'null') {
          push(lower, start, end);
          i = end;
          continue;
        }
      }
      if (!text.split('.').every((seg) => IDENT_RE.test(seg))) {
        throw new FormulaError(`Invalid cell reference "${text}" at ${start}: cell references are lowercase`, {
          start,
          end,
        });
      }
      push('ref', start, end, text);
      i = end;
      continue;
    }

    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= n) throw new FormulaError(`Unterminated string at ${start}`, { start, end: n });
        const c = src[j]!;
        if (c === ch) {
          if (src[j + 1] === ch) {
            out += ch;
            j += 2;
            continue;
          }
          j++;
          break;
        }
        out += c;
        j++;
      }
      push('string', start, j, out);
      i = j;
      continue;
    }

    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) {
      push('op', start, start + 2);
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.includes(ch)) {
      push('op', start, start + 1);
      i++;
      continue;
    }
    if (ch === '(') {
      push('lparen', start, start + 1);
      i++;
      continue;
    }
    if (ch === ')') {
      push('rparen', start, start + 1);
      i++;
      continue;
    }
    if (ch === ',') {
      push('comma', start, start + 1);
      i++;
      continue;
    }
    throw new FormulaError(`Unexpected character "${ch}" at ${start}`, { start, end: start + 1 });
  }

  tokens.push({ type: 'eof', text: '', value: null, span: { start: n, end: n } });
  return tokens;
}
