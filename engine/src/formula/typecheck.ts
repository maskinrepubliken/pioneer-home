/**
 * Static type checker and the operator typing rules shared with the evaluator.
 */
import { FormulaError, type Ast, type BinaryOp, type RefTypes, type SourceSpan, type TypeCheckResult } from './api.js';
import type { ValueType } from './values.js';
import { describeArity, isRefNode, lookupFunction, type CallNode } from './functions.js';

export type ArithmeticOp = '+' | '-' | '*' | '/';
export type ComparisonOp = '=' | '<>' | '<' | '<=' | '>' | '>=';

const ARITHMETIC_RULES: Record<ArithmeticOp, ReadonlyArray<readonly [ValueType, ValueType, ValueType]>> = {
  '+': [
    ['number', 'number', 'number'],
    ['duration', 'duration', 'duration'],
    ['timestamp', 'duration', 'timestamp'],
    ['duration', 'timestamp', 'timestamp'],
    ['timeofday', 'duration', 'timeofday'],
    ['duration', 'timeofday', 'timeofday'],
  ],
  '-': [
    ['number', 'number', 'number'],
    ['duration', 'duration', 'duration'],
    ['timestamp', 'duration', 'timestamp'],
    ['timestamp', 'timestamp', 'duration'],
    ['timeofday', 'timeofday', 'duration'],
    ['timeofday', 'duration', 'timeofday'],
  ],
  '*': [
    ['number', 'number', 'number'],
    ['number', 'duration', 'duration'],
    ['duration', 'number', 'duration'],
  ],
  '/': [
    ['number', 'number', 'number'],
    ['duration', 'number', 'duration'],
    ['duration', 'duration', 'number'],
  ],
};

export function isArithmeticOp(op: BinaryOp): op is ArithmeticOp {
  return op === '+' || op === '-' || op === '*' || op === '/';
}

export function isComparisonOp(op: BinaryOp): op is ComparisonOp {
  return op === '=' || op === '<>' || op === '<' || op === '<=' || op === '>' || op === '>=';
}

function isUnknown(t: ValueType): boolean {
  return t === 'any' || t === 'null';
}

/**
 * Result type of `a op b`, or null when the operator is not defined for the operand types.
 * Unknown operands (any/null) match every rule; when the matching rules disagree on the
 * result the answer is 'any'.
 */
export function arithmeticType(op: ArithmeticOp, a: ValueType, b: ValueType): ValueType | null {
  if (a === 'null' && b === 'null') return 'null';
  const results = new Set<ValueType>();
  for (const [l, r, res] of ARITHMETIC_RULES[op]) {
    if ((isUnknown(a) || a === l) && (isUnknown(b) || b === r)) results.add(res);
  }
  if (results.size === 0) return null;
  if (results.size === 1) return [...results][0]!;
  return 'any';
}

/** Whether `a op b` is a legal comparison. */
export function comparisonOk(op: ComparisonOp, a: ValueType, b: ValueType): boolean {
  if (isUnknown(a) || isUnknown(b)) return true;
  if (a !== b) return false;
  if (a === 'boolean' || a === 'string') return op === '=' || op === '<>' || a === 'string';
  return true;
}

export function operatorError(op: BinaryOp, a: ValueType, b: ValueType): string {
  switch (op) {
    case '+':
      return `Cannot add ${a} and ${b}`;
    case '-':
      return `Cannot subtract ${b} from ${a}`;
    case '*':
      return `Cannot multiply ${a} by ${b}`;
    case '/':
      return `Cannot divide ${a} by ${b}`;
    case '&':
      return `Cannot concatenate ${a} and ${b}`;
    default:
      if (a === b) return `Cannot compare ${a} values with ${op}`;
      return `Cannot compare ${a} with ${b}`;
  }
}

/** Static type check against declared cell types. Never throws; errors are collected. */
export function typeCheck(ast: Ast, refTypes: RefTypes): TypeCheckResult {
  const errors: FormulaError[] = [];
  const report = (message: string, span: SourceSpan): void => {
    errors.push(new FormulaError(message, span));
  };
  const type = check(ast, refTypes, report);
  return { type, errors };
}

type Report = (message: string, span: SourceSpan) => void;

function check(ast: Ast, refTypes: RefTypes, report: Report): ValueType {
  switch (ast.kind) {
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'duration':
      return 'duration';
    case 'timeofday':
      return 'timeofday';
    case 'ref': {
      const t = refTypes(ast.name);
      if (t === undefined) {
        report(`Unknown cell ${ast.name}`, ast.span);
        return 'any';
      }
      return t;
    }
    case 'unary': {
      const t = check(ast.operand, refTypes, report);
      if (isUnknown(t) || t === 'number' || t === 'duration') return t;
      report(`Cannot negate ${t}`, ast.span);
      return 'any';
    }
    case 'binary': {
      const lt = check(ast.left, refTypes, report);
      const rt = check(ast.right, refTypes, report);
      if (ast.op === '&') return 'string';
      if (isComparisonOp(ast.op)) {
        if (!comparisonOk(ast.op, lt, rt)) report(operatorError(ast.op, lt, rt), ast.span);
        return 'boolean';
      }
      const result = arithmeticType(ast.op, lt, rt);
      if (result === null) {
        report(operatorError(ast.op, lt, rt), ast.span);
        return 'any';
      }
      return result;
    }
    case 'call':
      return checkCall(ast, refTypes, report);
  }
}

function checkCall(node: CallNode, refTypes: RefTypes, report: Report): ValueType {
  const fn = lookupFunction(node.name);
  const argTypes = node.args.map((a) => check(a, refTypes, report));
  if (!fn) {
    report(`Unknown function ${node.name}`, node.span);
    return 'any';
  }
  if (node.args.length < fn.minArgs || node.args.length > fn.maxArgs) {
    report(`${fn.name} expects ${describeArity(fn)}, got ${node.args.length}`, node.span);
    return 'any';
  }
  let refsOk = true;
  for (const i of fn.refArgs) {
    const arg = node.args[i];
    if (arg && !isRefNode(arg)) {
      report(`${fn.name} expects a cell reference as argument ${i + 1}`, arg.span);
      refsOk = false;
    }
  }
  if (!refsOk) return 'any';
  return fn.check(argTypes, node.args, report, node);
}
