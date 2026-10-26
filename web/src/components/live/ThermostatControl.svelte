<script lang="ts">
  /**
   * part="status": heating word and the setpoint as text (the row; the temperature is in the room's readings).
   * part="setpoint": the device's own setpoint stepper (±0.5, rapid taps coalesced into one `set <id> setpoint=21`),
   * shown under Detaljer since the room's Måltemperatur normally sets it.
   */
  import type { Cell } from '../../lib/api';
  import { formatQuantity } from '../../lib/format';
  import Reading from './Reading.svelte';
  import { sendAction } from '../../lib/state.svelte';
  import Icon from './Icon.svelte';

  let { device, props, part = 'status', offline = false }: { device: string; props: Record<string, Cell>; part?: 'status' | 'setpoint'; offline?: boolean } = $props();

  const num = (p: string): number | null => {
    const v = props[p]?.value;
    return typeof v === 'number' ? v : null;
  };
  const setpoint = $derived(num('setpoint'));
  const demand = $derived(num('demand'));
  const running = $derived(props['running']?.value);
  // An unreachable device's last report is old news: no heating word at all.
  const heating = $derived(
    offline ? null : typeof running === 'string' ? running.toLowerCase() === 'heat' : demand === null ? null : demand > 0,
  );

  let pending = $state<number | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const shown = $derived(pending ?? setpoint);

  function step(delta: number) {
    const base = shown ?? 20;
    pending = Math.round((base + delta) * 2) / 2;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const v = pending;
      pending = null;
      if (v !== null) void sendAction(`set ${device} setpoint=${v}`);
    }, 600);
  }
</script>

{#if part === 'status'}
<div class="thermo" class:heating={heating === true} class:resting={heating === false}>
  <div class="now">
    {#if heating === true}
      <span class="state on"><Icon name="heat" size={14} />värmer{#if demand !== null && demand > 0}&nbsp;{Math.round(demand)}&nbsp;%{/if}</span>
    {:else if heating === false}
      <span class="state off">vilar</span>
    {/if}
  </div>
  {#if setpoint !== null}<Reading value={setpoint} unit="°C" label="mål" />{/if}
</div>
{:else}
<div class="stepper" role="group" aria-label="Enhetens måltemperatur">
  <span class="lbl">Enhetens måltemperatur</span>
  <button class="btn small" onclick={() => step(-0.5)} aria-label="Sänk enhetens måltemperatur">−</button>
  <b class="sp value" class:pending={pending !== null} aria-live="polite">{shown === null ? '—' : formatQuantity(shown, '°C')}</b>
  <button class="btn small" onclick={() => step(0.5)} aria-label="Höj enhetens måltemperatur">+</button>
</div>
{/if}

<style>
  .thermo {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2) var(--space-4);
  }
  .now {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  /* Heating vs resting is carried by the word: a filled rust badge with a heat icon and the demand, or an
     outlined VILAR. */
  .state {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 6px 12px;
    border-radius: var(--radius-pill);
    border: 1px solid var(--line-strong);
    white-space: nowrap;
  }
  .state.on {
    background: var(--surface-rust);
    border-color: var(--surface-rust);
    color: var(--on-dark);
  }
  .state.off {
    background: var(--paper);
    color: var(--ink-muted);
  }
  .stepper {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .stepper .lbl {
    flex: 1;
  }
  .lbl {
    font-size: 13px;
    color: var(--ink-faint);
  }
  .sp {
    min-width: 62px;
    text-align: center;
  }
  .sp.pending {
    color: var(--ink-muted);
  }
</style>
