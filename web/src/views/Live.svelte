<script lang="ts">
  /**
   * The house, one panel per room (from device `.room` and cell `room`), split into appliance columns
   * (see lib/live.ts). Cells without a room ("Hela huset"), sun, weather and settings sit collapsed under
   * "Visa system" at the bottom.
   */
  import { buildLive } from '../lib/live';
  import { formatDuration } from '../lib/format';
  import { disclosureId, isOpen } from '../lib/disclosure.svelte';
  import { home } from '../lib/state.svelte';
  import DetailList from '../components/live/DetailList.svelte';
  import DisclosureButton from '../components/live/DisclosureButton.svelte';
  import RoomPanel from '../components/live/RoomPanel.svelte';
  import VarRow from '../components/live/VarRow.svelte';
  import AlertBanners from '../components/live/AlertBanners.svelte';

  const kinds = $derived(Object.fromEntries((home.tables?.devices ?? []).map((d) => [d.id, d.kind])) as Record<string, string>);
  const layout = $derived(buildLive(Object.values(home.cells), kinds, home.rooms));
  const rooms = $derived(layout.rooms.filter((r) => r.readings.length || r.columns.length || r.computed.length || r.hidden.length));
  const systemOpen = $derived(isOpen('system'));
</script>

{#if !home.loaded}
  <div class="toolbar"><span class="muted summary">laddar…</span></div>
{/if}

<AlertBanners alerts={layout.alerts} />

{#if home.loaded && !rooms.length && !layout.system.length}
  <div class="empty">Inga celler ännu.</div>
{/if}

<div class="rooms">
  {#each rooms as r (r.key)}
    <RoomPanel room={r} quiet={!r.key} />
  {/each}
</div>

{#if home.loaded}
  <section class="system" aria-label="System">
    <DisclosureButton key="system" text={systemOpen ? 'Dölj system' : 'Visa system'} />
    <div class="blocks" id={disclosureId('system')} hidden={!systemOpen}>
      {#if systemOpen}
        <div class="block card">
          <h3 class="eyebrow">Motorn</h3>
          <dl class="engine">
            <div><dt>Celler</dt><dd class="value">{Object.keys(home.cells).length}</dd></div>
            {#if home.health}
              <div><dt>Drifttid</dt><dd class="value">{formatDuration(home.health.uptimeSeconds * 1000)}</dd></div>
            {/if}
          </dl>
        </div>
        {#each layout.system as b (b.id)}
          <div class="block card">
            <h3 class="eyebrow">{b.name}</h3>
            {#if b.vars?.length}
              <ul class="vars">
                {#each b.vars as v (v.id)}
                  <VarRow cell={v} />
                {/each}
              </ul>
            {/if}
            <DetailList cells={b.cells} ids />
          </div>
        {/each}
      {/if}
    </div>
  </section>
{/if}

<style>
  /* Rooms share rows: each panel's basis and growth follow its number of appliance columns (--cols, set by
     RoomPanel), so a room with one column sits next to others while a room with four takes the full row. */
  .rooms {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-5);
    align-items: flex-start;
  }
  .summary {
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
  }
  .system {
    margin-top: var(--space-6);
  }
  .blocks[hidden] {
    display: none;
  }
  .blocks {
    margin-top: var(--space-4);
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr));
    gap: var(--space-4);
    align-items: start;
  }
  .block {
    padding: var(--space-4);
    min-width: 0;
  }
  .engine {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .engine div {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--space-3);
  }
  .engine dt {
    font-size: 13px;
    line-height: 1.5;
    color: var(--ink-faint);
  }
  .engine dd {
    margin: 0;
  }
  .vars {
    list-style: none;
    margin: 0 0 var(--space-3);
    padding: 0;
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
</style>
