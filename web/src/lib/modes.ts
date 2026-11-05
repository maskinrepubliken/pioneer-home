/**
 * modes.tsv, the heating modes, for the editor on the Lägen page: a mode per row with its Swedish name and each
 * room's temperature in it. Pure functions, no Svelte. The engine compiles the table to cells (config/loader.ts):
 * heat_use_<mode>, <room>_<mode>, heat_transition and <room>_comfort.
 */
import { parseTsv } from './tsv';

/** A room's temperature in a mode: a number, or cold (the cell heat_cold), or another formula kept as it is. */
export type ModeTemp = { kind: 'number'; value: number } | { kind: 'cold' } | { kind: 'formula'; text: string };

export interface ModeRow {
  id: string;
  name: string;
  /** room id -> temperature */
  temps: Record<string, ModeTemp>;
  note: string;
}

export interface ModesTable {
  comments: string[];
  rooms: string[];
  modes: ModeRow[];
}

export const COLD = 'heat_cold';

function parseTemp(text: string): ModeTemp {
  const t = text.trim();
  if (!t || t === COLD) return { kind: 'cold' };
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? { kind: 'number', value: n } : { kind: 'formula', text: t };
}

function tempText(t: ModeTemp): string {
  return t.kind === 'cold' ? COLD : t.kind === 'number' ? String(t.value) : t.text;
}

export function parseModeTable(text: string): ModesTable {
  const t = parseTsv(text);
  const rooms = t.header.filter((h) => !['id', 'name', 'note'].includes(h));
  const col = (name: string) => t.header.indexOf(name);
  const modes = t.rows
    .filter((r) => r[col('id')])
    .map((r): ModeRow => ({
      id: r[col('id')]!,
      name: col('name') >= 0 ? (r[col('name')] ?? '') : '',
      temps: Object.fromEntries(rooms.map((room) => [room, parseTemp(r[col(room)] ?? '')])),
      note: col('note') >= 0 ? (r[col('note')] ?? '') : '',
    }));
  return { comments: t.comments, rooms, modes };
}

export function serializeModeTable(m: ModesTable): string {
  const lines = [...m.comments, ['id', 'name', ...m.rooms, 'note'].join('\t')];
  for (const row of m.modes) lines.push([row.id, row.name, ...m.rooms.map((r) => tempText(row.temps[r] ?? { kind: 'cold' })), row.note].join('\t'));
  return lines.join('\n') + '\n';
}

/** A mode id from a Swedish name: lowercase ASCII, å/ä -> a, ö -> o, everything else -> _, unique among `taken`. */
export function modeId(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[åä]/g, 'a')
      .replace(/ö/g, 'o')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^(\d)/, 'm_$1') || 'mode';
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}_${i}`;
  return id;
}
