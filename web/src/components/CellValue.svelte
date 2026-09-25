<script lang="ts">
  import type { Cell } from '../lib/api';
  import { dateTime, formatValue, isTimestamp, onOff, relativeTime } from '../lib/format';
  import { home } from '../lib/state.svelte';

  let { cell, showAge = true }: { cell: Cell; showAge?: boolean } = $props();

  const v = $derived(cell.value);
  const text = $derived(formatValue(v, cell.id, cell.prop, home.now));
  const age = $derived(cell.changedAt ? relativeTime(cell.changedAt, home.now) : null);
  const title = $derived(
    [cell.id, cell.changedAt ? `ändrad ${dateTime(cell.changedAt)}` : '', isTimestamp(v) ? dateTime(v.$timestamp) : '']
      .filter(Boolean)
      .join('\n'),
  );
</script>

<span class="cell-value" {title}>
  {#if typeof v === 'boolean'}
    <span class="pill" class:on={v} class:off={!v}>{onOff(v)}</span>
  {:else if v === null}
    <span class="pill neutral">NULL</span>
  {:else}
    <span class="val" class:mono={typeof v === 'string' && v.length > 12}>{text}</span>
  {/if}
  {#if showAge && age}
    <span class="age">{age}</span>
  {/if}
</span>

<style>
  .cell-value {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-2);
    white-space: nowrap;
  }
  /* "data": the live value, in mono. */
  .val {
    font-family: var(--font-mono);
    font-size: 15px;
    line-height: 1.4;
    font-variant-numeric: tabular-nums;
    color: var(--ink);
  }
  .val.mono {
    font-size: 13px;
  }
  .age {
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.4;
    color: var(--ink-faint);
  }
</style>
