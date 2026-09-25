/**
 * Minimal TSV reader. Deliberately has no quoting rules: a field is everything between two tabs.
 * Lines starting with `#` and blank lines are ignored. The first non-comment line is the header.
 * Trailing empty fields may be omitted. Columns are addressed by header name, never by position.
 */
import { readFileSync } from 'node:fs';
import type { ConfigError } from './errors.js';

export interface TsvRow {
  /** 1-based line number in the file */
  line: number;
  /** column name -> trimmed cell text ('' when empty or omitted) */
  cells: Record<string, string>;
}

export interface TsvTable {
  file: string;
  header: string[];
  rows: TsvRow[];
}

export function parseTsv(text: string, file: string): TsvTable {
  const lines = text.split(/\r?\n/);
  let header: string[] | null = null;
  const rows: TsvRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    const fields = raw.split('\t').map((f) => f.trim());
    if (!header) {
      header = fields.map((h) => h.toLowerCase());
      continue;
    }
    const cells: Record<string, string> = {};
    header.forEach((h, idx) => {
      cells[h] = fields[idx] ?? '';
    });
    // Skip rows that are entirely empty (e.g. an all-tab separator line).
    if (Object.values(cells).every((v) => v === '')) continue;
    rows.push({ line: i + 1, cells });
  }
  return { file, header: header ?? [], rows };
}

export function readTsv(path: string, displayName = path): TsvTable {
  return parseTsv(readFileSync(path, 'utf8'), displayName);
}

/** Checks that required columns exist. Returns errors on line 1 (the header). */
export function requireColumns(table: TsvTable, required: string[]): ConfigError[] {
  const missing = required.filter((c) => !table.header.includes(c));
  if (missing.length === 0) return [];
  return [
    {
      file: table.file,
      line: 1,
      message: `missing column(s): ${missing.join(', ')} (header has: ${table.header.join(', ') || 'nothing'})`,
    },
  ];
}

/** Serialises rows back to TSV, one tab between fields, trailing empty fields dropped. Used by `home fmt`. */
export function formatTsv(header: string[], rows: string[][], comments: string[] = []): string {
  const out: string[] = [...comments, header.join('\t')];
  for (const r of rows) {
    const cells = [...r];
    while (cells.length > 1 && cells[cells.length - 1] === '') cells.pop();
    out.push(cells.join('\t'));
  }
  return out.join('\n') + '\n';
}

/** Normalises a TSV file in place: tabs only, trimmed cells, LF endings, comments preserved at the top. */
export function normaliseTsvText(text: string): string {
  const lines = text.split(/\r?\n/);
  const comments: string[] = [];
  const body: string[] = [];
  let seenHeader = false;
  for (const raw of lines) {
    if (raw.trim() === '') continue;
    if (raw.trimStart().startsWith('#') && !seenHeader) {
      comments.push(raw.trim());
      continue;
    }
    seenHeader = true;
    body.push(raw);
  }
  const rows = body.map((l) => l.split('\t').map((f) => f.trim()));
  const header = rows.shift() ?? [];
  return formatTsv(header, rows, comments);
}
