/**
 * Public entry point of the formula language. Everything outside `formula/` imports from here.
 */
import type { Ast, FormulaApi, SinceTarget } from './api.js';
import { Duration, TimeOfDay, formatDuration, valuesEqual, type Value } from './values.js';
import { parse } from './parser.js';
import { typeCheck } from './typecheck.js';
import { evaluate } from './evaluator.js';
import { isLiteralNode, isRefNode, lookupFunction } from './functions.js';

export * from './api.js';
export * from './values.js';
export { localParts, todayAt, offsetAt, wallClockToEpoch, type LocalParts } from './time.js';

function walk(ast: Ast, visit: (node: Ast) => void): void {
  visit(ast);
  switch (ast.kind) {
    case 'unary':
      walk(ast.operand, visit);
      break;
    case 'binary':
      walk(ast.left, visit);
      walk(ast.right, visit);
      break;
    case 'call':
      for (const arg of ast.args) walk(arg, visit);
      break;
    default:
      break;
  }
}

function refs(ast: Ast): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  walk(ast, (node) => {
    if (node.kind === 'ref' && !seen.has(node.name)) {
      seen.add(node.name);
      out.push(node.name);
    }
  });
  return out;
}

function isTimeDependent(ast: Ast): boolean {
  let result = false;
  walk(ast, (node) => {
    if (node.kind === 'call' && lookupFunction(node.name)?.timeDependent) result = true;
  });
  return result;
}

/** Value of a literal AST node (undefined for non-literals). */
function literalValue(ast: Ast): Value | undefined {
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
    default:
      return undefined;
  }
}

function sinceTargets(ast: Ast): SinceTarget[] {
  const out: SinceTarget[] = [];
  const add = (ref: string, value: Value | undefined): void => {
    if (out.some((t) => t.ref === ref && (t.value === undefined ? value === undefined : value !== undefined && valuesEqual(t.value, value)))) return;
    out.push({ ref, value });
  };
  walk(ast, (node) => {
    if (node.kind !== 'call') return;
    const first = node.args[0];
    if (!first || !isRefNode(first)) return;
    if (node.name === 'SINCE') {
      const second = node.args[1];
      if (!second) add(first.name, undefined);
      else if (isLiteralNode(second)) add(first.name, literalValue(second));
    } else if (node.name === 'HOLD') {
      add(first.name, false);
    }
  });
  return out;
}

// ---- formatting --------------------------------------------------------------------------------

const PREC_COMPARISON = 1;
const PREC_ADDITIVE = 2;
const PREC_TERM = 3;
const PREC_UNARY = 4;
const PREC_PRIMARY = 5;

function precedence(ast: Ast): number {
  switch (ast.kind) {
    case 'binary':
      if (ast.op === '*' || ast.op === '/') return PREC_TERM;
      if (ast.op === '+' || ast.op === '-' || ast.op === '&') return PREC_ADDITIVE;
      return PREC_COMPARISON;
    case 'unary':
      return PREC_UNARY;
    default:
      return PREC_PRIMARY;
  }
}

function format(ast: Ast): string {
  switch (ast.kind) {
    case 'number':
      return String(ast.value);
    case 'string':
      return `"${ast.value.replace(/"/g, '""')}"`;
    case 'boolean':
      return ast.value ? 'TRUE' : 'FALSE';
    case 'null':
      return 'NULL';
    case 'duration':
      return formatDuration(ast.ms);
    case 'timeofday':
      return new TimeOfDay(ast.ms).toString();
    case 'ref':
      return ast.name;
    case 'unary': {
      const inner = format(ast.operand);
      return precedence(ast.operand) < PREC_UNARY ? `-(${inner})` : `-${inner}`;
    }
    case 'binary': {
      const prec = precedence(ast);
      // Left operand: parenthesize when it binds looser than this node, or equally for a
      // comparison (non-associative). Right operand: also when equal, since the arithmetic
      // operators are left-associative.
      const leftNeedsParens = prec === PREC_COMPARISON ? precedence(ast.left) <= prec : precedence(ast.left) < prec;
      const left = leftNeedsParens ? `(${format(ast.left)})` : format(ast.left);
      const right = precedence(ast.right) <= prec ? `(${format(ast.right)})` : format(ast.right);
      return `${left} ${ast.op} ${right}`;
    }
    case 'call':
      return `${ast.name.toUpperCase()}(${ast.args.map(format).join(', ')})`;
  }
}

export const formula: FormulaApi = {
  parse,
  refs,
  isTimeDependent,
  sinceTargets,
  typeCheck,
  evaluate,
  format,
};
