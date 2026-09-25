<script lang="ts">
  /**
   * Tabeller: `#/tables` is the overview (what each table is for, row counts, how to make a change),
   * `#/tables/<file>` is one table with its documentation and the live grid (tap a cell to change it).
   * The help panel (Formler / Åtgärder / Celler) floats beside either page.
   */
  import TablesOverview from '../components/tables/TablesOverview.svelte';
  import TablePage from '../components/tables/TablePage.svelte';
  import HelpPanel from '../components/tables/HelpPanel.svelte';
  import { home } from '../lib/state.svelte';
  import { help } from '../lib/help.svelte';
  import { tableEdit } from '../lib/tableEdit.svelte';

  let { file }: { file: string | null } = $props();

  const known = $derived(file !== null && !!home.tables && file in home.tables.files);
</script>

<div class="tables" class:with-help={help.open}>
  <div class="content">
    {#if tableEdit.guardNotice}
      <div class="guard" role="alert">{tableEdit.guardNotice}</div>
    {/if}
    {#if !home.tables}
      <div class="empty">laddar tabeller…</div>
    {:else if file === null}
      <TablesOverview />
    {:else if known}
      {#key file}
        <TablePage file={file!} />
      {/key}
    {:else}
      <div class="empty">Tabellen <code>{file}</code> finns inte. <a href="#/tables">Till översikten</a></div>
    {/if}
  </div>
  {#if help.open}
    <HelpPanel />
  {/if}
</div>

<style>
  .guard {
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-m);
    background: var(--paper-sunken);
    color: var(--ink);
    padding: var(--space-2) var(--space-3);
    margin: var(--space-2) 0 var(--space-3);
    font-size: 14px;
    line-height: 1.5;
  }
  .content {
    min-width: 0;
  }
  /* Wide screens: the help panel takes a column beside the content. */
  @media (min-width: 1000px) {
    .tables.with-help {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 380px;
      gap: var(--space-6);
      align-items: start;
    }
  }
</style>
