<script lang="ts">
  /**
   * The one grid of a table: cells render as text, a click (or Enter/F2 on a focused cell) turns the cell into
   * a field in place; blur, Enter (down) and Tab (right) commit it, Escape reverts it. Rows that differ from
   * the saved file get an ochre dot in the ⋯ column and changed cells sit sunken in ink. Rules get a live
   * "senast utlöst" column and cells.tsv a live "värde" column, both read-only. Raw mode is a textarea.
   * Validation errors are mapped to rows and cells and listed below; the save bar lives in TablePage.
   */
  import { tick, untrack } from 'svelte';
  import { columnDoc } from '../../lib/docs.sv';
  import { formatValue, relativeTime, roomName } from '../../lib/format';
  import { openHelp } from '../../lib/help.svelte';
  import { home } from '../../lib/state.svelte';
  import { breakSegments, columnTip, columnWidth } from '../../lib/tableColumns';
  import {
    addColumn,
    deleteRow,
    describeError,
    duplicateRow,
    editorFocus,
    errorMap,
    forgetFocusElement,
    insertRow,
    isGridTable,
    rememberFocus,
    setCell,
    setRaw,
    tableEdit,
    type ChangeSet,
  } from '../../lib/tableEdit.svelte';
  import { columnIndex, rowIndexOfLine } from '../../lib/tsv';

  let { file, changes, onhint }: { file: string; changes: ChangeSet | null; onhint: (column: string | null) => void } = $props();

  const edit = $derived(tableEdit.current && tableEdit.current.file === file ? tableEdit.current : null);
  const grid = $derived(edit?.parsed ?? null);
  const errors = $derived(edit && grid ? errorMap(edit, (line) => rowIndexOfLine(grid, line), (col) => columnIndex(grid, col)) : null);
  const rawErrors = $derived(edit?.validation.state === 'errors' ? edit.validation.errors : []);
  const widths = $derived(grid ? grid.header.map((h, i) => columnWidth(file, h, i)) : []);
  const helpTabs = $derived(grid ? grid.header.map((h) => columnDoc(file, h)?.help ?? null) : []);

  // ---- special rendering per table ----
  const col = (name: string) => grid?.header.findIndex((h) => h.toLowerCase() === name) ?? -1;
  const idIndex = $derived(col('id'));
  const whenIndex = $derived(file === 'rules.tsv' ? col('when') : -1);
  const enabledIndex = $derived(file === 'rules.tsv' ? col('enabled') : -1);
  const roomIndex = $derived(file === 'devices.tsv' ? col('room') : -1);
  const liveColumn = $derived(file === 'rules.tsv' ? 'senast utlöst' : file === 'cells.tsv' ? 'värde' : null);

  function liveFor(cells: string[]): string {
    const id = idIndex >= 0 ? (cells[idIndex] ?? '') : '';
    if (id === '') return '';
    if (file === 'rules.tsv') {
      const at = home.ruleFiredAt[id];
      return at ? relativeTime(at, home.now) : '';
    }
    const c = home.cells[id];
    return c ? formatValue(c.value, c.id, null, home.now) : '';
  }
  const isDisabled = (cells: string[]) => enabledIndex >= 0 && (cells[enabledIndex] ?? '').toLowerCase() === 'no';

  // ---- editing one cell ----
  let gridEl = $state<HTMLElement | null>(null);
  let editing = $state<{ r: number; c: number } | null>(null);
  /** Row that holds keyboard focus (a cell, its field or the ⋯ button): only that row shows the "?" buttons. */
  let activeRow = $state<number | null>(null);
  /** The value when the field opened, restored by Escape. */
  let openValue = '';

  const isEditing = (r: number, c: number) => editing !== null && editing.r === r && editing.c === c;

  function fieldEl(r: number, c: number): HTMLTextAreaElement | null {
    return gridEl?.querySelector<HTMLTextAreaElement>(`textarea[data-r="${r}"][data-c="${c}"]`) ?? null;
  }
  function cellEl(r: number, c: number): HTMLElement | null {
    return gridEl?.querySelector<HTMLElement>(`td[data-r="${r}"][data-c="${c}"]`) ?? null;
  }

  /** Opens the field for (r, c) and puts the caret at the end. */
  function startEdit(r: number, c: number) {
    if (!grid || r < 0 || r >= grid.rows.length || c < 0 || c >= grid.header.length) return;
    if (isEditing(r, c)) return;
    menuRow = null;
    editing = { r, c };
    openValue = grid.rows[r]?.[c] ?? '';
    void tick().then(() => {
      const el = fieldEl(r, c);
      if (!el) return;
      grow(el);
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  /** Closes the field of (r, c); the value is already in the store. Focus goes to the cell when asked. */
  function stopEdit(r: number, c: number, focusCell: boolean) {
    if (!isEditing(r, c)) return;
    editing = null;
    if (focusCell) void tick().then(() => cellEl(r, c)?.focus());
  }

  function grow(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  function onFieldInput(e: Event & { currentTarget: HTMLTextAreaElement }, r: number, c: number) {
    const el = e.currentTarget;
    // TSV cells hold neither tabs nor line breaks: pasted text is flattened.
    const clean = el.value.replace(/[\t\r\n]+/g, ' ');
    if (clean !== el.value) el.value = clean;
    setCell(r, c, clean);
    grow(el);
  }

  function onFieldKey(e: KeyboardEvent & { currentTarget: HTMLTextAreaElement }, r: number, c: number) {
    if (!grid) return;
    const cols = grid.header.length;
    const rows = grid.rows.length;
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      let nr = r;
      let nc = c + (e.shiftKey ? -1 : 1);
      if (nc >= cols) {
        nc = 0;
        nr++;
      } else if (nc < 0) {
        nc = cols - 1;
        nr--;
      }
      if (nr < 0 || nr >= rows) stopEdit(r, c, true);
      else startEdit(nr, nc);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (r + 1 < rows) startEdit(r + 1, c);
      else stopEdit(r, c, true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.currentTarget.value = openValue;
      setCell(r, c, openValue);
      stopEdit(r, c, true);
    }
  }

  function onFieldBlur(r: number, c: number) {
    // Only the field that is still the open one closes itself: when Enter/Tab already moved on, leave it.
    if (isEditing(r, c)) editing = null;
  }

  /** The textarea is mounted while (r, c) is being edited: remember it for the help panel, forget on unmount. */
  function fieldMounted(el: HTMLTextAreaElement, rc: { r: number; c: number }) {
    rememberFocus(el as unknown as HTMLInputElement, file, rc.r, rc.c);
    return {
      destroy() {
        forgetFocusElement(el as unknown as HTMLInputElement);
      },
    };
  }

  // The help panel inserted into a committed cell: reopen it so the user sees the caret where the text landed.
  $effect(() => {
    const w = editorFocus.wanted;
    if (!w || !edit) return;
    untrack(() => {
      startEdit(w.row, w.col);
      editorFocus.wanted = null;
    });
  });

  /** Keys on a cell that is not being edited: Enter/F2 open it, arrows move between cells. */
  function onCellKey(e: KeyboardEvent, r: number, c: number) {
    if (!grid) return;
    if (e.target !== e.currentTarget) return; // a key inside the field or a button
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      startEdit(r, c);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const nr = r + (e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0);
      const nc = c + (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0);
      const target = cellEl(nr, nc);
      if (target) {
        e.preventDefault();
        target.focus();
      }
    }
  }
  function onCellClick(e: MouseEvent, r: number, c: number) {
    // Clicks on the field itself or on a button inside the cell are theirs.
    if ((e.target as HTMLElement).closest('textarea, button')) return;
    startEdit(r, c);
  }

  function onRowFocusIn(r: number) {
    activeRow = r;
  }
  function onRowFocusOut(e: FocusEvent, r: number) {
    const row = e.currentTarget as HTMLElement;
    if (!row.contains(e.relatedTarget as Node | null) && activeRow === r) activeRow = null;
  }

  // ---- row menu ("⋯" at the row's right end) ----
  let menuRow = $state<number | null>(null);
  function toggleMenu(r: number) {
    menuRow = menuRow === r ? null : r;
  }
  function addRowAfter(r: number, c = 0) {
    const at = insertRow(r);
    menuRow = null;
    void tick().then(() => startEdit(at, c));
  }
  function duplicate(r: number) {
    const at = duplicateRow(r);
    menuRow = null;
    void tick().then(() => startEdit(at, 0));
  }
  function remove(r: number) {
    if (editing?.r === r) editing = null;
    deleteRow(r);
    menuRow = null;
  }
  /** Escape closes the open row menu (listened on window while a menu is open). */
  function onMenuKey(e: KeyboardEvent) {
    if (menuRow !== null && e.key === 'Escape') {
      e.preventDefault();
      menuRow = null;
    }
  }

  // ---- add column (scenes.tsv) ----
  let addingColumn = $state(false);
  let newColumn = $state('');
  let columnError = $state<string | null>(null);
  let columnInput = $state<HTMLInputElement | null>(null);

  function openAddColumn() {
    addingColumn = true;
    newColumn = '';
    columnError = null;
    void tick().then(() => columnInput?.focus());
  }
  function confirmAddColumn() {
    const err = addColumn(newColumn);
    if (err) {
      columnError = err;
      return;
    }
    addingColumn = false;
    newColumn = '';
    columnError = null;
  }
  function onColumnKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmAddColumn();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      addingColumn = false;
    }
  }

  // ---- raw textarea: Tab inserts a tab character ----
  function onRawKey(e: KeyboardEvent) {
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLTextAreaElement;
    el.setRangeText('\t', el.selectionStart, el.selectionEnd, 'end');
    setRaw(el.value);
  }
  const rawRows = $derived(edit ? Math.min(40, Math.max(8, edit.raw.split('\n').length + 1)) : 8);

  function rowTitle(r: number): string | undefined {
    const list = errors?.rows.get(r);
    return list && edit ? list.map((e) => describeError(e, edit.file)).join('\n') : undefined;
  }
  function cellTitle(r: number, c: number): string | undefined {
    const list = errors?.cells.get(`${r}:${c}`);
    if (list && edit) return list.map((e) => describeError(e, edit.file)).join('\n');
    return changes?.rows.get(r)?.has(c) ? 'Ändrad, inte sparad' : undefined;
  }
  const changedCell = (r: number, c: number) => changes?.rows.get(r)?.has(c) ?? false;
  const changedRow = (r: number) => changes?.rows.has(r) ?? false;
  const columnCount = $derived(grid ? grid.header.length + 1 + (isGridTable(file) ? 1 : 0) + (liveColumn ? 1 : 0) : 1);
</script>

<svelte:window onkeydown={onMenuKey} />

{#if edit && grid}
  {#if edit.mode === 'grid'}
    <div class="scroll" bind:this={gridEl}>
      <table class="tsv grid" role="grid" aria-label={file}>
        <thead>
          <tr>
            {#each grid.header as h, i (i)}
              <th class={'w-' + widths[i]} tabindex="0" title={columnTip(file, h)} onmouseenter={() => onhint(h)} onmouseleave={() => onhint(null)} onfocus={() => onhint(h)} onblur={() => onhint(null)}>{h}</th>
            {/each}
            {#if isGridTable(file)}
              <th class="addcol">
                {#if addingColumn}
                  <span class="addcol-form">
                    <input type="text" bind:this={columnInput} bind:value={newColumn} placeholder="scenens namn" size="14" onkeydown={onColumnKey} aria-label="Nytt kolumnnamn" />
                    <button class="btn small" onclick={confirmAddColumn}>Lägg till</button>
                    <button class="btn small" onclick={() => (addingColumn = false)}>Avbryt</button>
                    {#if columnError}<span class="danger-text">{columnError}</span>{/if}
                  </span>
                {:else}
                  <button class="btn small" onclick={openAddColumn} title="Lägg till en scen">+ kolumn</button>
                {/if}
              </th>
            {/if}
            {#if liveColumn}<th class="live" title="Läses från motorn just nu, står inte i filen">{liveColumn}</th>{/if}
            <th class="handle"><span class="sr">Ändrad, radmeny</span></th>
          </tr>
        </thead>
        <tbody>
          {#each grid.rows as row, ri (ri)}
            <tr
              class:error={errors?.rows.has(ri)}
              class:disabled={isDisabled(row)}
              class:menu-open={menuRow === ri}
              class:active={activeRow === ri}
              title={rowTitle(ri)}
              onfocusin={() => onRowFocusIn(ri)}
              onfocusout={(e) => onRowFocusOut(e, ri)}>
              {#each grid.header as _, ci (ci)}
                {@const v = row[ci] ?? ''}
                {@const open = isEditing(ri, ci)}
                <td
                  class={'cell w-' + widths[ci]}
                  class:id={ci === idIndex}
                  class:changed={changedCell(ri, ci)}
                  class:error={errors?.cells.has(`${ri}:${ci}`)}
                  class:open
                  data-r={ri}
                  data-c={ci}
                  tabindex={open ? -1 : 0}
                  title={cellTitle(ri, ci)}
                  aria-label={`${grid.header[ci]} rad ${ri + 1}`}
                  onclick={(e) => onCellClick(e, ri, ci)}
                  onkeydown={(e) => onCellKey(e, ri, ci)}>
                  <span class="field" class:with-help={helpTabs[ci] && activeRow === ri}>
                    {#if open}
                      <textarea
                        class="cell"
                        rows="1"
                        data-r={ri}
                        data-c={ci}
                        value={v}
                        spellcheck="false"
                        autocomplete="off"
                        autocapitalize="off"
                        aria-label={`${grid.header[ci]} rad ${ri + 1}`}
                        use:fieldMounted={{ r: ri, c: ci }}
                        oninput={(e) => onFieldInput(e, ri, ci)}
                        onkeydown={(e) => onFieldKey(e, ri, ci)}
                        onblur={() => onFieldBlur(ri, ci)}></textarea>
                    {:else if v === ''}
                      {#if ci === whenIndex}
                        <span class="text faint">vid stigande kant</span>
                      {:else}
                        <span class="text empty">&nbsp;</span>
                      {/if}
                    {:else if ci === enabledIndex && v.toLowerCase() === 'no'}
                      <span class="text"><span class="pill neutral">AVSTÄNGD</span></span>
                    {:else if ci === roomIndex}
                      <span class="text">{v} <span class="faint">{roomName(v, home.rooms)}</span></span>
                    {:else if widths[ci] === 'wide'}
                      <span class="text">{#each breakSegments(v) as seg, si (si)}{seg}<wbr />{/each}</span>
                    {:else}
                      <span class="text">{v}</span>
                    {/if}
                    {#if helpTabs[ci] && activeRow === ri}
                      <button
                        class="help"
                        title={helpTabs[ci] === 'actions' ? 'Hjälp om åtgärder' : 'Hjälp om formler'}
                        aria-label={helpTabs[ci] === 'actions' ? 'Hjälp om åtgärder' : 'Hjälp om formler'}
                        onmousedown={(e) => e.preventDefault()}
                        onclick={(e) => {
                          e.stopPropagation();
                          rememberFocus(fieldEl(ri, ci) as unknown as HTMLInputElement | null, file, ri, ci);
                          openHelp(helpTabs[ci]!);
                        }}>?</button>
                    {/if}
                  </span>
                </td>
              {/each}
              {#if isGridTable(file)}<td></td>{/if}
              {#if liveColumn}
                {@const live = liveFor(row)}
                <td class="live" class:fired={file === 'rules.tsv' && live !== ''}>{live === '' && file === 'rules.tsv' && (row[idIndex] ?? '') !== '' ? 'inte i denna session' : live}</td>
              {/if}
              <td class="handle">
                <span class="mark" class:changed={changedRow(ri)} title={changedRow(ri) ? 'Raden är ändrad, inte sparad' : undefined} aria-label={changedRow(ri) ? 'ändrad' : undefined}></span>
                <button class="rowbtn" title="Radmeny" aria-label="Radmeny för rad {ri + 1}" aria-expanded={menuRow === ri} onclick={() => toggleMenu(ri)}>⋯</button>
              </td>
            </tr>
            {#if menuRow === ri}
              <tr class="rowmenu">
                <td colspan={columnCount}>
                  <div class="menu" role="group" aria-label="Rad {ri + 1}">
                    <span class="faint">Rad {ri + 1}</span>
                    <button class="btn small" onclick={() => addRowAfter(ri)}>Lägg till rad under</button>
                    <button class="btn small" onclick={() => duplicate(ri)}>Duplicera rad</button>
                    <button class="btn small remove" onclick={() => remove(ri)}>Ta bort rad</button>
                    <button class="btn small" onclick={() => (menuRow = null)}>Stäng</button>
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
          {#if grid.rows.length === 0}
            <tr><td class="faint" colspan={columnCount}>inga rader</td></tr>
          {/if}
        </tbody>
      </table>
    </div>
    <div class="gridfoot">
      <button class="btn small" onclick={() => addRowAfter(grid!.rows.length - 1)}>+ rad</button>
      <span class="faint">Tryck på en cell för att ändra den · Tabb: nästa cell · Enter: raden under · Esc: ångra cellen</span>
    </div>
  {:else}
    <textarea class="raw" rows={rawRows} wrap="off" spellcheck="false" value={edit.raw} oninput={(e) => setRaw(e.currentTarget.value)} onkeydown={onRawKey} aria-label="Filens innehåll"></textarea>
    <div class="gridfoot"><span class="faint">Tabb infogar ett tabbtecken · kolumner skiljs av tabb · rader som börjar med # är kommentarer</span></div>
  {/if}

  {#if edit.validation.state === 'errors'}
    <div class="errors" id="table-errors">
      <strong class="danger-text">Fel som måste rättas</strong>
      <ul>
        {#each edit.mode === 'grid' && errors ? [...errors.rows.values()].flat().concat(errors.other) : rawErrors as e, i (i)}
          <li>{describeError(e, edit.file)}</li>
        {/each}
      </ul>
    </div>
  {/if}
{/if}

<style>
  .scroll {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    border: 1px solid var(--line);
    border-radius: var(--radius-m);
    background: var(--paper-raised);
  }
  /* "tabellrad": everything in a table is mono. Rows alternate raised/sunken, split by line. */
  table.tsv {
    border-collapse: collapse;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    min-width: 100%;
    color: var(--ink);
  }
  th,
  td {
    text-align: left;
    padding: 6px 12px;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
    white-space: nowrap;
  }
  tbody tr:last-child td {
    border-bottom: none;
  }
  tbody tr:nth-child(even) td {
    background: var(--paper-sunken);
  }
  /* "etikett" */
  th {
    position: sticky;
    top: 0;
    background: var(--paper-sunken);
    color: var(--ink-faint);
    font-weight: 400;
    font-size: 12px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    white-space: nowrap;
    cursor: help;
    z-index: 1;
  }
  th:hover {
    background: var(--paper-hover);
    color: var(--ink);
  }
  th.addcol,
  th.handle,
  th.live {
    cursor: default;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }

  /* cells */
  td.cell {
    color: var(--ink-muted);
    cursor: text;
    padding: 4px 8px;
  }
  td.cell.id {
    color: var(--ink);
  }
  td.cell:hover {
    background: var(--paper-hover);
  }
  td.cell:focus {
    outline: 2px solid var(--focus);
    outline-offset: -2px;
  }
  td.cell.open {
    padding: 2px 3px;
    background: var(--paper-raised);
  }
  /* what changed since the file was saved: ink on sunken */
  td.cell.changed {
    color: var(--ink);
    background: var(--paper-sunken);
  }
  td.cell.changed .text {
    border-bottom: 1px solid var(--line-strong);
  }
  td.cell.error {
    color: var(--alarm);
  }
  td.cell.error .text {
    border-bottom: 1px solid var(--alarm);
  }
  tr.disabled td.cell,
  tr.disabled td.cell.id {
    color: var(--ink-faint);
  }
  .field {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    min-width: 0;
  }
  .text {
    display: inline-block;
    padding: 2px 4px;
    min-width: 2ch;
  }
  .text.empty {
    min-width: 4ch;
  }
  /* widths: formulas/actions and notes wrap, ids and short phrases stay on one line */
  td.w-wide,
  td.w-note {
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }
  .w-wide {
    min-width: 28ch;
    max-width: 56ch;
  }
  .w-note {
    min-width: 24ch;
    max-width: 40ch;
  }
  .w-medium {
    min-width: 14ch;
  }
  .w-narrow {
    min-width: 6ch;
  }
  .w-id {
    min-width: 8ch;
  }

  /* the field: the same mono, sunken with a line-strong edge, the full cell width, grows with its text */
  textarea.cell {
    display: block;
    width: 100%;
    min-width: 6ch;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    color: var(--ink);
    background: var(--paper-sunken);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-s);
    padding: 2px 8px;
    margin: 0;
    min-height: 0;
    resize: none;
    overflow: hidden;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }
  textarea.cell:focus {
    background: var(--paper-raised);
    outline: 2px solid var(--focus);
    outline-offset: 0;
  }
  td.cell.error textarea.cell {
    border-color: var(--alarm);
    color: var(--alarm);
  }
  /* Phones: 16px stops the browser from zooming in on the field. */
  @media (max-width: 719px) {
    textarea.cell {
      font-size: 16px;
    }
  }

  /* the live column: read from the engine, not part of the file */
  .live {
    color: var(--ink-faint);
    border-left: 1px solid var(--line);
    white-space: nowrap;
  }
  td.live.fired {
    color: var(--ink);
  }

  /* the ⋯ column: sticky right, holds the changed mark and the row menu */
  table.grid th.handle,
  table.grid td.handle {
    position: sticky;
    right: 0;
    padding: 4px 6px 4px 8px;
    width: 1%;
    white-space: nowrap;
    text-align: right;
    background: var(--paper-raised);
    border-left: 1px solid var(--line);
  }
  table.grid th.handle {
    z-index: 2;
    background: var(--paper-sunken);
  }
  table.grid tbody tr:nth-child(even) td.handle,
  table.grid tr.error td.handle {
    background: var(--paper-sunken);
  }
  .mark {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 6px;
    vertical-align: middle;
    background: transparent;
  }
  .mark.changed {
    background: var(--ochre);
  }
  table.grid tr.error td:first-child {
    border-left: 3px solid var(--alarm);
  }
  tr.error td.cell {
    background: var(--paper-sunken);
  }
  .rowbtn,
  .help {
    background: var(--paper);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-pill);
    color: var(--ink-muted);
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1;
    width: 26px;
    height: 26px;
    padding: 0;
    flex-shrink: 0;
    vertical-align: middle;
  }
  .help {
    width: 22px;
    height: 22px;
    font-size: 12px;
    margin-top: 1px;
  }
  .rowbtn:hover,
  .help:hover {
    color: var(--ink);
    background: var(--paper-hover);
  }
  tr.menu-open .rowbtn {
    background: var(--ochre);
    border-color: var(--ochre);
    color: var(--on-ochre);
  }
  tr.rowmenu td {
    background: var(--paper-sunken);
    padding: var(--space-2) var(--space-3);
  }
  /* Sticks to the left edge of the scroll container so it is reachable however far the grid is scrolled. */
  .menu {
    position: sticky;
    left: var(--space-3);
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    font-size: 13px;
    max-width: calc(100vw - 2 * var(--space-5));
  }
  .btn.remove:hover {
    color: var(--alarm);
    border-color: var(--alarm);
  }
  .addcol-form {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
  }
  .addcol-form input {
    min-height: 28px;
    padding: 2px 10px;
    font-family: var(--font-mono);
    font-size: 13px;
  }
  .gridfoot {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    align-items: center;
    margin: var(--space-2) 2px;
    font-size: 13px;
    line-height: 1.5;
  }
  textarea.raw {
    display: block;
    width: 100%;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    tab-size: 8;
    color: var(--ink);
    background: var(--paper-sunken);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-m);
    padding: var(--space-3) var(--space-4);
    white-space: pre;
    overflow: auto;
    resize: vertical;
  }
  @media (max-width: 719px) {
    textarea.raw {
      font-size: 16px;
    }
  }
  .errors {
    margin: var(--space-2) 2px var(--space-4);
    font-size: 14px;
    line-height: 1.5;
  }
  .errors ul {
    margin: var(--space-1) 0 0;
    padding-left: 20px;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    color: var(--alarm);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
