<script lang="ts">
  /** One card per device (or pseudo-device for computed / system cells). */
  import type { Cell } from '../lib/api';
  import { cellLabel, kindIcon, kindName, onOff, relativeTime, roomName } from '../lib/format';
  import { home, sendAction } from '../lib/state.svelte';
  import CellValue from './CellValue.svelte';
  import Controls from './Controls.svelte';

  export interface DeviceGroup {
    id: string;
    name: string;
    kind: string;
    room: string | null;
    cells: Cell[];
  }

  let { group, showAll }: { group: DeviceGroup; showAll: boolean } = $props();

  // room / room_name mirror devices.tsv; the room is already the section header, so they show under "Visa allt".
  const HIDDEN_PROPS = new Set(['linkquality', 'last_seen', 'available', 'room', 'room_name']);
  const CONTROL_KINDS = new Set(['light', 'plug', 'pwm', 'thermostat']);

  const byProp = $derived(Object.fromEntries(group.cells.map((c) => [c.prop ?? c.id, c])) as Record<string, Cell>);
  const visible = $derived(
    group.cells.filter((c) => {
      if (showAll) return true;
      if (c.prop && HIDDEN_PROPS.has(c.prop)) return false;
      if (c.value === null) return false;
      // The primary state of a controllable device is already on the toggle/slider.
      return true;
    }),
  );
  const available = $derived(byProp['available']?.value);
  const lastSeen = $derived(byProp['last_seen']?.value);
  const lastSeenAt = $derived(typeof lastSeen === 'object' && lastSeen && '$timestamp' in lastSeen ? lastSeen.$timestamp : null);
  const isDevice = $derived(CONTROL_KINDS.has(group.kind));
  const idLabels = $derived(group.kind === 'computed' || group.kind === 'system');
  const varToggle = (c: Cell) => c.kind === 'var' && c.type === 'boolean' && c.settable;
</script>

<article class="card device" class:offline={available === false}>
  <header>
    <span class="icon" aria-hidden="true" title={kindName(group.kind)}>{kindIcon(group.kind)}</span>
    <div class="titles">
      <div class="name">{group.name}</div>
      <div class="sub mono">
        {group.id}
        {#if available === false}
          <span class="pill danger">offline</span>
        {/if}
        {#if lastSeenAt}
          <span class="faint">sedd {relativeTime(lastSeenAt, home.now)}</span>
        {/if}
        {#if showAll && group.room}
          <span class="faint">{roomName(group.room, home.rooms)}</span>
        {/if}
      </div>
    </div>
  </header>

  {#if visible.length}
    <ul class="cells">
      {#each visible as c (c.id)}
        <li>
          <span class="label" class:mono={idLabels} title={c.id}>{idLabels ? c.id : cellLabel(c)}</span>
          <span class="value">
            {#if varToggle(c)}
              <span class="state-word mono">{typeof c.value === 'boolean' ? onOff(c.value) : 'NULL'}</span>
              <button
                class="toggle"
                class:on={c.value === true}
                onclick={() => sendAction(`set ${c.id} ${c.value === true ? 'FALSE' : 'TRUE'}`)}
                aria-pressed={c.value === true}
                aria-label="Växla {c.id}"
                title="Växla {c.id}"
              >
                <span class="knob"></span>
              </button>
              {#if c.changedAt}<span class="age">{relativeTime(c.changedAt, home.now)}</span>{/if}
            {:else}
              <CellValue cell={c} />
            {/if}
          </span>
        </li>
      {/each}
    </ul>
  {:else}
    <div class="nothing">Inga värden ännu</div>
  {/if}

  {#if isDevice}
    <Controls device={group.id} kind={group.kind} cells={byProp} />
  {/if}
</article>

<style>
  .device {
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    break-inside: avoid;
  }
  @media (min-width: 640px) {
    .device {
      padding: var(--space-6);
    }
  }
  /* Offline: the disabled surface; the word "offline" carries the state. */
  .device.offline {
    background: var(--paper-sunken);
  }
  header {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    margin-bottom: var(--space-3);
  }
  .icon {
    font-size: 20px;
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    background: var(--paper-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    flex-shrink: 0;
  }
  .titles {
    min-width: 0;
  }
  .name {
    font-family: var(--font-ui);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.4;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    color: var(--ink-faint);
    font-size: 12px;
    line-height: 1.4;
    display: flex;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
  }
  ul.cells {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  li {
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
    align-items: baseline;
  }
  .label {
    font-family: var(--font-ui);
    font-size: 14px;
    line-height: 1.5;
    color: var(--ink-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .label.mono {
    font-family: var(--font-mono);
    font-size: 13px;
  }
  .value {
    text-align: right;
    flex-shrink: 0;
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
  }
  .age {
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.4;
    color: var(--ink-faint);
  }
  /* "bildtext": empty state. */
  .nothing {
    font-family: var(--font-prose);
    font-style: italic;
    font-size: 15px;
    line-height: 1.55;
    color: var(--ink-muted);
  }
  .state-word {
    font-size: 12px;
    letter-spacing: 0.1em;
    color: var(--ink-muted);
  }
</style>
