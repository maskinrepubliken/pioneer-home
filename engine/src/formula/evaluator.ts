/**
 * Tree-walking evaluator with three-valued NULL logic.
 */
import { FormulaError, type Ast, type EvalContext } from './api.js';
import { Duration, TimeOfDay, Timestamp, typeOf, valuesEqual, type Value } from './values.js';
import { describeArity, lookupFunction, numericKey, toText, type CallNode } from './functions.js';
import { arithmeticType, comparisonOk, isComparisonOp, operatorError, type ArithmeticOp, type ComparisonOp } from './typecheck.js';

const DAY_MS = 86_400_000;

function wrapDay(ms: number): number {
  return ((ms % DAY_MS) + DAY_MS) % DAY_MS;
}

export function evaluate(ast: Ast, ctx: EvalContext): Value {
  switch (ast.kind) {
    case 'number':
    case 'string':
    case 'boolean':
      return ast.value;
    case 'null':
      return null;
    case 'duration':
      return new Duration(ast.ms);
    case 'timeofday':
      return new TimeOfDay(ast.ms);
    case 'ref':
      return ctx.get(ast.name) ?? null;
    case 'unary': {
      const v = evaluate(ast.operand, ctx);
      if (v === null) return null;
      if (typeof v === 'number') return -v;
      if (v instanceof Duration) return new Duration(-v.ms);
      throw new FormulaError(`Cannot negate ${typeOf(v)}`, ast.span);
    }
    case 'binary': {
      const l = evaluate(ast.left, ctx);
      const r = evaluate(ast.right, ctx);
      if (ast.op === '&') return toText(l) + toText(r);
      if (l === null || r === null) return null;
      if (isComparisonOp(ast.op)) return compare(ast.op, l, r, ast);
      return arithmetic(ast.op, l, r, ast);
    }
    case 'call':
      return call(ast, ctx);
  }
}

function call(node: CallNode, ctx: EvalContext): Value {
  const fn = lookupFunction(node.name);
  if (!fn) throw new FormulaError(`Unknown function ${node.name}`, node.span);
  if (node.args.length < fn.minArgs || node.args.length > fn.maxArgs) {
    throw new FormulaError(`${fn.name} expects ${describeArity(fn)}, got ${node.args.length}`, node.span);
  }
  return fn.call(node, ctx, evaluate);
}

type NonNull = Exclude<Value, null>;

function compare(op: ComparisonOp, l: NonNull, r: NonNull, node: Ast): boolean {
  const lt = typeOf(l);
  const rt = typeOf(r);
  if (!comparisonOk(op, lt, rt)) throw new FormulaError(operatorError(op, lt, rt), node.span);
  if (op === '=') return valuesEqual(l, r);
  if (op === '<>') return !valuesEqual(l, r);
  let a: number | string;
  let b: number | string;
  if (typeof l === 'string' && typeof r === 'string') {
    a = l;
    b = r;
  } else {
    a = numericKey(l as number | Duration | TimeOfDay | Timestamp);
    b = numericKey(r as number | Duration | TimeOfDay | Timestamp);
  }
  switch (op) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
  }
}

function arithmetic(op: ArithmeticOp, l: NonNull, r: NonNull, node: Ast): Value {
  const lt = typeOf(l);
  const rt = typeOf(r);
  const result = arithmeticType(op, lt, rt);
  if (result === null) throw new FormulaError(operatorError(op, lt, rt), node.span);
  const a = numericKey(l as number | Duration | TimeOfDay | Timestamp);
  const b = numericKey(r as number | Duration | TimeOfDay | Timestamp);
  let n: number;
  switch (op) {
    case '+':
      n = a + b;
      break;
    case '-':
      n = a - b;
      break;
    case '*':
      n = a * b;
      break;
    case '/':
      if (b === 0) return null;
      n = a / b;
      break;
  }
  switch (result) {
    case 'number':
      return n;
    case 'duration':
      return new Duration(n);
    case 'timestamp':
      return new Timestamp(n);
    case 'timeofday':
      return new TimeOfDay(wrapDay(n));
    default:
      throw new FormulaError(operatorError(op, lt, rt), node.span);
  }
}
