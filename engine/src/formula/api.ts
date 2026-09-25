/**
 * Public contract of the formula language. Everything outside `formula/` imports from here
 * (via `formula/index.ts`), never from the lexer/parser/evaluator files directly.
 */
import type { Duration, Value, ValueType } from './values.js';

/** Position inside the formula source, 0-based character offset. */
export interface SourceSpan {
  start: number;
  end: number;
}

export class FormulaError extends Error {
  constructor(
    message: string,
    readonly span: SourceSpan,
  ) {
    super(message);
    this.name = 'FormulaError';
  }
}

export type Ast =
  | { kind: 'number'; value: number; span: SourceSpan }
  | { kind: 'string'; value: string; span: SourceSpan }
  | { kind: 'boolean'; value: boolean; span: SourceSpan }
  | { kind: 'null'; span: SourceSpan }
  | { kind: 'duration'; ms: number; span: SourceSpan }
  | { kind: 'timeofday'; ms: number; span: SourceSpan }
  | { kind: 'ref'; name: string; span: SourceSpan }
  | { kind: 'unary'; op: '-'; operand: Ast; span: SourceSpan }
  | { kind: 'binary'; op: BinaryOp; left: Ast; right: Ast; span: SourceSpan }
  | { kind: 'call'; name: string; args: Ast[]; span: SourceSpan };

export type BinaryOp = '=' | '<>' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/' | '&';

/** What a formula can see while being evaluated. Implemented by the cell store and the simulator. */
export interface EvalContext {
  /** Current value of a cell. Unknown refs never reach evaluation (the loader rejects them). */
  get(ref: string): Value;
  /** Value the cell had before its most recent change, or null. */
  prev(ref: string): Value;
  /** True only during the pass in which `ref` changed. */
  changed(ref: string): boolean;
  /**
   * SINCE(ref)        -> time since the cell last changed (null if never set)
   * SINCE(ref, value) -> time since the cell last *had* `value`. 0s while it currently has it,
   *                      null if it never had it.
   */
  since(ref: string, value?: Value): Duration | null;
  /** Current time, epoch ms. The simulator supplies a fake clock. */
  now(): number;
  /** IANA time zone used by TIME(), WEEKDAY(), TODAY(), BETWEEN on time of day, etc. */
  tz: string;
  /** Sunrise / sunset for the local day containing `epochMs`, as epoch ms. */
  sunrise(epochMs: number): number;
  sunset(epochMs: number): number;
}

/** Declared type of each cell, used by the type checker at load time. Undefined = unknown ref. */
export type RefTypes = (ref: string) => ValueType | undefined;

export interface TypeCheckResult {
  /** Result type of the whole formula. 'any' when it cannot be determined statically. */
  type: ValueType;
  errors: FormulaError[];
}

/** A (ref, value) pair used by SINCE(ref, value); the store must track lastSeen for it. */
export interface SinceTarget {
  ref: string;
  value: Value | undefined;
}

export interface FormulaApi {
  /** Parses source text. Throws FormulaError on syntax errors. */
  parse(source: string): Ast;
  /** All cell refs mentioned, deduplicated, in first-seen order. */
  refs(ast: Ast): string[];
  /** True when the result can change with the clock alone (NOW, TIME, SINCE, SUNRISE...). */
  isTimeDependent(ast: Ast): boolean;
  /** (ref, value) pairs used in SINCE(ref, value) calls with literal values. */
  sinceTargets(ast: Ast): SinceTarget[];
  /** Static type check against declared cell types. Never throws. */
  typeCheck(ast: Ast, refTypes: RefTypes): TypeCheckResult;
  /** Evaluates with three-valued NULL logic. Throws FormulaError only for runtime type errors. */
  evaluate(ast: Ast, ctx: EvalContext): Value;
  /** Renders an AST back to canonical source (used by `home fmt` and traces). */
  format(ast: Ast): string;
}
