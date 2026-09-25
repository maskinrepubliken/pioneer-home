/**
 * State and actions for the live table editor in the Tables view. There is no edit mode: the table page keeps
 * one editable copy of the table it shows (`tableEdit.current`), cells are changed in place, and a save bar
 * appears as soon as the copy differs from the file the engine has. Lives outside the component so an unsaved
 * edit survives switching view; App.svelte uses `isDirty()` for the navigation and beforeunload guards.
 * Grid mode edits `parsed` (serialised on demand), raw mode edits `raw`; switching mode converts one to the other.
 */
import { saveTable, type TableError } from './api';
import { home, loadTables } from './state.svelte';
import { isEmptyRow, padRow, parseTsv, serialiseTsv, type ParsedTsv } from './tsv';

export const VALIDATE_DEBOUNCE_MS = 600;
/** How long "Sparat." stays in the save bar after a successful save. */
export const SAVED_MESSAGE_MS = 4000;
/** Tables whose columns are user-defined (scene names) and may be added from the grid. */
export const GRID_TABLES = ['scenes.tsv'];

export type Validation =
  | { state: 'idle' }
  | { state: 'pending' }
  | { state: 'ok' }
  | { state: 'errors'; errors: TableError[] }
  | { state: 'failed'; message: string };

export interface TableEdit {
  file: string;
  mode: 'grid' | 'raw';
  parsed: ParsedTsv;
  raw: string;
  /** The text as last loaded from or saved to the engine. */
  original: string;
  validation: Validation;
  saving: boolean;
  /** "Kasta N ändringar?" question is open. */
  confirmDiscard: boolean;
  /** Result of the last save, shown in the save bar until the next change (or for a few seconds when it succeeded). */
  saveMessage: { text: string; error: boolean } | null;
}

export const tableEdit = $state<{ current: TableEdit | null; guardNotice: string | null }>({ current: null, guardNotice: null });

/**
 * The grid cell that is being edited or was edited last, so the help panel can insert a formula or cell id
 * into it even after the user clicked a button in the panel (which committed the cell and removed its input).
 * `el` is the input while it is mounted. `wanted` asks the grid to reopen a cell (after an insert into a
 * committed cell); the grid watches it.
 */
export const editorFocus = $state<{
  el: HTMLInputElement | null;
  file: string | null;
  row: number;
  col: number;
  wanted: { row: number; col: number; seq: number } | null;
}>({ el: null, file: null, row: -1, col: -1, wanted: null });

export function rememberFocus(el: HTMLInputElement | null, file: string, row: number, col: number): void {
  editorFocus.el = el;
  editorFocus.file = file;
  editorFocus.row = row;
  editorFocus.col = col;
}

/** Called by the grid when the input of the remembered cell unmounts (the cell was committed). */
export function forgetFocusElement(el: HTMLInputElement): void {
  if (editorFocus.el === el) editorFocus.el = null;
}

/** True when there is a grid cell to insert into: one being edited, or the last one edited in the current table. */
export function canInsert(): boolean {
  const edit = tableEdit.current;
  return !!edit && edit.mode === 'grid' && editorFocus.file === edit.file && editorFocus.row >= 0 && editorFocus.row < edit.parsed.rows.length && editorFocus.col >= 0;
}

/**
 * Inserts `text` into the remembered cell: at the caret when its input is mounted, otherwise appended to the
 * committed value (the grid then reopens the cell with the caret at the end). Returns false when there is none.
 */
export function insertAtFocus(text: string): boolean {
  if (!canInsert()) return false;
  const el = editorFocus.el;
  const { row, col } = editorFocus;
  if (el && el.isConnected) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.setRangeText(text, start, end, 'end');
    setCell(row, col, el.value);
    el.focus();
    return true;
  }
  const cur = tableEdit.current!.parsed.rows[row]?.[col] ?? '';
  const sep = cur === '' || /\s$/.test(cur) ? '' : ' ';
  setCell(row, col, cur + sep + text);
  editorFocus.wanted = { row, col, seq: (editorFocus.wanted?.seq ?? 0) + 1 };
  return true;
}

export function isGridTable(file: string): boolean {
  return GRID_TABLES.includes(file);
}

function fresh(file: string, text: string, keep?: Pick<TableEdit, 'mode' | 'saveMessage'>): TableEdit {
  return {
    file,
    mode: keep?.mode ?? 'grid',
    parsed: parseTsv(text),
    raw: text,
    original: text,
    validation: { state: 'idle' },
    saving: false,
    confirmDiscard: false,
    saveMessage: keep?.saveMessage ?? null,
  };
}

/** Starts the live editor for `file` with its current text from /api/tables. Replaces any other (clean) edit. */
export function beginEdit(file: string): void {
  const text = home.tables?.files[file];
  if (text === undefined) return;
  cancelPendingValidation();
  clearSavedTimer();
  tableEdit.current = fresh(file, text);
  editorFocus.el = null;
  editorFocus.file = null;
  editorFocus.row = -1;
  editorFocus.col = -1;
}

/**
 * Keeps a clean editor in step with the engine: when the file changed on the server (hot reload, another
 * browser, our own save) and nothing is edited locally, the new text becomes the editor's text. A dirty
 * editor is left alone (the page shows that the file is stale instead).
 */
export function syncFromServer(file: string): void {
  const edit = tableEdit.current;
  const server = home.tables?.files[file];
  if (server === undefined) return;
  if (!edit || edit.file !== file) {
    beginEdit(file);
    return;
  }
  if (edit.original === server || isDirty(edit)) return;
  cancelPendingValidation();
  tableEdit.current = fresh(file, server, { mode: edit.mode, saveMessage: edit.saveMessage });
}

export function closeEdit(): void {
  cancelPendingValidation();
  clearSavedTimer();
  tableEdit.current = null;
  editorFocus.el = null;
  editorFocus.file = null;
}

/** The text that would be saved right now. */
export function currentText(edit: TableEdit = tableEdit.current!): string {
  return edit.mode === 'grid' ? serialiseTsv(edit.parsed) : edit.raw;
}

export function isDirty(edit: TableEdit | null = tableEdit.current): boolean {
  if (!edit) return false;
  const text = currentText(edit);
  return text !== edit.original && text !== serialiseTsv(parseTsv(edit.original));
}

/** True when the engine's copy changed since the edit began (hot reload, another browser). */
export function isStale(edit: TableEdit | null = tableEdit.current): boolean {
  if (!edit) return false;
  const server = home.tables?.files[edit.file];
  return server !== undefined && server !== edit.original;
}

export function setMode(mode: 'grid' | 'raw'): void {
  const edit = tableEdit.current;
  if (!edit || edit.mode === mode) return;
  if (mode === 'raw') edit.raw = serialiseTsv(edit.parsed);
  else edit.parsed = parseTsv(edit.raw);
  edit.mode = mode;
  editorFocus.el = null;
}

export function setCell(row: number, col: number, value: string): void {
  const edit = tableEdit.current;
  const r = edit?.parsed.rows[row];
  if (!edit || !r) return;
  while (r.length <= col) r.push('');
  if (r[col] === value) return;
  r[col] = value;
  touched(edit);
}

/** Inserts an empty row after `after` (-1 = at the top). Returns the new row's index. */
export function insertRow(after: number): number {
  const edit = tableEdit.current;
  if (!edit) return -1;
  const at = Math.min(Math.max(after + 1, 0), edit.parsed.rows.length);
  edit.parsed.rows.splice(at, 0, padRow([], edit.parsed.header.length));
  touched(edit);
  return at;
}

/** Inserts a copy of `row` right below it. Returns the new row's index. */
export function duplicateRow(row: number): number {
  const edit = tableEdit.current;
  const r = edit?.parsed.rows[row];
  if (!edit || !r) return -1;
  edit.parsed.rows.splice(row + 1, 0, [...r]);
  touched(edit);
  return row + 1;
}

export function deleteRow(row: number): void {
  const edit = tableEdit.current;
  if (!edit || row < 0 || row >= edit.parsed.rows.length) return;
  edit.parsed.rows.splice(row, 1);
  touched(edit);
}

/** Adds a column to the header (and an empty cell to every row). Returns a Swedish error message or null. */
export function addColumn(name: string): string | null {
  const edit = tableEdit.current;
  if (!edit) return 'ingen tabell redigeras';
  const trimmed = name.trim();
  if (!trimmed) return 'Ange ett kolumnnamn';
  if (/\t/.test(trimmed)) return 'Kolumnnamnet får inte innehålla tabb';
  if (edit.parsed.header.some((h) => h.toLowerCase() === trimmed.toLowerCase())) return `Kolumnen "${trimmed}" finns redan`;
  edit.parsed.header.push(trimmed);
  for (const r of edit.parsed.rows) while (r.length < edit.parsed.header.length) r.push('');
  touched(edit);
  return null;
}

export function setRaw(text: string): void {
  const edit = tableEdit.current;
  if (!edit || edit.raw === text) return;
  edit.raw = text;
  touched(edit);
}

function touched(edit: TableEdit): void {
  edit.saveMessage = null;
  edit.confirmDiscard = false;
  clearSavedTimer();
  scheduleValidation();
}

let validateTimer: ReturnType<typeof setTimeout> | null = null;
let validateSeq = 0;

function cancelPendingValidation(): void {
  if (validateTimer) clearTimeout(validateTimer);
  validateTimer = null;
  validateSeq++;
}

/** Debounced validateOnly PUT; stale responses are ignored. */
export function scheduleValidation(delay = VALIDATE_DEBOUNCE_MS): void {
  const edit = tableEdit.current;
  if (!edit) return;
  if (validateTimer) clearTimeout(validateTimer);
  edit.validation = { state: 'pending' };
  validateTimer = setTimeout(() => {
    validateTimer = null;
    void validateNow();
  }, delay);
}

export async function validateNow(): Promise<void> {
  const edit = tableEdit.current;
  if (!edit) return;
  const seq = ++validateSeq;
  const file = edit.file;
  const text = currentText(edit);
  edit.validation = { state: 'pending' };
  try {
    const res = await saveTable(file, text, { validateOnly: true });
    if (seq !== validateSeq || tableEdit.current !== edit) return;
    edit.validation = res.ok && res.errors.length === 0 ? { state: 'ok' } : { state: 'errors', errors: res.errors };
  } catch (e) {
    if (seq !== validateSeq || tableEdit.current !== edit) return;
    edit.validation = { state: 'failed', message: (e as Error).message };
  }
}

export function canSave(edit: TableEdit | null = tableEdit.current): boolean {
  return !!edit && !edit.saving && edit.validation.state === 'ok' && isDirty(edit);
}

let savedTimer: ReturnType<typeof setTimeout> | null = null;
function clearSavedTimer(): void {
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = null;
}

/** PUT without validateOnly. On success the returned normalised text becomes the new original. */
export async function save(): Promise<void> {
  const edit = tableEdit.current;
  if (!edit || !canSave(edit)) return;
  const file = edit.file;
  const text = currentText(edit);
  edit.saving = true;
  edit.confirmDiscard = false;
  cancelPendingValidation();
  try {
    const res = await saveTable(file, text);
    if (tableEdit.current !== edit) return;
    if (res.status === 422) {
      edit.validation = { state: 'errors', errors: res.errors };
      edit.saveMessage = { text: 'Sparades inte: ändringen skulle göra konfigurationen ogiltig', error: true };
      return;
    }
    edit.original = res.text;
    edit.raw = res.text;
    if (edit.mode === 'grid') edit.parsed = parseTsv(res.text);
    edit.validation = { state: 'ok' };
    const msg = res.reloadError ? `Sparat, men motorn kunde inte läsa in ändringen: ${res.reloadError}` : 'Sparat. Motorn har läst in ändringen.';
    edit.saveMessage = { text: msg, error: !!res.reloadError };
    if (!res.reloadError) {
      clearSavedTimer();
      savedTimer = setTimeout(() => {
        if (tableEdit.current === edit && edit.saveMessage?.text === msg) edit.saveMessage = null;
        savedTimer = null;
      }, SAVED_MESSAGE_MS);
    }
    if (home.tables) home.tables.files[file] = res.text;
    await loadTables();
  } catch (e) {
    if (tableEdit.current !== edit) return;
    edit.saveMessage = { text: `Kunde inte spara ${file}: ${(e as Error).message}`, error: true };
  } finally {
    edit.saving = false;
  }
}

/** Reverts every change to the last loaded/saved text. The editor stays live. */
export function discard(): void {
  const edit = tableEdit.current;
  if (!edit) return;
  cancelPendingValidation();
  clearSavedTimer();
  edit.parsed = parseTsv(edit.original);
  edit.raw = edit.original;
  edit.validation = { state: 'idle' };
  edit.confirmDiscard = false;
  edit.saveMessage = null;
  editorFocus.el = null;
}

let guardTimer: ReturnType<typeof setTimeout> | null = null;
/** Shows the "unsaved changes" notice inline in the Tables view for a few seconds. */
export function showGuard(what: string): void {
  const file = tableEdit.current?.file ?? 'tabellen';
  tableEdit.guardNotice = `Osparade ändringar i ${file}: spara eller ångra dem innan du ${what}.`;
  if (guardTimer) clearTimeout(guardTimer);
  guardTimer = setTimeout(() => (tableEdit.guardNotice = null), 6000);
}

export function clearGuard(): void {
  if (guardTimer) clearTimeout(guardTimer);
  guardTimer = null;
  tableEdit.guardNotice = null;
}

// ---------------------------------------------------------------------------------------------------------
// What changed: rows and cells that differ from the saved file, for the markers and the "N ändringar" count
// ---------------------------------------------------------------------------------------------------------

export interface ChangeSet {
  /** Grid row index -> set of changed column indexes (every column for a new row). */
  rows: Map<number, Set<number>>;
  /** Rows of the original that are no longer present. */
  deleted: number;
  /** Header columns that are new. */
  addedColumns: number;
  /** Comment lines that differ (only editable in raw mode). */
  comments: number;
  /** Everything above added up: the number shown in the save bar. */
  total: number;
}

const rowKey = (r: readonly string[]) => serialiseRow(r);
function serialiseRow(r: readonly string[]): string {
  const cells = r.map((c) => c.trim());
  while (cells.length > 1 && cells[cells.length - 1] === '') cells.pop();
  return cells.join('\t');
}

/**
 * Compares the current table with the original. Rows are matched by content first; a changed row is paired
 * with the original row at the same index when that one is not itself still present, otherwise with the
 * original row that shares the most cells (at least one non-empty). Rows without a partner count as new.
 */
export function changeSet(current: ParsedTsv, original: ParsedTsv): ChangeSet {
  const rows = new Map<number, Set<number>>();
  const origRows = original.rows.filter((r) => !isEmptyRow(r));
  const curRows = current.rows;
  const curKeys = new Set(curRows.filter((r) => !isEmptyRow(r)).map(rowKey));
  const origKeys = new Map<string, number>();
  for (const r of origRows) origKeys.set(rowKey(r), (origKeys.get(rowKey(r)) ?? 0) + 1);

  // originals still present as-is are taken; the rest may be paired with changed rows
  const free = origRows.map((r) => !curKeys.has(rowKey(r)));
  const width = Math.max(current.header.length, original.header.length);
  const same = (a: readonly string[], b: readonly string[]) => {
    let n = 0;
    for (let i = 0; i < width; i++) if ((a[i] ?? '').trim() !== '' && (a[i] ?? '').trim() === (b[i] ?? '').trim()) n++;
    return n;
  };

  let total = 0;
  curRows.forEach((r, ri) => {
    if (isEmptyRow(r)) return;
    if (origKeys.has(rowKey(r))) return;
    // find a partner
    let partner = -1;
    if (free[ri] && origRows[ri] && same(r, origRows[ri]!) > 0) partner = ri;
    else {
      let best = 0;
      origRows.forEach((o, oi) => {
        if (!free[oi]) return;
        const n = same(r, o);
        if (n > best) {
          best = n;
          partner = oi;
        }
      });
    }
    const cols = new Set<number>();
    if (partner >= 0) {
      free[partner] = false;
      const o = origRows[partner]!;
      for (let i = 0; i < width; i++) if ((r[i] ?? '').trim() !== (o[i] ?? '').trim()) cols.add(i);
      if (cols.size === 0) cols.add(0);
    } else {
      for (let i = 0; i < current.header.length; i++) cols.add(i);
    }
    rows.set(ri, cols);
    total += partner >= 0 ? cols.size : 1;
  });

  const deleted = free.filter(Boolean).length;
  const addedColumns = Math.max(0, current.header.filter((h) => !original.header.some((o) => o.toLowerCase() === h.toLowerCase())).length);
  const origComments = new Set(original.comments.map((c) => c.trim()));
  const curComments = new Set(current.comments.map((c) => c.trim()));
  // an edited comment line is one change (one gone, one new), so count the larger side
  let added = 0;
  let removed = 0;
  for (const c of curComments) if (!origComments.has(c)) added++;
  for (const c of origComments) if (!curComments.has(c)) removed++;
  const comments = Math.max(added, removed);
  total += deleted + addedColumns + comments;
  return { rows, deleted, addedColumns, comments, total };
}

/** The change set of the current editor (grid or raw), or null. */
export function currentChanges(edit: TableEdit | null = tableEdit.current): ChangeSet | null {
  if (!edit) return null;
  const cur = edit.mode === 'grid' ? edit.parsed : parseTsv(edit.raw);
  return changeSet(cur, parseTsv(edit.original));
}

/** Row-and-cell lookup of validation errors for the grid, keyed by row index and `row:col`. */
export function errorMap(edit: TableEdit, rowIndexOfLine: (line: number) => number | null, columnIndex: (column: string | undefined) => number) {
  const rows = new Map<number, TableError[]>();
  const cells = new Map<string, TableError[]>();
  const other: TableError[] = [];
  if (edit.validation.state !== 'errors') return { rows, cells, other };
  for (const e of edit.validation.errors) {
    const r = e.file === edit.file ? rowIndexOfLine(e.line) : null;
    if (r === null) {
      other.push(e);
      continue;
    }
    rows.set(r, [...(rows.get(r) ?? []), e]);
    const c = columnIndex(e.column);
    if (c >= 0) {
      const key = `${r}:${c}`;
      cells.set(key, [...(cells.get(key) ?? []), e]);
    }
  }
  return { rows, cells, other };
}

/** `rad 7 [if]: unknown cell "x"` (with the file name in front when it is another file). */
export function describeError(e: TableError, file: string): string {
  const where = `rad ${e.line}${e.column ? ` [${e.column}]` : ''}`;
  return `${e.file && e.file !== file ? `${e.file} ` : ''}${where}: ${e.message}`;
}

/** "1 ändring" / "5 ändringar". */
export function changesLabel(n: number): string {
  return `${n} ${n === 1 ? 'ändring' : 'ändringar'}`;
}
