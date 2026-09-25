/**
 * Parses action strings used in rules.then, schedule cells and sequences.action:
 *
 *   set <device> <targets...>       set hall.light 80% 2700K transition=2s
 *   set <var> <value>               set bedroom.auto FALSE
 *   scene <scene> [<room>]          scene evening   /  scene off living
 *   event <name>                    event sleep
 *   start <sequence> [unless running]
 *   cancel <sequence>
 *   fade <device> <targets...> over <duration>
 *   notify "<text>"                 notify "Sovrum {bedroom.temp}°C"
 *   log "<text>"
 *   script <file> [<args>...]
 *
 * Several actions are separated by `;`. Any token may embed `{formula}` pieces that are
 * evaluated when the action runs.
 */
import { formula } from '../formula/index.js';
import { FormulaError } from '../formula/api.js';
import { parseDuration } from '../formula/values.js';
import type { ActionDef, ActionToken } from './model.js';

export type NameKind = 'device' | 'var' | undefined;

export interface ActionParseContext {
  /** Tells the parser whether `set x` targets a device or a var. */
  classify(name: string): NameKind;
}

export class ActionParseError extends Error {}

/** Splits on `;` outside quotes and braces. */
export function splitActions(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of text) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter((p) => p !== '');
}

/** Splits on whitespace outside quotes and braces. Quotes are kept on the token. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of text) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (quote) throw new ActionParseError(`unterminated quote in "${text}"`);
  if (depth !== 0) throw new ActionParseError(`unbalanced braces in "${text}"`);
  if (cur) out.push(cur);
  return out;
}

/** Breaks a token into literal text and {formula} pieces. */
export function parseTemplate(text: string): ActionToken[] {
  const pieces: ActionToken[] = [];
  let i = 0;
  let lit = '';
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        if (text[j] === '}') depth--;
        j++;
      }
      if (depth !== 0) throw new ActionParseError(`unbalanced braces in "${text}"`);
      const src = text.slice(i + 1, j - 1);
      if (lit) pieces.push({ kind: 'text', text: lit });
      lit = '';
      try {
        pieces.push({ kind: 'formula', ast: formula.parse(src), source: src });
      } catch (e) {
        if (e instanceof FormulaError) throw new ActionParseError(`in {${src}}: ${e.message}`);
        throw e;
      }
      i = j;
      continue;
    }
    lit += ch;
    i++;
  }
  if (lit) pieces.push({ kind: 'text', text: lit });
  return pieces;
}

function unquote(t: string): string {
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

export function parseAction(text: string, ctx: ActionParseContext): ActionDef {
  const tokens = tokenize(text.trim());
  const verb = (tokens[0] ?? '').toLowerCase();
  const rest = tokens.slice(1);
  const need = (n: number, usage: string) => {
    if (rest.length < n) throw new ActionParseError(`"${text}": expected ${usage}`);
  };
  switch (verb) {
    case 'set': {
      need(2, 'set <device|var> <value...>');
      const target = rest[0]!;
      const kind = ctx.classify(target);
      if (kind === 'device') {
        return { kind: 'set-device', device: target, tokens: rest.slice(1).map(parseTemplate), source: text };
      }
      if (kind === 'var') {
        return { kind: 'set-var', var: target, value: parseTemplate(unquote(rest.slice(1).join(' '))), source: text };
      }
      throw new ActionParseError(`"${text}": unknown device or var "${target}"`);
    }
    case 'scene':
      need(1, 'scene <name> [<room>]');
      return { kind: 'scene', scene: rest[0]!, room: rest[1] ?? null, source: text };
    case 'event':
      need(1, 'event <name>');
      return { kind: 'event', name: rest[0]!, source: text };
    case 'start': {
      need(1, 'start <sequence> [unless running]');
      const unlessRunning = rest.slice(1).join(' ').toLowerCase() === 'unless running';
      if (rest.length > 1 && !unlessRunning) throw new ActionParseError(`"${text}": only "unless running" may follow the sequence name`);
      return { kind: 'start', sequence: rest[0]!, unlessRunning, source: text };
    }
    case 'cancel':
      need(1, 'cancel <sequence>');
      return { kind: 'cancel', sequence: rest[0]!, source: text };
    case 'fade': {
      need(4, 'fade <device> <targets...> over <duration>');
      const overIdx = rest.findIndex((t) => t.toLowerCase() === 'over');
      if (overIdx < 2 || overIdx !== rest.length - 2) throw new ActionParseError(`"${text}": expected fade <device> <targets...> over <duration>`);
      const dur = parseDuration(rest[rest.length - 1]!);
      if (!dur) throw new ActionParseError(`"${text}": bad duration "${rest[rest.length - 1]}"`);
      return { kind: 'fade', device: rest[0]!, tokens: rest.slice(1, overIdx).map(parseTemplate), overMs: dur.ms, source: text };
    }
    case 'notify':
      need(1, 'notify "<text>"');
      return { kind: 'notify', text: parseTemplate(unquote(rest.join(' '))), source: text };
    case 'log':
      need(1, 'log "<text>"');
      return { kind: 'log', text: parseTemplate(unquote(rest.join(' '))), source: text };
    case 'script':
      need(1, 'script <file> [<args>...]');
      return { kind: 'script', file: rest[0]!, args: rest.slice(1), source: text };
    case '':
      throw new ActionParseError('empty action');
    default:
      throw new ActionParseError(`"${text}": unknown action "${verb}" (expected set, scene, event, start, cancel, fade, notify, log or script)`);
  }
}

export function parseActions(text: string, ctx: ActionParseContext): ActionDef[] {
  return splitActions(text).map((a) => parseAction(a, ctx));
}

/** All formula ASTs embedded in an action (for ref collection / type checking). */
export function actionFormulas(a: ActionDef): { ast: import('../formula/api.js').Ast; source: string }[] {
  const out: { ast: import('../formula/api.js').Ast; source: string }[] = [];
  const collect = (tokens: ActionToken[]) => {
    for (const t of tokens) if (t.kind === 'formula') out.push({ ast: t.ast, source: t.source });
  };
  switch (a.kind) {
    case 'set-device':
    case 'fade':
      a.tokens.forEach(collect);
      break;
    case 'set-var':
      collect(a.value);
      break;
    case 'notify':
    case 'log':
      collect(a.text);
      break;
    default:
      break;
  }
  return out;
}
