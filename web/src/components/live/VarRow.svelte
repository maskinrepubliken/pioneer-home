<script lang="ts">
  import { formatQuantity } from '../../lib/format';
  /** A held value (cells.tsv row without formula) as a control: boolean -> switch with PÅ/AV, others -> the value. */
  import type { Cell } from '../../lib/api';
  import { sendAction } from '../../lib/state.svelte';
  import CellValue from '../CellValue.svelte';
  import Switch from './Switch.svelte';

  let { cell }: { cell: Cell } = $props();
  const isBool = $derived(cell.type === 'boolean' || typeof cell.value === 'boolean');
  /** A number in the heating group is a target temperature: a ±0.5 stepper, rapid taps sent as one `set`. */
  const isTarget = $derived(cell.settable && cell.group === 'heating' && (cell.type === 'number' || typeof cell.value === 'number'));
  let pending = $state<number | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const shown = $derived(pending ?? (typeof cell.value === 'number' ? cell.value : null));
  function step(delta: number) {
    pending = Math.round(((shown ?? 20) + delta) * 2) / 2;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const v = pending;
      pending = null;
      if (v !== null) void sendAction(`set ${cell.id} ${v}`);
    }, 600);
  }
</script>

<li class="row">
  <span class="label">
    {#if cell.name}
      <span class="name">{cell.name}</span>
      <span class="id mono">{cell.id}</span>
    {:else}
      <span class="name mono">{cell.id}</span>
    {/if}
  </span>
  {#if isTarget}
    <span class="stepper" role="group" aria-label={cell.name ?? cell.id}>
      <button class="btn small" onclick={() => step(-0.5)} aria-label="Sänk {cell.name ?? cell.id}">−</button>
      <b class="sp value" aria-live="polite">{shown === null ? '—' : formatQuantity(shown, '°C')}</b>
      <button class="btn small" onclick={() => step(0.5)} aria-label="Höj {cell.name ?? cell.id}">+</button>
    </span>
  {:else if isBool && cell.settable}
    <Switch
      words="yesno"
      on={typeof cell.value === 'boolean' ? cell.value : null}
      label="Växla {cell.id}"
      ontoggle={() => sendAction(`set ${cell.id} ${cell.value === true ? 'FALSE' : 'TRUE'}`)}
    />
  {:else}
    <CellValue {cell} showAge={false} />
  {/if}
</li>

<style>
  /* Label and control share the line while they fit; in a narrow column the control wraps below. */
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) 0;
    border-top: 1px solid var(--line);
    min-width: 0;
  }
  .row:first-child {
    border-top: none;
    padding-top: 0;
  }
  .id {
    font-size: 14px;
    color: var(--ink);
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1 1 9em;
    min-width: 0;
  }
  .name {
    font-family: var(--font-ui);
    font-size: 15px;
    line-height: 1.4;
    color: var(--ink);
  }
  .name.mono {
    font-family: var(--font-mono);
    font-size: 14px;
  }
  .label .id {
    font-size: 12px;
    color: var(--ink-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .stepper {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
  }
  .sp {
    font-size: 15px;
    min-width: 4.5em;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
</style>
