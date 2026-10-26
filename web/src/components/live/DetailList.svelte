<script lang="ts">
  /** Label/value list for advanced information. Device cells get Swedish prop labels, other cells show their id. */
  import type { Cell } from '../../lib/api';
  import { cellLabel } from '../../lib/format';
  import CellValue from '../CellValue.svelte';

  let { cells, ids = false, showAge = true }: { cells: Cell[]; ids?: boolean; showAge?: boolean } = $props();
</script>

<dl class="details">
  {#each cells as c (c.id)}
    <div class="item">
      <dt class:mono={ids && !c.name} title={c.id}>{ids ? (c.name ?? c.id) : cellLabel(c)}{#if ids && c.name}<span class="sub mono">{c.id}</span>{/if}</dt>
      <dd><CellValue cell={c} {showAge} /></dd>
    </div>
  {/each}
</dl>

<style>
  .details {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .item {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0 var(--space-3);
    min-width: 0;
  }
  dt {
    font-family: var(--font-ui);
    font-size: 13px;
    line-height: 1.5;
    color: var(--ink-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  dt.mono {
    font-family: var(--font-mono);
    font-size: 12px;
  }
  dd {
    margin: 0 0 0 auto;
    flex-shrink: 0;
    text-align: right;
  }
  .sub {
    display: block;
    font-size: 11px;
    color: var(--ink-faint);
  }
</style>
