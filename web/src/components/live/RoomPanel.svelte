<script lang="ts">
  /**
   * One panel per room: a column per appliance group (Belysning, Värme, Luft och ventilation, Sensorer, Övrigt),
   * devices and held values as compact rows, and the room's computed cells behind a Detaljer accordion at the bottom.
   */
  import type { LiveRoom } from '../../lib/live';
  import { GROUP_LABEL } from '../../lib/format';
  import { disclosureId, isOpen } from '../../lib/disclosure.svelte';
  import ApplianceRow from './ApplianceRow.svelte';
  import DetailList from './DetailList.svelte';
  import DisclosureButton from './DisclosureButton.svelte';
  import VarRow from './VarRow.svelte';
  import RoomReadings from './RoomReadings.svelte';
  import Icon from './Icon.svelte';
  import { toggleOpen } from '../../lib/disclosure.svelte';

  let { room, quiet = false }: { room: LiveRoom; quiet?: boolean } = $props();

  const key = $derived(`room:${room.key || '_house'}`);
  const open = $derived(isOpen(key));
  const computedCount = $derived(room.computed.reduce((n, g) => n + g.cells.length, 0));
  const hiddenCount = $derived(room.hidden.length);
  const detailsText = $derived(
    [computedCount ? `${computedCount} ${computedCount === 1 ? 'beräknad' : 'beräknade'}` : '', hiddenCount ? `${hiddenCount} ${hiddenCount === 1 ? 'enhet' : 'enheter'}` : '']
      .filter(Boolean)
      .join(' · '),
  );
  const headingId = $derived(`room-${room.key || '_house'}`);
  // Rooms are open by default; the remembered flag records that the room was folded away.
  const foldKey = $derived(`fold:${room.key || '_house'}`);
  const folded = $derived(isOpen(foldKey));
  const bodyId = $derived(`room-body-${room.key || '_house'}`);
</script>

<section class="panel" class:quiet aria-labelledby={headingId} style="--cols: {Math.max(1, room.columns.length)}">
  <h2 class="room" id={headingId}>
    <button class="fold" aria-expanded={!folded} aria-controls={bodyId} onclick={() => toggleOpen(foldKey)} title={folded ? `Visa ${room.title}` : `Fäll ihop ${room.title}`}>
      <span class="chev" class:open={!folded}><Icon name="chevron" size={20} /></span>
      {room.title}
    </button>
  </h2>

  <div id={bodyId} hidden={folded}>
  {#if !folded}
  {#if room.readings.length}
    <RoomReadings readings={room.readings} />
  {/if}
  {#if room.columns.length}
    <div class="columns-clip">
      <div class="columns">
        {#each room.columns as col (col.group)}
          <div class="column">
            <h3 class="eyebrow">{GROUP_LABEL[col.group]}</h3>
            <ul class="rows">
              <!-- heating: the room's target sits above the thermostats that follow it -->
              {#if col.group === 'heating'}
                {#each col.vars as v (v.id)}
                  <VarRow cell={v} />
                {/each}
              {/if}
              {#each col.devices as d (d.id)}
                <ApplianceRow device={d} />
              {/each}
              {#if col.group !== 'heating'}
                {#each col.vars as v (v.id)}
                  <VarRow cell={v} />
                {/each}
              {/if}
            </ul>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if computedCount || hiddenCount}
    <div class="footer" class:alone={!room.columns.length && !room.readings.length}>
      <DisclosureButton {key} text="Detaljer · {detailsText}" label="Detaljer för {room.title}: {detailsText}" />
      <div class="computed" id={disclosureId(key)} hidden={!open}>
        {#if open}
          {#each room.hidden as d (d.id)}
            <div class="cgroup">
              <h3 class="eyebrow">{d.name}</h3>
              <DetailList cells={d.cells.filter((c) => c.prop !== 'room' && c.prop !== 'room_name')} />
            </div>
          {/each}
          {#each room.computed as g (g.group)}
            <div class="cgroup">
              <h3 class="eyebrow">{GROUP_LABEL[g.group]}</h3>
              <DetailList cells={g.cells} ids />
            </div>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
  {/if}
  </div>
</section>

<style>
  .panel {
    background: var(--paper-raised);
    border: 1px solid var(--line);
    border-radius: var(--radius-panel);
    padding: var(--space-4) var(--space-4) var(--space-4);
    min-width: 0;
    /* see .rooms in Live.svelte: ~280px per appliance column, never wider than the row */
    flex: var(--cols) 1 calc(var(--cols) * 280px);
    max-width: 100%;
  }
  @media (min-width: 640px) {
    .panel {
      padding: var(--space-5);
    }
  }
  /* The house panel (cells without a room): same layout, sits on the page surface. */
  .panel.quiet {
    background: var(--paper);
  }
  h2.room {
    font-family: var(--font-display);
    font-size: 20px;
    line-height: 1.1;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--ink);
    margin: 0 0 var(--space-3);
    /* a banner's room link scrolls here; keep the heading clear of the sticky header */
    scroll-margin-top: 96px;
  }
  /* Columns are split by vertical --line rules, not boxes: every column draws a left rule 1px outside itself and
     this wrapper clips the one on the outer edge, so only the rules between columns remain. Wrapped rows (and
     the single column on phones) are separated by the row gap. */
  .columns-clip {
    overflow: hidden;
    margin: 0 calc(-1 * var(--space-4));
  }
  @media (min-width: 640px) {
    .columns-clip {
      margin: 0 calc(-1 * var(--space-5));
    }
  }
  /* The panel is already sized to its columns, so auto-fit lets them share its width evenly. */
  .columns {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
    row-gap: var(--space-5);
    padding: var(--space-2) 0 var(--space-4);
  }
  .columns-clip:last-child .columns {
    padding-bottom: 0;
  }
  .column {
    margin-left: -1px;
    border-left: 1px solid var(--line);
    padding: 0 var(--space-4);
    min-width: 0;
  }
  @media (min-width: 640px) {
    .column {
      padding: 0 var(--space-5);
    }
  }
  .eyebrow {
    font-family: var(--font-display);
    font-size: 12px;
    line-height: 1.2;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--surface-rust);
    margin: 0 0 var(--space-3);
  }
  :global(:root[data-theme='ink']) .eyebrow {
    color: var(--ochre);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .footer {
    border-top: 1px solid var(--line);
    padding-top: var(--space-3);
  }
  .footer.alone {
    border-top: none;
    padding-top: 0;
  }
  .computed[hidden] {
    display: none;
  }
  .computed {
    margin-top: var(--space-3);
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
    gap: var(--space-4) var(--space-6);
  }
  .fold {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    text-transform: inherit;
    letter-spacing: inherit;
    cursor: pointer;
  }
  .fold:hover {
    color: var(--ink-muted);
  }
  .chev {
    display: inline-flex;
    color: var(--ink-muted);
  }
  .chev.open {
    transform: rotate(90deg);
  }
</style>
