<script lang="ts">
  /**
   * One table: title and file name, a switcher to the other tables, "Om tabellen" and "Kolumner" from
   * docs.sv.ts, the file comments behind a toggle, then the live grid (TableGrid). There is no edit mode:
   * the editor in lib/tableEdit is started for this file on mount and kept in step with the engine while
   * nothing is changed. A save bar sticks to the bottom as soon as something is. Mounted with {#key file}
   * so all local state is per table.
   */
  import { untrack } from 'svelte';
  import { columnDoc, EDIT_FLOW, tableDoc, tableTitle, TABLES } from '../../lib/docs.sv';
  import { openHelp } from '../../lib/help.svelte';
  import { tableHash } from '../../lib/routes';
  import { home, loadTables } from '../../lib/state.svelte';
  import { canSave, changesLabel, currentChanges, discard, isDirty, isStale, save, setMode, showGuard, syncFromServer, tableEdit } from '../../lib/tableEdit.svelte';
  import { columnTip } from '../../lib/tableColumns';
  import { parseTsv } from '../../lib/tsv';
  import TableGrid from './TableGrid.svelte';

  let { file }: { file: string } = $props();

  const doc = $derived(tableDoc(file));
  const title = $derived(tableTitle(file));
  const serverText = $derived(home.tables?.files[file]);

  // The editor is always live for the table shown. It follows the server while clean (hot reload, a save from
  // another browser); while dirty it keeps the user's copy and the stale strip says so.
  $effect(() => {
    void serverText;
    untrack(() => syncFromServer(file));
  });

  const edit = $derived(tableEdit.current && tableEdit.current.file === file ? tableEdit.current : null);
  const parsed = $derived(edit ? edit.parsed : parseTsv(serverText ?? ''));
  const rowCount = $derived(parsed.rows.filter((r) => r.some((c) => c !== '')).length);

  const dirty = $derived(isDirty(edit));
  const stale = $derived(edit ? isStale(edit) : false);
  const saveEnabled = $derived(canSave(edit));
  const changes = $derived(edit ? currentChanges(edit) : null);
  const changeCount = $derived(dirty ? Math.max(1, changes?.total ?? 1) : 0);
  const errorList = $derived(edit?.validation.state === 'errors' ? edit.validation.errors : []);
  const firstError = $derived(errorList[0] ? `${errorList[0].file && errorList[0].file !== file ? errorList[0].file + ' ' : ''}rad ${errorList[0].line}${errorList[0].column ? ` [${errorList[0].column}]` : ''}: ${errorList[0].message}` : '');
  /** The bar is there while something is changed, and for a moment after a save. */
  const showBar = $derived(!!edit && (dirty || !!edit.saveMessage || edit.saving));

  const comments = $derived((edit ? (edit.mode === 'raw' ? parseTsv(edit.raw).comments : edit.parsed.comments) : parsed.comments).map((c) => c.replace(/^#\s?/, '')));

  // switcher: documented order first, then anything else alphabetically
  const files = $derived(
    Object.keys(home.tables?.files ?? {}).sort((a, b) => {
      const ia = TABLES.findIndex((t) => t.file === a);
      const ib = TABLES.findIndex((t) => t.file === b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    }),
  );
  function switchTo(e: Event) {
    const select = e.currentTarget as HTMLSelectElement;
    const next = select.value;
    if (next === file) return;
    if (dirty) {
      select.value = file;
      showGuard('byter tabell');
      return;
    }
    location.hash = tableHash(next);
  }

  // "Om tabellen" and "Kolumner": open the first time, then remembered per table
  function readPref(key: string, fallback: boolean): boolean {
    try {
      const v = localStorage.getItem(`tables.${key}.${file}`);
      return v === null ? fallback : v === 'open';
    } catch {
      return fallback;
    }
  }
  function writePref(key: string, open: boolean) {
    try {
      localStorage.setItem(`tables.${key}.${file}`, open ? 'open' : 'closed');
    } catch {
      /* private mode */
    }
  }
  let aboutOpen = $state(readPref('about', true));
  let columnsOpen = $state(readPref('columns', true));
  let showComments = $state(false);

  /** Column the pointer or keyboard focus is on in a grid header; explained in a strip above the grid. */
  let hint = $state<string | null>(null);
  const hintText = $derived(hint ? columnTip(file, hint) : undefined);

  /** Columns in this file that the docs describe only generically (scene names). */
  const extraColumns = $derived(parsed.header.filter((h) => !doc?.columns.some((c) => c.name.toLowerCase() === h.toLowerCase()) && h.toLowerCase() !== 'note'));

  /** Which help tab fits this table best: formulas when it has any formula column, else actions. */
  const defaultHelpTab = $derived.by(() => {
    const tabs = [...(doc?.columns ?? []), ...(doc?.dynamicColumns ? [doc.dynamicColumns] : [])].map((c) => c.help);
    return tabs.includes('formulas') ? 'formulas' : tabs.includes('actions') ? 'actions' : 'formulas';
  });

  function reload() {
    if (dirty) {
      showGuard('laddar om');
      return;
    }
    void loadTables();
  }
</script>

<header class="head">
  <div class="titles">
    <h1>{title}</h1>
    <span class="file">{file}</span>
    <span class="count">{rowCount} {rowCount === 1 ? 'rad' : 'rader'}</span>
  </div>
  <label class="switch">
    <span class="faint">Tabell</span>
    <select value={file} onchange={switchTo} aria-label="Byt tabell">
      {#each files as f (f)}
        <option value={f}>{tableTitle(f)}</option>
      {/each}
    </select>
  </label>
  <div class="actions">
    <button class="btn small" onclick={reload} disabled={dirty || !home.tables} title={dirty ? 'Spara eller ångra ändringarna först' : 'Hämta tabellerna från motorn igen'}>Ladda om</button>
    {#if edit}
      <button
        class="btn small"
        class:pressed={edit.mode === 'raw'}
        aria-pressed={edit.mode === 'raw'}
        title="Hela filen som text: kommentarer och större ändringar. Osparade ändringar följer med."
        onclick={() => setMode(edit!.mode === 'raw' ? 'grid' : 'raw')}>Rå text</button>
    {/if}
    <button class="btn small" onclick={() => openHelp(defaultHelpTab)}>Hjälp</button>
  </div>
</header>

{#if stale}
  <div class="strip warn" role="status">Filen har ändrats på servern sedan du började ändra. Att spara skriver över den versionen; Ångra allt hämtar den.</div>
{/if}

<div class="docs">
  <details class="card doc" bind:open={aboutOpen} ontoggle={() => writePref('about', aboutOpen)}>
    <summary>Om tabellen</summary>
    <div class="body prose">
      {#if doc}
        {#each doc.about as p, i (i)}<p>{p}</p>{/each}
      {:else}
        <p>Den här tabellen saknar beskrivning. Kolumnnamnen står i rutnätet.</p>
      {/if}
      <p class="flow">{EDIT_FLOW}</p>
    </div>
  </details>
  <details class="card doc" bind:open={columnsOpen} ontoggle={() => writePref('columns', columnsOpen)}>
    <summary>Kolumner</summary>
    <div class="body">
      {#if doc}
        <dl class="cols">
          {#each [...doc.columns, ...(doc.dynamicColumns ? [doc.dynamicColumns] : [])] as c (c.name)}
            <dt><code>{c.name}</code></dt>
            <dd>
              <span>{c.what}</span>
              {#if c.allowed}<span class="allowed"><span class="lbl">Tillåtet</span> <code>{c.allowed}</code></span>{/if}
              <span class="allowed"><span class="lbl">Exempel</span> <code>{c.example}</code></span>
              {#if c.name === doc.dynamicColumns?.name && extraColumns.length}
                <span class="allowed"><span class="lbl">I den här filen</span> <code>{extraColumns.join(', ')}</code></span>
              {/if}
            </dd>
          {/each}
          {#if parsed.header.some((h) => h.toLowerCase() === 'note') && !doc.columns.some((c) => c.name === 'note')}
            <dt><code>note</code></dt>
            <dd><span>{columnDoc(file, 'note')?.what}</span></dd>
          {/if}
          {#if file === 'rules.tsv'}
            <dt><code class="faint">senast utlöst</code></dt>
            <dd><span>Står inte i filen: när regeln fyrade sist i den här körningen av motorn.</span></dd>
          {:else if file === 'cells.tsv'}
            <dt><code class="faint">värde</code></dt>
            <dd><span>Står inte i filen: cellens värde i motorn just nu.</span></dd>
          {/if}
        </dl>
      {:else}
        <p class="muted">{parsed.header.join(', ')}</p>
      {/if}
    </div>
  </details>
</div>

<div class="gridbar">
  {#if comments.length}
    <label class="check"><input type="checkbox" bind:checked={showComments} /> Visa filkommentarer ({comments.length})</label>
  {/if}
  <span class="spacer"></span>
  {#if hintText}
    <span class="hint"><code>{hint}</code> {hintText}</span>
  {:else}
    <span class="hint faint">Håll pekaren över ett kolumnnamn för att se vad det betyder.</span>
  {/if}
</div>

{#if showComments && comments.length}
  <div class="comments" title="Kommentarer ändras i Rå text">
    {#each comments as c, i (i)}<div>{c}</div>{/each}
  </div>
{/if}

<TableGrid {file} {changes} onhint={(h) => (hint = h)} />

{#if edit && showBar}
  <div class="savebar" class:alarm={edit.validation.state === 'errors' || edit.validation.state === 'failed' || edit.saveMessage?.error} role="status" aria-live="polite">
    <div class="words">
      {#if dirty}
        <strong class="n">{changesLabel(changeCount)}</strong>
      {/if}
      <span class="state">
        {#if edit.saving}
          Sparar…
        {:else if edit.saveMessage}
          {edit.saveMessage.text}
        {:else if edit.validation.state === 'pending' || edit.validation.state === 'idle'}
          Kontrollerar…
        {:else if edit.validation.state === 'errors'}
          {errorList.length} fel – rätta innan du sparar<span class="first">{firstError}</span>
        {:else if edit.validation.state === 'failed'}
          Kunde inte kontrollera: {edit.validation.message}
        {:else}
          Inga fel
        {/if}
      </span>
    </div>
    {#if dirty}
      <div class="buttons">
        {#if edit.confirmDiscard}
          <span class="confirm">
            Kasta {changesLabel(changeCount)}?
            <button class="btn small" onclick={() => discard()}>Ja</button>
            <button class="btn small" onclick={() => (edit!.confirmDiscard = false)}>Nej</button>
          </span>
        {:else}
          <button class="btn small" onclick={() => (edit!.confirmDiscard = true)} disabled={edit.saving}>Ångra allt</button>
          <button class="btn small primary" disabled={!saveEnabled} title={saveEnabled ? 'Spara och läs in i motorn' : edit.saving ? 'Sparar…' : edit.validation.state === 'errors' ? 'Rätta felen först' : 'Väntar på kontrollen'} onclick={() => void save()}>
            {edit.saving ? 'Sparar…' : 'Spara'}
          </button>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3) var(--space-4);
    margin: var(--space-3) 0 var(--space-3);
  }
  .titles {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  h1 {
    font-family: var(--font-display);
    font-weight: 900;
    font-size: 26px;
    line-height: 1;
    letter-spacing: -0.01em;
    text-transform: uppercase;
    margin: 0;
    color: var(--ink);
  }
  .file,
  .count {
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.4;
    color: var(--ink-faint);
  }
  .switch {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 13px;
  }
  .switch select {
    min-height: 30px;
    padding: 2px 10px;
  }
  .actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  /* A toggled secondary button: sunken with a strong edge, the word says what is on. */
  .btn.pressed {
    background: var(--paper-sunken);
    border-color: var(--ink);
  }

  .strip {
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-m);
    background: var(--paper-sunken);
    padding: var(--space-2) var(--space-3);
    margin-bottom: var(--space-3);
    font-size: 14px;
    line-height: 1.5;
    color: var(--ink);
  }

  .docs {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
    gap: var(--space-4);
    margin-bottom: var(--space-4);
  }
  details.doc {
    padding: 0;
  }
  summary {
    cursor: pointer;
    list-style: none;
    padding: var(--space-3) var(--space-5);
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 13px;
    line-height: 1.4;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--surface-rust);
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary::before {
    content: '';
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1px solid var(--line-strong);
    background: var(--paper);
    flex-shrink: 0;
  }
  details[open] summary::before {
    background: var(--ochre);
  }
  summary:hover {
    background: var(--paper-hover);
    border-radius: var(--radius-card) var(--radius-card) 0 0;
  }
  .body {
    padding: 0 var(--space-5) var(--space-4);
  }
  .prose p {
    margin: 0 0 var(--space-2);
    font-size: 14px;
    line-height: 1.55;
    color: var(--ink-muted);
    max-width: 66ch;
  }
  .prose p.flow {
    color: var(--ink);
    border-top: 1px solid var(--line);
    padding-top: var(--space-2);
    margin-top: var(--space-3);
  }
  dl.cols {
    margin: 0;
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--space-2) var(--space-4);
  }
  dl.cols dt {
    padding-top: 1px;
  }
  dl.cols dt code {
    color: var(--ink);
  }
  dl.cols dt code.faint {
    color: var(--ink-faint);
  }
  dl.cols dd {
    margin: 0;
    font-size: 14px;
    line-height: 1.5;
    color: var(--ink-muted);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .allowed code {
    color: var(--ink);
    word-break: break-word;
  }
  .lbl {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-faint);
    margin-right: var(--space-1);
  }
  .gridbar {
    display: flex;
    align-items: center;
    gap: var(--space-2) var(--space-4);
    flex-wrap: wrap;
    margin-bottom: var(--space-2);
    font-size: 13px;
    line-height: 1.5;
    min-height: 24px;
  }
  .gridbar .spacer {
    flex: 1;
  }
  .hint {
    color: var(--ink-muted);
    max-width: 70ch;
  }
  .hint code {
    color: var(--ink);
  }
  .comments {
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    color: var(--ink-faint);
    white-space: pre-wrap;
    word-break: break-word;
    border: 1px solid var(--line);
    border-radius: var(--radius-m);
    background: var(--paper-sunken);
    padding: var(--space-2) var(--space-4);
    margin-bottom: var(--space-2);
  }

  /* The save bar: sticks to the bottom of the viewport while the table is on screen. Raised paper, a strong
     rule on top, no shadow. It appears and disappears; nothing slides. */
  .savebar {
    position: sticky;
    bottom: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    margin: var(--space-4) calc(-1 * var(--space-2)) 0;
    padding: var(--space-3) var(--space-4);
    padding-bottom: calc(var(--space-3) + env(safe-area-inset-bottom));
    background: var(--paper-raised);
    border-top: 2px solid var(--line-strong);
    border-left: 1px solid var(--line);
    border-right: 1px solid var(--line);
    border-radius: var(--radius-m) var(--radius-m) 0 0;
    font-size: 14px;
    line-height: 1.5;
    color: var(--ink);
  }
  .savebar.alarm {
    border-top-color: var(--alarm);
  }
  .savebar.alarm .state {
    color: var(--alarm);
  }
  .words {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    min-width: 0;
    flex: 1;
  }
  .n {
    font-family: var(--font-mono);
    font-weight: 400;
    font-size: 13px;
    letter-spacing: 0.04em;
    color: var(--ink);
    white-space: nowrap;
  }
  .state {
    color: var(--ink-muted);
  }
  .first {
    display: block;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    color: var(--alarm);
    word-break: break-word;
  }
  .buttons,
  .confirm {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .confirm {
    font-size: 14px;
    color: var(--ink);
  }
  @media (max-width: 640px) {
    h1 {
      font-size: 22px;
    }
    .actions {
      margin-left: 0;
      width: 100%;
    }
    dl.cols {
      grid-template-columns: 1fr;
      gap: var(--space-1);
    }
    dl.cols dd {
      margin-bottom: var(--space-2);
    }
    .savebar {
      margin-left: calc(-1 * var(--space-5));
      margin-right: calc(-1 * var(--space-5));
      border-left: none;
      border-right: none;
      border-radius: 0;
    }
  }
</style>
