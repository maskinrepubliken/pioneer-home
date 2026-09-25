<script lang="ts">
  /** Engine passes, newest first. Seeded from /api/trace, then appended live over SSE. */
  import TraceCard from '../components/TraceCard.svelte';
  import { home, TRACE_CAP } from '../lib/state.svelte';
  import type { Trace } from '../lib/api';

  let filter = $state('');
  let hideQuiet = $state(true);

  const isQuiet = (t: Trace) => !t.rules.some((r) => r.fired) && t.actions.length === 0 && t.errors.length === 0;

  function matches(t: Trace, q: string): boolean {
    if (!q) return true;
    const hay = [
      t.cause,
      ...t.changed.map((c) => c.cell),
      ...t.derived.map((c) => c.cell),
      ...t.rules.filter((r) => r.fired).map((r) => r.id),
      ...t.actions.map((a) => `${a.detail} ${a.topic ?? ''} ${a.payload ?? ''}`),
      ...t.sequences.map((s) => s.id),
      ...t.errors,
    ]
      .join('\n')
      .toLowerCase();
    return q
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((w) => hay.includes(w));
  }

  const shown = $derived(home.traces.filter((t) => (!hideQuiet || !isQuiet(t)) && matches(t, filter)));
</script>

<div class="toolbar">
  <input type="search" placeholder="Filtrera: cell, regel, åtgärd, orsak…" bind:value={filter} aria-label="Filtrera spår" />
  <label class="check"><input type="checkbox" bind:checked={hideQuiet} /> Dölj tysta pass</label>
  <span class="spacer"></span>
  <span class="muted small">{shown.length} / {home.traces.length} (max {TRACE_CAP})</span>
</div>

{#if !shown.length}
  <div class="empty">{home.traces.length ? 'Inget matchar' : 'Inga spår ännu'}</div>
{:else}
  <div class="list">
    {#each shown as t (t.at + t.cause)}
      <TraceCard trace={t} />
    {/each}
  </div>
{/if}

<style>
  .list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  input[type='search'] {
    flex: 1 1 220px;
  }
  .small {
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
  }
</style>
