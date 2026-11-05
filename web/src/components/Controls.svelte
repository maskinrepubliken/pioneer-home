<script lang="ts">
  /**
   * Inline controls for a device. Emits actions in the grammar from CLAUDE.md:
   *   set lamp1 on | 60% | 2700K      set fan 40      set floor1 setpoint=21
   * Sliders send on release (`onchange`), not while dragging.
   */
  import type { Cell } from '../lib/api';
  import { sendAction } from '../lib/state.svelte';
  import { propLabel } from '../lib/format';

  let { device, kind, cells }: { device: string; kind: string; cells: Record<string, Cell> } = $props();

  const num = (p: string): number | null => {
    const v = cells[p]?.value;
    return typeof v === 'number' ? v : null;
  };
  const bool = (p: string): boolean | null => {
    const v = cells[p]?.value;
    return typeof v === 'boolean' ? v : null;
  };

  const isOn = $derived(bool('state'));
  const brightness = $derived(num('brightness'));
  const colorTemp = $derived(num('color_temp'));
  const level = $derived(num('level'));
  const setpoint = $derived(num('setpoint'));

  // Slider positions follow the device until the user grabs them.
  let dragBrightness = $state<number | null>(null);
  let dragColorTemp = $state<number | null>(null);
  let dragLevel = $state<number | null>(null);
  let pendingSetpoint = $state<number | null>(null);
  let setpointTimer: ReturnType<typeof setTimeout> | null = null;

  const shownSetpoint = $derived(pendingSetpoint ?? setpoint);

  function toggle() {
    void sendAction(`set ${device} ${isOn ? 'off' : 'on'}`);
  }

  function release(prop: 'brightness' | 'color_temp' | 'level', raw: string) {
    const n = Number(raw);
    if (prop === 'brightness') {
      void sendAction(`set ${device} ${Math.round(n)}%`);
      dragBrightness = null;
    } else if (prop === 'color_temp') {
      void sendAction(`set ${device} ${Math.round(n)}K`);
      dragColorTemp = null;
    } else {
      void sendAction(`set ${device} ${Math.round(n)}`);
      dragLevel = null;
    }
  }

  function step(delta: number) {
    const base = shownSetpoint ?? 20;
    pendingSetpoint = Math.round((base + delta) * 2) / 2;
    if (setpointTimer) clearTimeout(setpointTimer);
    // Coalesce rapid taps into one command.
    setpointTimer = setTimeout(() => {
      const v = pendingSetpoint;
      pendingSetpoint = null;
      if (v !== null) void sendAction(`set ${device} setpoint=${v}`);
    }, 600);
  }
</script>

<div class="controls">
  {#if kind === 'light' || kind === 'plug'}
    <button class="toggle" class:on={isOn === true} onclick={toggle} aria-pressed={isOn === true} aria-label="Ström på/av">
      <span class="knob"></span>
    </button>
  {/if}

  {#if kind === 'light'}
    <label class="slider">
      <span class="lbl">☀︎ <b>{Math.round(dragBrightness ?? brightness ?? 0)}%</b></span>
      <input
        type="range"
        min="1"
        max="100"
        step="1"
        value={dragBrightness ?? brightness ?? 0}
        oninput={(e) => (dragBrightness = Number(e.currentTarget.value))}
        onchange={(e) => release('brightness', e.currentTarget.value)}
        aria-label={propLabel('brightness')}
      />
    </label>
    <label class="slider">
      <span class="lbl">◐ <b>{Math.round(dragColorTemp ?? colorTemp ?? 2700)} K</b></span>
      <input
        type="range"
        min="2000"
        max="6500"
        step="50"
        class="ct"
        value={dragColorTemp ?? colorTemp ?? 2700}
        oninput={(e) => (dragColorTemp = Number(e.currentTarget.value))}
        onchange={(e) => release('color_temp', e.currentTarget.value)}
        aria-label={propLabel('color_temp')}
      />
    </label>
  {/if}

  {#if kind === 'pwm'}
    <label class="slider">
      <span class="lbl">{propLabel('level').toLowerCase()} <b>{Math.round(dragLevel ?? level ?? 0)}%</b></span>
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={dragLevel ?? level ?? 0}
        oninput={(e) => (dragLevel = Number(e.currentTarget.value))}
        onchange={(e) => release('level', e.currentTarget.value)}
        aria-label={propLabel('level')}
      />
    </label>
  {/if}

  {#if kind === 'thermostat'}
    <div class="stepper">
      <span class="lbl">{propLabel('setpoint').toLowerCase()}</span>
      <button class="btn small" onclick={() => step(-0.5)} aria-label="Sänk måltemperatur">−</button>
      <b class="sp" class:pending={pendingSetpoint !== null}>{shownSetpoint === null ? '—' : `${shownSetpoint.toFixed(1)} °C`}</b>
      <button class="btn small" onclick={() => step(0.5)} aria-label="Höj måltemperatur">+</button>
    </div>
  {/if}
</div>

<style>
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3) var(--space-4);
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--line);
  }
  .slider {
    flex: 1 1 160px;
    min-width: 140px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .lbl {
    font-family: var(--font-ui);
    font-size: 14px;
    line-height: 1.5;
    color: var(--ink-faint);
  }
  .lbl b {
    font-family: var(--font-mono);
    font-size: 15px;
    font-weight: 400;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .stepper {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .sp {
    min-width: 62px;
    text-align: center;
    font-family: var(--font-mono);
    font-size: 15px;
    font-weight: 400;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .sp.pending {
    color: var(--ink-muted);
  }
</style>
