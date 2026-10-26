<script lang="ts">
  /**
   * Everything measured in a room, together at the top of its panel: one tile per quantity (temperature,
   * humidity, light, motion, open/closed) whatever device reports it. The big number is the room value
   * (mean of reachable sources, motion when any sensor sees it); the sources are listed under it.
   * Drawn as a solid ink block for contrast against the paper panel.
   */
  import type { RoomReading } from '../../lib/live';
  import { formatQuantity, propLabel, relativeTime } from '../../lib/format';
  import { home } from '../../lib/state.svelte';

  let { readings }: { readings: RoomReading[] } = $props();

  const UNIT: Record<string, string> = { temperature: '°C', humidity: '%', illuminance: 'lx' };
  const WORD: Record<string, [string, string]> = { occupancy: ['Rörelse', 'Ingen rörelse'], open: ['Öppen', 'Stängd'] };

  function main(r: RoomReading): string {
    if (r.value === null) return '—';
    if (typeof r.value === 'boolean') return WORD[r.prop]![r.value ? 0 : 1];
    return formatQuantity(r.value, UNIT[r.prop] ?? '');
  }
  function source(r: RoomReading, v: number | boolean): string {
    if (typeof v === 'boolean') return WORD[r.prop]![v ? 0 : 1].toLowerCase();
    return formatQuantity(v, UNIT[r.prop] ?? '');
  }
  /** For a word reading: when it last changed (the latest change among the sources). */
  function since(r: RoomReading): string | null {
    if (typeof r.value !== 'boolean') return null;
    const at = Math.max(...r.sources.map((s) => s.changedAt ?? 0));
    return at ? `sedan ${relativeTime(at, home.now).replace(/^för /, '').replace(/ sedan$/, '')}` : null;
  }
</script>

<div class="readings" role="group" aria-label="Mätvärden i rummet">
  {#each readings as r (r.prop)}
    <div class="tile" class:word={typeof r.value === 'boolean'} class:active={r.value === true}>
      <span class="label">{propLabel(r.prop)}</span>
      <span class="main">
        {#if r.value === true}<span class="mark" aria-hidden="true"></span>{/if}
        <b class:value={typeof r.value !== 'boolean'}>{main(r)}</b>
      </span>
      {#if since(r)}<span class="since">{since(r)}</span>{/if}
      <!-- one source is the room value itself; list them only when several (or an unreachable one) make it up -->
      {#if r.sources.length > 1}
      <ul class="sources">
        {#each r.sources as s (s.device)}
          <li class:offline={s.offline} title={s.device}>
            <span class="src">{s.name}</span>
            {#if s.offline}<span class="gone">nås inte</span>{:else}<span class="v">{source(r, s.value)}</span>{/if}
          </li>
        {/each}
      </ul>
      {/if}
    </div>
  {/each}
</div>

<style>
  /* One solid ink block (design system: surface-* are whole blocks, text on them is on-dark). Hierarchy comes
     from size and weight, not tone; tile labels in ochre; tiles split by line-strong rules clipped at the edge. */
  .readings {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr));
    row-gap: var(--space-5);
    background: var(--surface-ink);
    color: var(--on-dark);
    border-radius: var(--radius-m);
    padding: var(--space-5) 0;
    margin-bottom: var(--space-4);
    overflow: hidden;
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: 0 var(--space-5);
    margin-left: -1px;
    border-left: 1px solid var(--line-strong);
    min-width: 0;
  }
  .label {
    font-family: var(--font-display);
    font-size: 11px;
    line-height: 1.2;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--ochre);
  }
  .main {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .main b {
    font-family: var(--font-mono);
    font-size: 32px;
    line-height: 1.1;
    font-weight: 500;
    color: var(--on-dark);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  /* Word readings (Rörelse, Stängd) in the display face, a size down so they fit a tile. */
  .word .main b {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    white-space: normal;
  }
  /* Motion right now: an ochre mark beside the word (the word carries it, the mark only draws the eye). */
  .mark {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--ochre);
    flex-shrink: 0;
  }
  .since {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--on-dark);
  }
  .sources {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: var(--space-2) 0 0;
    border-top: 1px solid var(--line-strong);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .sources li {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--space-2);
    font-size: 12px;
    line-height: 1.5;
    color: var(--on-dark);
  }
  .src {
    min-width: 0;
  }
  .v {
    font-family: var(--font-mono);
    white-space: nowrap;
  }
  /* Unreachable source: struck through plus an outlined badge; the word carries it on the dark block. */
  .gone {
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 10px;
    line-height: 1;
    padding: 3px 6px;
    border: 1px solid var(--on-dark);
    border-radius: var(--radius-pill);
    white-space: nowrap;
  }
  .offline .src {
    text-decoration: line-through;
  }
</style>
