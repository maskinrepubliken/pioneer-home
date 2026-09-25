<script lang="ts">
  /**
   * Help beside the tables: Formler (cheat sheet), Åtgärder (action grammar) and Celler (every cell the engine
   * knows, searchable). Every example can be copied, and inserted into the grid cell being edited (or edited last).
   * Side panel from 1000px, bottom sheet below. All text comes from lib/docs.sv.ts.
   */
  import { tick } from 'svelte';
  import { ACTION_INTRO, ACTION_SECTIONS, CELLS_INTRO, FORMULA_INTRO, FORMULA_SECTIONS, type DocSection, type HelpTab } from '../../lib/docs.sv';
  import { formatValue, roomName } from '../../lib/format';
  import { closeHelp, help } from '../../lib/help.svelte';
  import { home, notify } from '../../lib/state.svelte';
  import { canInsert, insertAtFocus } from '../../lib/tableEdit.svelte';

  const TABS: { id: HelpTab; label: string }[] = [
    { id: 'formulas', label: 'Formler' },
    { id: 'actions', label: 'Åtgärder' },
    { id: 'cells', label: 'Celler' },
  ];

  let bodyEl = $state<HTMLElement | null>(null);

  // Scroll to the requested section when the panel opens on one.
  $effect(() => {
    const section = help.section;
    const tab = help.tab;
    if (!section) return;
    void tick().then(() => {
      bodyEl?.querySelector<HTMLElement>(`[data-section="${tab}:${section}"]`)?.scrollIntoView({ block: 'start' });
    });
  });

  const insertable = $derived(canInsert());

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify('Kopierat');
    } catch {
      notify('Kunde inte kopiera: markera texten och kopiera själv', true);
    }
  }
  function insert(text: string) {
    if (!insertAtFocus(text)) void copy(text);
  }
  /** Click on a cell id: insert when a grid cell is (or was just) being edited, copy otherwise. */
  function pick(text: string) {
    if (insertable) insert(text);
    else void copy(text);
  }

  // ---- Celler ----
  let query = $state('');
  interface CellRow {
    id: string;
    value: string;
    name: string | null;
    kind: string;
  }
  interface CellGroup {
    title: string;
    cells: CellRow[];
  }
  const groups = $derived.by((): CellGroup[] => {
    const q = query.trim().toLowerCase();
    const byGroup = new Map<string, CellRow[]>();
    for (const c of Object.values(home.cells)) {
      if (q && !c.id.toLowerCase().includes(q) && !(c.name ?? '').toLowerCase().includes(q)) continue;
      const key = c.device ? roomName(c.room, home.rooms) : c.kind === 'derived' ? 'Celler med formel' : c.kind === 'var' ? 'Celler med värde' : c.kind === 'setting' ? 'Inställningar' : 'System';
      let list = byGroup.get(key);
      if (!list) byGroup.set(key, (list = []));
      list.push({ id: c.id, value: formatValue(c.value, c.id, c.prop, home.now), name: c.name, kind: c.kind });
    }
    const order = (t: string) => (t === 'Celler med formel' ? 1 : t === 'Celler med värde' ? 2 : t === 'Inställningar' ? 3 : t === 'System' ? 4 : 0);
    return [...byGroup.entries()]
      .sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0], 'sv'))
      .map(([title, cells]) => ({ title, cells: cells.sort((a, b) => a.id.localeCompare(b.id)) }));
  });
  const total = $derived(groups.reduce((n, g) => n + g.cells.length, 0));

  function sections(tab: HelpTab): DocSection[] {
    return tab === 'formulas' ? FORMULA_SECTIONS : ACTION_SECTIONS;
  }
</script>

<aside class="panel card" aria-label="Hjälp">
  <header>
    <div class="tabs" role="tablist">
      {#each TABS as t (t.id)}
        <button role="tab" class:active={help.tab === t.id} aria-selected={help.tab === t.id} onclick={() => ((help.tab = t.id), (help.section = null))}>{t.label}</button>
      {/each}
    </div>
    <button class="btn small" onclick={closeHelp} aria-label="Stäng hjälpen">Stäng</button>
  </header>

  <div class="body" bind:this={bodyEl}>
    {#if help.tab === 'cells'}
      {#each CELLS_INTRO as p, i (i)}<p class="intro">{p}</p>{/each}
      <input type="search" placeholder="Sök cell" bind:value={query} aria-label="Sök cell" />
      <p class="faint count">{total} celler{insertable ? ' · klick sätter in i cellen du ändrar' : ' · klick kopierar'}</p>
      {#each groups as g (g.title)}
        <h3>{g.title}</h3>
        <ul class="cells">
          {#each g.cells as c (c.id)}
            <li>
              <button class="cellbtn" onclick={() => pick(c.id)} title={insertable ? `Sätt in ${c.id}` : `Kopiera ${c.id}`}>
                <span class="id">{c.id}</span>
                <span class="val">{c.value}</span>
              </button>
              {#if c.name}<span class="name">{c.name}</span>{/if}
            </li>
          {/each}
        </ul>
      {/each}
      {#if !total}<p class="empty">Inga celler matchar.</p>{/if}
    {:else}
      {#each help.tab === 'formulas' ? FORMULA_INTRO : ACTION_INTRO as p, i (i)}<p class="intro">{p}</p>{/each}
      {#each sections(help.tab) as s (s.id)}
        <section data-section={`${help.tab}:${s.id}`}>
          <h3>{s.title}</h3>
          {#each s.intro ?? [] as p, i (i)}<p class="sub">{p}</p>{/each}
          <ul class="examples">
            {#each s.examples as ex (ex.code)}
              <li>
                <div class="row">
                  <code>{ex.code}</code>
                  <span class="ops">
                    <button class="mini" title="Kopiera" onclick={() => void copy(ex.code)}>Kopiera</button>
                    {#if insertable}<button class="mini" title="Sätt in i cellen du ändrar" onclick={() => insert(ex.code)}>Infoga</button>{/if}
                  </span>
                </div>
                <span class="text">{ex.text}</span>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    {/if}
  </div>
</aside>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    padding: 0;
    position: sticky;
    top: 68px;
    max-height: calc(100vh - 84px);
    min-height: 0;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3) 0;
    border-bottom: 1px solid var(--line);
  }
  header .tabs {
    border-bottom: none;
    margin-bottom: 0;
  }
  .body {
    overflow-y: auto;
    padding: var(--space-3) var(--space-4) var(--space-5);
    min-height: 0;
  }
  .intro {
    font-size: 14px;
    line-height: 1.55;
    color: var(--ink-muted);
    margin: 0 0 var(--space-2);
  }
  h3 {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 12px;
    line-height: 1.4;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--surface-rust);
    margin: var(--space-4) 0 var(--space-2);
  }
  .sub {
    font-size: 13px;
    line-height: 1.5;
    color: var(--ink-muted);
    margin: 0 0 var(--space-2);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .examples li {
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--line);
  }
  .examples li:last-child {
    border-bottom: none;
  }
  .row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .row code {
    color: var(--ink);
    white-space: pre-wrap;
    word-break: break-word;
    padding-top: 3px;
  }
  .ops {
    display: inline-flex;
    gap: var(--space-1);
    flex-shrink: 0;
  }
  .mini {
    background: var(--paper);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-pill);
    color: var(--ink-muted);
    font-family: var(--font-ui);
    font-size: 12px;
    line-height: 1;
    padding: 4px 9px;
  }
  .mini:hover {
    background: var(--paper-hover);
    color: var(--ink);
  }
  .text {
    display: block;
    font-size: 13px;
    line-height: 1.5;
    color: var(--ink-muted);
    margin-top: 2px;
  }
  input[type='search'] {
    width: 100%;
    margin: var(--space-2) 0 var(--space-1);
  }
  .count {
    font-size: 12px;
    margin: 0 0 var(--space-2);
  }
  .cells li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 var(--space-2);
    border-bottom: 1px solid var(--line);
  }
  .cells li:last-child {
    border-bottom: none;
  }
  .cellbtn {
    flex: 1;
    display: flex;
    justify-content: space-between;
    gap: var(--space-2);
    text-align: left;
    background: none;
    border: none;
    padding: 5px 4px;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    color: var(--ink);
    min-width: 0;
  }
  .cellbtn:hover {
    background: var(--paper-hover);
  }
  .cellbtn .id {
    word-break: break-all;
  }
  .cellbtn .val {
    color: var(--ink-muted);
    white-space: nowrap;
  }
  .name {
    font-size: 12px;
    color: var(--ink-faint);
    padding: 0 4px 4px;
    width: 100%;
  }
  .empty {
    padding: var(--space-4) 0;
  }

  /* Phone and narrow: a bottom sheet. */
  @media (max-width: 999px) {
    .panel {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      top: auto;
      max-height: 70vh;
      border-radius: var(--radius-panel) var(--radius-panel) 0 0;
      border-bottom: none;
      z-index: 30;
      padding-bottom: env(safe-area-inset-bottom);
    }
  }
</style>
