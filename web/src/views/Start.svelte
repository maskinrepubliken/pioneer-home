<script lang="ts">
  /**
   * The start page (the title in the header leads here): choose the heating mode in one tap, and see each room's
   * temperature and target at a glance. Värme and Program have the details.
   */
  import ModePicker from '../components/ModePicker.svelte';
  import { heatRooms } from '../lib/heat';
  import { buildLive } from '../lib/live';
  import { home } from '../lib/state.svelte';

  const kinds = $derived(Object.fromEntries((home.tables?.devices ?? []).map((d) => [d.id, d.kind])) as Record<string, string>);
  const layout = $derived(buildLive(Object.values(home.cells), kinds, home.rooms));
  const rooms = $derived(heatRooms(layout, home.cells, home.rooms).filter((r) => r.temperature !== null || r.target));
  const deg = (n: number | null) => (n === null ? '—' : `${(Math.round(n * 10) / 10).toFixed(1)}°`);
</script>

<ModePicker size="large" />

<section class="panel" aria-label="Rummen">
  <ul class="rows">
    {#each rooms as r (r.id)}
      {@const target = typeof r.target?.value === 'number' ? r.target.value : null}
      {@const heating = r.heaters.some((h) => h.heating === true)}
      <li class="row">
        <span class="rname">{r.title}</span>
        <span class="sub">{#if r.heaters.length}{heating ? 'värmer' : 'vilar'}{#if target !== null} · mål {deg(target)}{/if}{/if}</span>
        <b class="temp value">{deg(r.temperature)}</b>
      </li>
    {/each}
  </ul>
  <p class="links"><a href="#/heat">Värme</a> · <a href="#/program">Program och veckoschema</a></p>
</section>

<style>
  .panel {
    background: var(--paper-raised);
    border: 1px solid var(--line);
    border-radius: var(--radius-panel);
    padding: var(--space-2) var(--space-4) var(--space-3);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-rows: auto auto;
    column-gap: var(--space-3);
    padding: var(--space-2) 0;
  }
  .row + .row {
    border-top: 1px solid var(--line);
  }
  .rname {
    font-weight: 600;
    font-size: 15px;
  }
  .sub {
    grid-row: 2;
    font-size: 12px;
    color: var(--ink-muted);
  }
  .temp {
    grid-row: 1 / span 2;
    grid-column: 2;
    align-self: center;
    font-family: var(--font-mono);
    font-size: 22px;
    font-weight: 400;
  }
  .links {
    margin: var(--space-3) 0 0;
    font-size: 14px;
  }
  @media (max-width: 640px) {
    .panel {
      margin-left: calc(-1 * var(--space-2));
      margin-right: calc(-1 * var(--space-2));
      border-radius: var(--radius-card);
      padding: var(--space-1) var(--space-3) var(--space-3);
    }
  }
</style>
