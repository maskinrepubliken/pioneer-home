<script lang="ts">
  /**
   * One compact row per device in a room column: name, primary value and main control inline.
   * Everything else (battery, signal, last seen, colour temperature ...) sits behind the row's Detaljer toggle.
   */
  import type { Cell } from '../../lib/api';
  import type { LiveDevice } from '../../lib/live';
  import { formatValue, isTimestamp, relativeTime } from '../../lib/format';
  import { disclosureId, isOpen } from '../../lib/disclosure.svelte';
  import { home, sendAction } from '../../lib/state.svelte';
  import DetailList from './DetailList.svelte';
  import DisclosureButton from './DisclosureButton.svelte';
  import Slider from './Slider.svelte';
  import Switch from './Switch.svelte';
  import ThermostatControl from './ThermostatControl.svelte';
  import Reading from './Reading.svelte';
  import Icon, { type IconName } from './Icon.svelte';

  const ICONS = new Set(['light', 'plug', 'thermostat', 'motion', 'contact', 'climate', 'pwm', 'remote']);

  let { device }: { device: LiveDevice } = $props();

  /** Props shown in the row itself; the rest go to Detaljer. */
  const PRIMARY: Record<string, string[]> = {
    light: ['state', 'brightness', 'color_temp'],
    plug: ['state'],
    pwm: ['level'],
    thermostat: ['temperature', 'setpoint', 'running'],
    climate: ['temperature', 'humidity'],
    motion: ['occupancy', 'temperature', 'illuminance'],
    contact: ['open'],
    remote: ['battery', 'action'],
  };

  const p = $derived(device.props);
  const key = $derived(`device:${device.id}`);
  const open = $derived(isOpen(key));
  const offline = $derived(p['available']?.value === false);
  const lastSeen = $derived(p['last_seen']?.value);
  const seenAt = $derived(isTimestamp(lastSeen ?? null) ? (lastSeen as { $timestamp: number }).$timestamp : null);
  // last_seen is the "sedd för …" line above the list.
  const details = $derived(device.cells.filter((c) => c.prop !== 'last_seen' && !(PRIMARY[device.kind] ?? []).includes(c.prop ?? '')));

  const num = (prop: string): number | null => {
    const v = p[prop]?.value;
    return typeof v === 'number' ? v : null;
  };
  const bool = (prop: string): boolean | null => {
    const v = p[prop]?.value;
    return typeof v === 'boolean' ? v : null;
  };
  const show = (c: Cell | undefined) => (c ? formatValue(c.value, c.id, c.prop, home.now) : '—');

  function toggle() {
    void sendAction(`set ${device.id} ${bool('state') ? 'off' : 'on'}`);
  }
</script>

<li class="row" class:offline>
  <div class="head">
    <div class="line">
    <span class="kind-icon"><Icon name={(ICONS.has(device.kind) ? device.kind : 'device') as IconName} size={18} /></span>
    <span class="name" title={device.id}>{device.name}</span>
    {#if offline}<span class="pill danger" title="zigbee2mqtt når inte enheten; värdena kan vara gamla">nås inte</span>{/if}
    <span class="primary">
    {#if device.kind === 'plug' || device.kind === 'light'}
      <Switch on={bool('state')} label="Slå på/av {device.name}" ontoggle={toggle} />
    {:else if device.kind === 'remote'}
      {#if num('battery') !== null}<Reading value={num('battery')} unit="%" label="batteri" />{/if}
    {/if}
    </span>
    </div>
    <DisclosureButton {key} label="Detaljer för {device.name}" compact />
  </div>

  {#if device.kind === 'light'}
    <Slider value={num('brightness')} min={1} max={100} unit="%" label="Ljusstyrka {device.name}" onrelease={(n) => sendAction(`set ${device.id} ${n}%`)} />
  {:else if device.kind === 'pwm'}
    <Slider value={num('level')} min={0} max={100} unit="%" label="Nivå {device.name}" onrelease={(n) => sendAction(`set ${device.id} ${n}`)} />
  {:else if device.kind === 'thermostat'}
    <ThermostatControl device={device.id} props={p} {offline} />
  {:else if device.kind === 'remote' && p['action']?.value}
    <div class="small sub">senast: <span class="mono">{show(p['action'])}</span> {relativeTime(p['action'].changedAt, home.now)}</div>
  {/if}

  <div class="more" id={disclosureId(key)} hidden={!open}>
    {#if open}
      <div class="small meta">
        <span class="mono">{device.id}</span>
        <span>sedd {relativeTime(seenAt, home.now)}</span>
      </div>
      {#if device.kind === 'thermostat'}
        <ThermostatControl device={device.id} props={p} part="setpoint" />
      {/if}
      {#if device.kind === 'light'}
        <div class="ct">
          <span class="small">Färgtemperatur</span>
          <Slider value={num('color_temp')} min={2000} max={6500} step={50} unit=" K" fallback={2700} label="Färgtemperatur {device.name}" onrelease={(n) => sendAction(`set ${device.id} ${n}K`)} />
        </div>
      {/if}
      <DetailList cells={details} showAge={false} />
    {/if}
  </div>
</li>

<style>
  .row {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) 0;
    border-top: 1px solid var(--line);
    min-width: 0;
  }
  .row:first-child {
    border-top: none;
    padding-top: 0;
  }
  /* Name and primary value wrap inside .line; the info button stays top right. */
  .head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-2);
  }
  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-2);
    min-width: 0;
  }
  .kind-icon {
    display: inline-flex;
    color: var(--ink-muted);
    flex-shrink: 0;
  }
  .name {
    font-family: var(--font-ui);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.4;
    color: var(--ink);
    min-width: 0;
    overflow-wrap: break-word;
  }
  .primary {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    white-space: nowrap;
  }
  /* Offline: the word carries it; text drops to ink-faint (never opacity). */
  .offline .name,
  .offline :global(.value) {
    color: var(--ink-faint);
  }
  .small {
    font-size: 13px;
    line-height: 1.4;
    color: var(--ink-faint);
  }

  .more[hidden] {
    display: none;
  }
  .more {
    background: var(--paper-sunken);
    border-radius: var(--radius-m);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
  }
  .ct {
    display: flex;
    flex-direction: column;
  }
</style>
