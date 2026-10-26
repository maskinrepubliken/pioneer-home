<script lang="ts">
  /**
   * Range slider that follows the device until grabbed and sends once on release (`onchange`), not while dragging.
   * The number beside it is the value in mono with its unit.
   */
  import { formatQuantity } from '../../lib/format';

  let {
    value,
    min,
    max,
    step = 1,
    unit,
    label,
    fallback = min,
    disabled = false,
    onrelease,
  }: {
    value: number | null;
    min: number;
    max: number;
    step?: number;
    unit: string;
    label: string;
    fallback?: number;
    disabled?: boolean;
    onrelease: (n: number) => void;
  } = $props();

  let drag = $state<number | null>(null);
  const shown = $derived(drag ?? value ?? fallback);
</script>

<label class="slider">
  <input
    type="range"
    {min}
    {max}
    {step}
    value={shown}
    {disabled}
    oninput={(e) => (drag = Number(e.currentTarget.value))}
    onchange={(e) => {
      onrelease(Math.round(Number(e.currentTarget.value)));
      drag = null;
    }}
    aria-label={label}
    aria-valuetext="{Math.round(shown)}{unit}"
  />
  <b class="num value">{value === null && drag === null ? '—' : formatQuantity(Math.round(shown), unit)}</b>
</label>

<style>
  .slider {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    min-width: 0;
  }
  input {
    flex: 1;
    min-width: 0;
  }
  .num {
    min-width: 4.2em;
    text-align: right;
    flex-shrink: 0;
  }
</style>
