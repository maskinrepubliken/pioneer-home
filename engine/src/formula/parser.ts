/**
 * Recursive-descent parser producing the `Ast` from api.ts.
 *
 *   expr        := comparison
 *   comparison  := additive [ cmpop additive ]          (non-associative)
 *   additive    := term { ("+" | "-" | "&") term }
 *   term        := unary { ("*" | "/") unary }
 *   unary       := "-" unary | primary
 *   primary     := literal | call | ref | "(" expr ")"
 */
import { FormulaError, type Ast, type BinaryOp } from './api.js';
import { tokenize, type Token } from './lexer.js';

const COMPARISON_OPS: ReadonlySet<string> = new Set(['=', '<>', '<', '<=', '>', '>=']);
const ADDITIVE_OPS: ReadonlySet<string> = new Set(['+', '-', '&']);
const TERM_OPS: ReadonlySet<string> = new Set(['*', '/']);

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  peek(): Token {
    return this.tokens[this.pos]!;
  }

  next(): Token {
    const t = this.tokens[this.pos]!;
    if (t.type !== 'eof') this.pos++;
    return t;
  }

  unexpected(tok: Token, hint?: string): FormulaError {
    const what = tok.type === 'eof' ? 'end of input' : `token "${tok.text}"`;
    const suffix = hint ? `: ${hint}` : '';
    return new FormulaError(`Unexpected ${what} at ${tok.span.start}${suffix}`, tok.span);
  }

  expect(type: Token['type']): Token {
    const t = this.peek();
    if (t.type !== type) throw this.unexpected(t);
    return this.next();
  }

  isOp(ops: ReadonlySet<string>): boolean {
    const t = this.peek();
    return t.type === 'op' && ops.has(t.text);
  }

  parseExpr(): Ast {
    return this.parseComparison();
  }

  parseComparison(): Ast {
    const left = this.parseAdditive();
    if (!this.isOp(COMPARISON_OPS)) return left;
    const op = this.next().text as BinaryOp;
    const right = this.parseAdditive();
    if (this.isOp(COMPARISON_OPS)) {
      throw this.unexpected(this.peek(), 'comparisons cannot be chained');
    }
    return { kind: 'binary', op, left, right, span: { start: left.span.start, end: right.span.end } };
  }

  parseAdditive(): Ast {
    let left = this.parseTerm();
    while (this.isOp(ADDITIVE_OPS)) {
      const op = this.next().text as BinaryOp;
      const right = this.parseTerm();
      left = { kind: 'binary', op, left, right, span: { start: left.span.start, end: right.span.end } };
    }
    return left;
  }

  parseTerm(): Ast {
    let left = this.parseUnary();
    while (this.isOp(TERM_OPS)) {
      const op = this.next().text as BinaryOp;
      const right = this.parseUnary();
      left = { kind: 'binary', op, left, right, span: { start: left.span.start, end: right.span.end } };
    }
    return left;
  }

  parseUnary(): Ast {
    const t = this.peek();
    if (t.type === 'op' && t.text === '-') {
      this.next();
      const operand = this.parseUnary();
      return { kind: 'unary', op: '-', operand, span: { start: t.span.start, end: operand.span.end } };
    }
    return this.parsePrimary();
  }

  parsePrimary(): Ast {
    const t = this.peek();
    switch (t.type) {
      case 'number':
        this.next();
        return { kind: 'number', value: t.value as number, span: t.span };
      case 'string':
        this.next();
        return { kind: 'string', value: t.value as string, span: t.span };
      case 'duration':
        this.next();
        return { kind: 'duration', ms: t.value as number, span: t.span };
      case 'timeofday':
        this.next();
        return { kind: 'timeofday', ms: t.value as number, span: t.span };
      case 'true':
        this.next();
        return { kind: 'boolean', value: true, span: t.span };
      case 'false':
        this.next();
        return { kind: 'boolean', value: false, span: t.span };
      case 'null':
        this.next();
        return { kind: 'null', span: t.span };
      case 'ref':
        this.next();
        return { kind: 'ref', name: t.text, span: t.span };
      case 'func':
        return this.parseCall();
      case 'lparen': {
        this.next();
        const inner = this.parseExpr();
        this.expect('rparen');
        return inner;
      }
      default:
        throw this.unexpected(t);
    }
  }

  parseCall(): Ast {
    const nameTok = this.next();
    this.expect('lparen');
    const args: Ast[] = [];
    if (this.peek().type !== 'rparen') {
      args.push(this.parseExpr());
      while (this.peek().type === 'comma') {
        this.next();
        args.push(this.parseExpr());
      }
    }
    const close = this.expect('rparen');
    return {
      kind: 'call',
      name: nameTok.text.toUpperCase(),
      args,
      span: { start: nameTok.span.start, end: close.span.end },
    };
  }
}

/** Parses source text into an AST. Throws FormulaError on the first syntax error. */
export function parse(source: string): Ast {
  const parser = new Parser(tokenize(source));
  const ast = parser.parseExpr();
  const trailing = parser.peek();
  if (trailing.type !== 'eof') throw parser.unexpected(trailing);
  return ast;
}
