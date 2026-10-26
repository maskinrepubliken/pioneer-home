<script lang="ts">
  /**
   * One reported value, drawn the same way wherever it comes from (sensor, thermostat, plug ...):
   * the global `.value` style and formatQuantity's precision per unit, with an optional quiet label before it.
   */
  import { formatQuantity } from '../../lib/format';

  let { value, unit = '', label }: { value: number | null; unit?: string; label?: string } = $props();
</script>

<span class="reading">
  {#if label}<span class="lbl">{label}</span>{/if}
  <b class="value">{value === null ? '—' : formatQuantity(value, unit)}</b>
</span>

<style>
  .reading {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-1);
    white-space: nowrap;
  }
  .lbl {
    font-size: 13px;
    color: var(--ink-faint);
  }
</style>
