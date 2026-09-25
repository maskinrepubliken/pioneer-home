/**
 * Built-in function registry: for every function its arity, static type check, runtime
 * implementation and time-dependence flag. Used by the type checker, the evaluator and the
 * AST queries in index.ts.
 */
import { FormulaError, type Ast, type EvalContext, type SourceSpan } from './api.js';
import { Duration, TimeOfDay, Timestamp, formatValue, typeOf, type Value, type ValueType } from './values.js';
import { localParts, todayAt } from './time.js';

export type CallNode = Extract<Ast, { kind: 'call' }>;
export type Report = (message: string, span: SourceSpan) => void;
export type Evaluate = (ast: Ast, ctx: EvalContext) => Value;
type Check = (argTypes: ValueType[], args: Ast[], report: Report, node: CallNode) => ValueType;
type Call = (node: CallNode, ctx: EvalContext, ev: Evaluate) => Value;

export interface FunctionDef {
  name: string;
  minArgs: number;
  /** Infinity for variadic functions. */
  maxArgs: number;
  /** The result can change with the clock alone. */
  timeDependent: boolean;
  /** Indices of arguments that must syntactically be cell references. */
  refArgs: readonly number[];
  /** Static type check. Arity and ref-arguments have already been verified by the caller. */
  check: Check;
  /** Runtime. Receives the unevaluated argument nodes so lazy and ref-taking functions can be expressed. */
  call: Call;
}

const ORDERABLE: readonly ValueType[] = ['number', 'duration', 'timeofday', 'timestamp'];
const NUMERIC: readonly ValueType[] = ['number', 'duration'];
const LITERAL_KINDS: ReadonlySet<Ast['kind']> = new Set(['number', 'string', 'boolean', 'null', 'duration', 'timeofday']);

// ---------------------------------------------------------------------------------------------
// Shared helpers

/** Text rendering used by TEXT() and `&`: strings unquoted, NULL empty, everything else as formatValue. */
export function toText(v: Value): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return formatValue(v);
}

/** Numeric key of an orderable value. */
export function numericKey(v: number | Duration | TimeOfDay | Timestamp): number {
  return typeof v === 'number' ? v : v.ms;
}

export function isRefNode(ast: Ast): ast is Extract<Ast, { kind: 'ref' }> {
  return ast.kind === 'ref';
}

export function isLiteralNode(ast: Ast): boolean {
  return LITERAL_KINDS.has(ast.kind);
}

function isUnknown(t: ValueType): boolean {
  return t === 'any' || t === 'null';
}

function describe(types: readonly ValueType[]): string {
  const article = /^[aeiou]/.test(types[0] ?? '') ? 'an' : 'a';
  return `${article} ${types.join(' or ')}`;
}

function refName(node: CallNode, index: number): string {
  const arg = node.args[index];
  if (!arg || !isRefNode(arg)) {
    throw new FormulaError(`${node.name} expects a cell reference as argument ${index + 1}`, arg?.span ?? node.span);
  }
  return arg.name;
}

// ---- static check builders -------------------------------------------------------------------

/** Every argument must be one of `allowed`; result is fixed. */
function checkEach(allowed: readonly ValueType[], result: ValueType): Check {
  return (argTypes, args, report, node) => {
    argTypes.forEach((t, i) => {
      if (!isUnknown(t) && !allowed.includes(t)) {
        report(`${node.name} expects ${describe(allowed)}${argTypes.length > 1 ? ` as argument ${i + 1}` : ''}, got ${t}`, args[i]!.span);
      }
    });
    return result;
  };
}

/** Argument i must be one of allowed[i]; result fixed. */
function checkPositional(allowed: readonly (readonly ValueType[])[], result: ValueType): Check {
  return (argTypes, args, report, node) => {
    argTypes.forEach((t, i) => {
      const ok = allowed[i];
      if (ok && !isUnknown(t) && !ok.includes(t)) {
        report(`${node.name} expects ${describe(ok)} as argument ${i + 1}, got ${t}`, args[i]!.span);
      }
    });
    return result;
  };
}

/** All arguments must share one type from `allowed`; result is that type (or `result` if given). */
function checkSameKind(allowed: readonly ValueType[], result?: ValueType): Check {
  return (argTypes, args, report, node) => {
    let found: ValueType | undefined;
    argTypes.forEach((t, i) => {
      if (isUnknown(t)) return;
      if (!allowed.includes(t)) {
        report(`${node.name} expects ${describe(allowed)}${argTypes.length > 1 ? ' arguments' : ''}, got ${t}`, args[i]!.span);
        return;
      }
      if (found === undefined) found = t;
      else if (found !== t) report(`${node.name} expects arguments of the same type, got ${found} and ${t}`, args[i]!.span);
    });
    if (result) return result;
    return found ?? (argTypes.every((t) => t === 'null') ? 'null' : 'any');
  };
}

/** Type of "a or b" where one side may be NULL (IF branches, COALESCE). */
function unify(a: ValueType, b: ValueType): ValueType | null {
  if (a === 'null') return b;
  if (b === 'null') return a;
  if (a === 'any' || b === 'any') return 'any';
  return a === b ? a : null;
}

// ---- runtime builders ------------------------------------------------------------------------

/** Evaluates all arguments first; with `propagateNull` any NULL argument yields NULL. */
function eager(impl: (args: Value[], node: CallNode, ctx: EvalContext) => Value, propagateNull = true): Call {
  return (node, ctx, ev) => {
    const args = node.args.map((a) => ev(a, ctx));
    if (propagateNull && args.some((a) => a === null)) return null;
    return impl(args, node, ctx);
  };
}

function expectType<T extends Value>(node: CallNode, index: number, v: Value, allowed: readonly ValueType[]): T {
  if (!allowed.includes(typeOf(v))) {
    const suffix = node.args.length > 1 ? ` as argument ${index + 1}` : '';
    throw new FormulaError(`${node.name} expects ${describe(allowed)}${suffix}, got ${typeOf(v)}`, node.args[index]?.span ?? node.span);
  }
  return v as T;
}

function expectNumber(node: CallNode, i: number, v: Value): number {
  return expectType<number>(node, i, v, ['number']);
}

function expectDuration(node: CallNode, i: number, v: Value): Duration {
  return expectType<Duration>(node, i, v, ['duration']);
}

function expectBoolean(node: CallNode, i: number, v: Value): boolean {
  return expectType<boolean>(node, i, v, ['boolean']);
}

function expectString(node: CallNode, i: number, v: Value): string {
  return expectType<string>(node, i, v, ['string']);
}

type Orderable = number | Duration | TimeOfDay | Timestamp;

/** Non-null values must all be of one kind from `allowed`; returns them and their common type. */
function sameKind(node: CallNode, args: Value[], allowed: readonly ValueType[]): { values: Orderable[]; type: ValueType | null } {
  let type: ValueType | null = null;
  const values: Orderable[] = [];
  args.forEach((v, i) => {
    if (v === null) return;
    const t = typeOf(v);
    if (!allowed.includes(t)) {
      throw new FormulaError(`${node.name} expects ${describe(allowed)} arguments, got ${t}`, node.args[i]?.span ?? node.span);
    }
    if (type === null) type = t;
    else if (type !== t) {
      throw new FormulaError(`${node.name} expects arguments of the same type, got ${type} and ${t}`, node.args[i]?.span ?? node.span);
    }
    values.push(v as Orderable);
  });
  return { values, type };
}

function ofKind(type: ValueType, n: number): Value {
  switch (type) {
    case 'duration':
      return new Duration(n);
    case 'timeofday':
      return new TimeOfDay(n);
    case 'timestamp':
      return new Timestamp(n);
    default:
      return n;
  }
}

function aggregate(fold: (nums: number[]) => number): Call {
  return eager((args, node) => {
    const { values, type } = sameKind(node, args, NUMERIC);
    if (type === null) return null;
    return ofKind(type, fold(values.map(numericKey)));
  }, false);
}

function roundHalfAwayFromZero(x: number, digits: number): number {
  const f = 10 ** digits;
  const r = Math.round(Math.abs(x) * f) / f;
  return x < 0 ? -r : r;
}

// ---------------------------------------------------------------------------------------------
// Definitions

interface Spec {
  min: number;
  max?: number;
  time?: boolean;
  refArgs?: readonly number[];
  check: Check;
  call: Call;
}

function def(name: string, spec: Spec): FunctionDef {
  return {
    name,
    minArgs: spec.min,
    maxArgs: spec.max ?? spec.min,
    timeDependent: spec.time ?? false,
    refArgs: spec.refArgs ?? [],
    check: spec.check,
    call: spec.call,
  };
}

const VARIADIC = Infinity;

const DEFINITIONS: FunctionDef[] = [
  // ---- logic --------------------------------------------------------------------------------
  def('AND', {
    min: 1,
    max: VARIADIC,
    check: checkEach(['boolean'], 'boolean'),
    call: (node, ctx, ev) => {
      let sawNull = false;
      for (const [i, arg] of node.args.entries()) {
        const v = ev(arg, ctx);
        if (v === null) sawNull = true;
        else if (expectBoolean(node, i, v) === false) return false;
      }
      return sawNull ? null : true;
    },
  }),
  def('OR', {
    min: 1,
    max: VARIADIC,
    check: checkEach(['boolean'], 'boolean'),
    call: (node, ctx, ev) => {
      let sawNull = false;
      for (const [i, arg] of node.args.entries()) {
        const v = ev(arg, ctx);
        if (v === null) sawNull = true;
        else if (expectBoolean(node, i, v) === true) return true;
      }
      return sawNull ? null : false;
    },
  }),
  def('NOT', {
    min: 1,
    check: checkEach(['boolean'], 'boolean'),
    call: eager((args, node) => !expectBoolean(node, 0, args[0]!)),
  }),
  def('IF', {
    min: 3,
    check: (argTypes, args, report) => {
      const [c, a, b] = argTypes as [ValueType, ValueType, ValueType];
      if (!isUnknown(c) && c !== 'boolean') report(`IF expects a boolean condition, got ${c}`, args[0]!.span);
      const t = unify(a, b);
      if (t === null) {
        report(`IF branches must have the same type, got ${a} and ${b}`, args[2]!.span);
        return 'any';
      }
      return t;
    },
    call: (node, ctx, ev) => {
      const [cond, a, b] = node.args as [Ast, Ast, Ast];
      const c = ev(cond, ctx);
      if (c === null) return ev(b, ctx);
      return expectBoolean(node, 0, c) ? ev(a, ctx) : ev(b, ctx);
    },
  }),
  def('COALESCE', {
    min: 1,
    max: VARIADIC,
    check: (argTypes, args, report) => {
      let acc: ValueType = 'null';
      argTypes.forEach((t, i) => {
        const u = unify(acc, t);
        if (u === null) report(`COALESCE arguments must have the same type, got ${acc} and ${t}`, args[i]!.span);
        else acc = u;
      });
      return acc;
    },
    call: (node, ctx, ev) => {
      for (const arg of node.args) {
        const v = ev(arg, ctx);
        if (v !== null) return v;
      }
      return null;
    },
  }),
  def('ISBLANK', {
    min: 1,
    check: () => 'boolean',
    call: eager((args) => args[0] === null, false),
  }),

  // ---- math ---------------------------------------------------------------------------------
  def('SUM', { min: 1, max: VARIADIC, check: checkSameKind(NUMERIC), call: aggregate((xs) => xs.reduce((a, b) => a + b, 0)) }),
  def('AVG', { min: 1, max: VARIADIC, check: checkSameKind(NUMERIC), call: aggregate((xs) => xs.reduce((a, b) => a + b, 0) / xs.length) }),
  def('MIN', { min: 1, max: VARIADIC, check: checkSameKind(NUMERIC), call: aggregate((xs) => Math.min(...xs)) }),
  def('MAX', { min: 1, max: VARIADIC, check: checkSameKind(NUMERIC), call: aggregate((xs) => Math.max(...xs)) }),
  def('ABS', {
    min: 1,
    check: checkSameKind(NUMERIC),
    call: eager((args, node) => {
      const v = expectType<number | Duration>(node, 0, args[0]!, NUMERIC);
      return typeof v === 'number' ? Math.abs(v) : new Duration(Math.abs(v.ms));
    }),
  }),
  def('ROUND', {
    min: 1,
    max: 2,
    check: checkPositional([['number'], ['number']], 'number'),
    call: eager((args, node) => {
      const x = expectNumber(node, 0, args[0]!);
      const digits = args.length > 1 ? expectNumber(node, 1, args[1]!) : 0;
      return roundHalfAwayFromZero(x, Math.trunc(digits));
    }),
  }),
  def('CLAMP', {
    min: 3,
    check: checkSameKind(ORDERABLE),
    call: eager((args, node) => {
      const { values } = sameKind(node, args, ORDERABLE);
      const [x, lo, hi] = values as [Orderable, Orderable, Orderable];
      if (numericKey(x) < numericKey(lo)) return lo;
      if (numericKey(x) > numericKey(hi)) return hi;
      return x;
    }),
  }),
  def('BETWEEN', {
    min: 3,
    check: checkSameKind(ORDERABLE, 'boolean'),
    call: eager((args, node) => {
      const { values, type } = sameKind(node, args, ORDERABLE);
      const [x, lo, hi] = values.map(numericKey) as [number, number, number];
      // A time-of-day range whose start is after its end wraps around midnight.
      if (type === 'timeofday' && lo > hi) return x >= lo || x <= hi;
      return x >= lo && x <= hi;
    }),
  }),
  def('COUNT', {
    min: 1,
    max: VARIADIC,
    check: () => 'number',
    call: eager((args) => args.filter((v) => v !== null).length, false),
  }),

  // ---- text ---------------------------------------------------------------------------------
  def('TEXT', { min: 1, check: () => 'string', call: eager((args) => toText(args[0]!), false) }),
  def('LOWER', { min: 1, check: checkEach(['string'], 'string'), call: eager((args, node) => expectString(node, 0, args[0]!).toLowerCase()) }),
  def('UPPER', { min: 1, check: checkEach(['string'], 'string'), call: eager((args, node) => expectString(node, 0, args[0]!).toUpperCase()) }),

  // ---- time ---------------------------------------------------------------------------------
  def('NOW', { min: 0, time: true, check: () => 'timestamp', call: (_n, ctx) => new Timestamp(ctx.now()) }),
  def('TIME', {
    min: 0,
    time: true,
    check: () => 'timeofday',
    // Whole seconds: TIME() = 07:30 should hold for the entire 07:30:00 second.
    call: (_n, ctx) => new TimeOfDay(Math.floor(localParts(ctx.now(), ctx.tz).msSinceMidnight / 1000) * 1000),
  }),
  def('WEEKDAY', { min: 0, time: true, check: () => 'number', call: (_n, ctx) => localParts(ctx.now(), ctx.tz).weekday }),
  def('ISWEEKDAY', { min: 0, time: true, check: () => 'boolean', call: (_n, ctx) => localParts(ctx.now(), ctx.tz).weekday <= 5 }),
  def('ISWEEKEND', { min: 0, time: true, check: () => 'boolean', call: (_n, ctx) => localParts(ctx.now(), ctx.tz).weekday >= 6 }),
  def('HOUR', { min: 0, time: true, check: () => 'number', call: (_n, ctx) => localParts(ctx.now(), ctx.tz).hour }),
  def('MINUTE', { min: 0, time: true, check: () => 'number', call: (_n, ctx) => localParts(ctx.now(), ctx.tz).minute }),
  def('TODAY', {
    min: 1,
    time: true,
    check: checkEach(['timeofday'], 'timestamp'),
    call: eager((args, node, ctx) => {
      const tod = expectType<TimeOfDay>(node, 0, args[0]!, ['timeofday']);
      return new Timestamp(todayAt(ctx.now(), ctx.tz, tod.ms));
    }),
  }),
  def('SUNRISE', { min: 0, time: true, check: () => 'timestamp', call: (_n, ctx) => new Timestamp(ctx.sunrise(ctx.now())) }),
  def('SUNSET', { min: 0, time: true, check: () => 'timestamp', call: (_n, ctx) => new Timestamp(ctx.sunset(ctx.now())) }),
  def('SECONDS', { min: 1, check: checkEach(['duration'], 'number'), call: eager((args, node) => expectDuration(node, 0, args[0]!).ms / 1000) }),
  def('MINUTES', { min: 1, check: checkEach(['duration'], 'number'), call: eager((args, node) => expectDuration(node, 0, args[0]!).ms / 60_000) }),
  def('HOURS', { min: 1, check: checkEach(['duration'], 'number'), call: eager((args, node) => expectDuration(node, 0, args[0]!).ms / 3_600_000) }),

  // ---- history ------------------------------------------------------------------------------
  def('SINCE', {
    min: 1,
    max: 2,
    time: true,
    refArgs: [0],
    check: (_argTypes, args, report) => {
      const value = args[1];
      if (value && !isLiteralNode(value)) report('SINCE expects a literal value as argument 2', value.span);
      return 'duration';
    },
    call: (node, ctx, ev) => {
      const ref = refName(node, 0);
      const valueArg = node.args[1];
      const since = valueArg ? ctx.since(ref, ev(valueArg, ctx)) : ctx.since(ref);
      return since ?? null;
    },
  }),
  def('PREV', {
    min: 1,
    refArgs: [0],
    check: (argTypes) => argTypes[0] ?? 'any',
    call: (node, ctx) => ctx.prev(refName(node, 0)) ?? null,
  }),
  def('CHANGED', {
    min: 1,
    refArgs: [0],
    check: () => 'boolean',
    call: (node, ctx) => ctx.changed(refName(node, 0)),
  }),
  def('HOLD', {
    min: 2,
    time: true,
    refArgs: [0],
    check: (argTypes, args, report) => {
      const [cell, dur] = argTypes as [ValueType, ValueType];
      if (!isUnknown(cell) && cell !== 'boolean') report(`HOLD expects a boolean cell as argument 1, got ${cell}`, args[0]!.span);
      if (!isUnknown(dur) && dur !== 'duration') report(`HOLD expects a duration as argument 2, got ${dur}`, args[1]!.span);
      return 'boolean';
    },
    call: (node, ctx, ev) => {
      const ref = refName(node, 0);
      const dur = ev(node.args[1]!, ctx);
      if (dur === null) return null;
      const d = expectDuration(node, 1, dur);
      const current = ctx.get(ref) ?? null;
      if (current === null) return null;
      if (expectBoolean(node, 0, current) === false) return false;
      const since = ctx.since(ref, false);
      if (!since) return null;
      return since.ms >= d.ms;
    },
  }),
];

export const FUNCTIONS: ReadonlyMap<string, FunctionDef> = new Map(DEFINITIONS.map((d) => [d.name, d]));

export function lookupFunction(name: string): FunctionDef | undefined {
  return FUNCTIONS.get(name.toUpperCase());
}

/** Human-readable arity description for error messages: "2 arguments", "at least 1 argument", "1 to 2 arguments". */
export function describeArity(fn: FunctionDef): string {
  const plural = (n: number): string => (n === 1 ? 'argument' : 'arguments');
  if (fn.maxArgs === Infinity) return `at least ${fn.minArgs} ${plural(fn.minArgs)}`;
  if (fn.minArgs === fn.maxArgs) return `${fn.minArgs} ${plural(fn.minArgs)}`;
  return `${fn.minArgs} to ${fn.maxArgs} arguments`;
}
