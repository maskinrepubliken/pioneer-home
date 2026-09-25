/** Column layout helpers for the table grids. Pure functions, no Svelte. */
import { columnDoc, tableDoc } from './docs.sv';

/** scenes.tsv: user-defined columns that hold target tokens. */
function isGridDoc(file: string): boolean {
  return !!tableDoc(file)?.dynamicColumns;
}

/**
 * id: fits its content, never wraps. wide: formulas and actions, wraps. note: free text, wraps.
 * medium: short phrases on one line (rules `when`). narrow: a word or a number. normal: everything else.
 */
export type ColumnWidth = 'id' | 'wide' | 'note' | 'medium' | 'narrow' | 'normal';

const ID_COLUMNS = new Set(['id', 'key', 'device', 'record', 'sequence']);
const WIDE_COLUMNS = new Set(['formula', 'if', 'then', 'action', 'cancel_if']);
const MEDIUM_COLUMNS = new Set(['when', 'source', 'value']);
const NARROW_COLUMNS = new Set(['enabled', 'step', 'after', 'scale', 'min_interval', 'max_interval', 'min_delta', 'type', 'initial', 'kind', 'room', 'collection', 'field']);

/** Which width class a column gets, by header name and table. In scenes every non-first column holds target tokens. */
export function columnWidth(file: string, header: string, index: number): ColumnWidth {
  const h = header.toLowerCase();
  if (index === 0 && ID_COLUMNS.has(h)) return 'id';
  if (h === 'note') return 'note';
  if (WIDE_COLUMNS.has(h)) return 'wide';
  if (isGridDoc(file) && index > 0) return 'wide';
  if (MEDIUM_COLUMNS.has(h)) return 'medium';
  if (NARROW_COLUMNS.has(h)) return 'narrow';
  return 'normal';
}

/** Header tooltip text for a column: "what. Tillåtet: … Exempel: …". */
export function columnTip(file: string, header: string): string | undefined {
  const d = columnDoc(file, header);
  if (!d) return undefined;
  const parts = [d.what];
  if (d.allowed) parts.push(`Tillåtet: ${d.allowed}.`);
  parts.push(`Exempel: ${d.example}`);
  return parts.join(' ');
}

/**
 * Splits a formula or action into segments so the browser may break lines after commas, operators and
 * opening parentheses (rendered with <wbr> between segments) instead of clipping or breaking inside an id.
 */
export function breakSegments(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    cur += ch;
    const next = text[i + 1];
    const breakAfter = ch === ',' || ch === '(' || ch === ';' || ((ch === '<' || ch === '>' || ch === '=') && next !== '=' && next !== '>');
    if (breakAfter && next !== undefined) {
      out.push(cur);
      cur = '';
    } else if (ch === ' ' && next !== undefined && cur.trim() !== '') {
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}
