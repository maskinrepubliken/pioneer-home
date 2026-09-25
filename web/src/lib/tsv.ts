/**
 * TSV parsing and serialisation for the table editor. Pure functions, no Svelte.
 * Mirrors the engine's reader (engine/src/config/tsv.ts): tabs separate cells, no quoting, `#` lines are
 * comments, blank lines are ignored, the first other line is the header, trailing empty cells may be dropped.
 * Comment lines are collected wherever they appear and written back above the header (the only place the
 * grid can show them). Rows with fewer cells than the header are padded with ''.
 */

export interface ParsedTsv {
  /** Comment lines, verbatim (including the leading `#`). */
  comments: string[];
  header: string[];
  /** Data rows, each at least `header.length` cells long. */
  rows: string[][];
}

export function parseTsv(text: string): ParsedTsv {
  const comments: string[] = [];
  let header: string[] | null = null;
  const rows: string[][] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    if (raw.trimStart().startsWith('#')) {
      comments.push(raw.trim());
      continue;
    }
    const cells = raw.split('\t').map((c) => c.trim());
    if (!header) {
      header = cells;
      continue;
    }
    rows.push(padRow(cells, header.length));
  }
  return { comments, header: header ?? [], rows };
}

/** Returns a copy of `cells` with at least `width` entries. */
export function padRow(cells: readonly string[], width: number): string[] {
  const out = [...cells];
  while (out.length < width) out.push('');
  return out;
}

export function isEmptyRow(cells: readonly string[]): boolean {
  return cells.every((c) => c.trim() === '');
}

/**
 * Comments first, then the header, then one line per non-empty row. Cells are trimmed and joined by a single
 * tab, trailing empty cells are dropped (at least one cell is kept), LF line endings, trailing newline.
 */
export function serialiseTsv(parsed: ParsedTsv): string {
  const out: string[] = parsed.comments.map((c) => c.trim());
  if (parsed.header.length > 0) {
    out.push(parsed.header.map((h) => h.trim()).join('\t'));
    for (const row of parsed.rows) {
      if (isEmptyRow(row)) continue;
      const cells = row.map((c) => c.trim());
      while (cells.length > 1 && cells[cells.length - 1] === '') cells.pop();
      out.push(cells.join('\t'));
    }
  }
  return out.length ? out.join('\n') + '\n' : '';
}

/** 1-based line number of the header in the serialised text. */
export function headerLine(parsed: ParsedTsv): number {
  return parsed.comments.length + 1;
}

/**
 * 1-based line number that row `rowIndex` gets in `serialiseTsv(parsed)`, or -1 when the row is empty
 * (empty rows are not written) or out of range.
 */
export function lineNumberOfRow(parsed: ParsedTsv, rowIndex: number): number {
  const row = parsed.rows[rowIndex];
  if (!row || isEmptyRow(row)) return -1;
  let line = headerLine(parsed);
  for (let i = 0; i <= rowIndex; i++) {
    const r = parsed.rows[i];
    if (r && !isEmptyRow(r)) line++;
  }
  return line;
}

/** Inverse of lineNumberOfRow: the grid row that a serialised line number refers to, or null for comments/header. */
export function rowIndexOfLine(parsed: ParsedTsv, line: number): number | null {
  if (line <= headerLine(parsed)) return null;
  let current = headerLine(parsed);
  for (let i = 0; i < parsed.rows.length; i++) {
    const r = parsed.rows[i];
    if (r && !isEmptyRow(r)) {
      current++;
      if (current === line) return i;
    }
  }
  return null;
}

/** Index of a header column matched case-insensitively (the engine lowercases header names), or -1. */
export function columnIndex(parsed: ParsedTsv, column: string | undefined): number {
  if (!column) return -1;
  const needle = column.trim().toLowerCase();
  return parsed.header.findIndex((h) => h.trim().toLowerCase() === needle);
}
