<script lang="ts">
  /** The shared `.toggle` with its word beside it (status is never colour alone): PÅ/AV for devices, JA/NEJ for variables. */
  import { onOff, yesNo } from '../../lib/format';

  let { on, label, disabled = false, words = 'onoff', ontoggle }: { on: boolean | null; label: string; disabled?: boolean; words?: 'onoff' | 'yesno'; ontoggle: () => void } = $props();
</script>

<span class="switch">
  <span class="word mono">{on === null ? '—' : words === 'yesno' ? yesNo(on) : onOff(on)}</span>
  <button class="toggle" class:on={on === true} onclick={ontoggle} aria-pressed={on === true} aria-label={label} title={label} {disabled}>
    <span class="knob"></span>
  </button>
</span>

<style>
  .switch {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
  }
  .word {
    font-size: 12px;
    letter-spacing: 0.1em;
    color: var(--ink-muted);
    min-width: 2.2em;
    text-align: right;
  }
</style>
