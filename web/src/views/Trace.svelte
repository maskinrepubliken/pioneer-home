<script lang="ts">
  /**
   * Logg: the engine's passes, newest first. Seeded from /api/trace, then appended live over SSE.
   * By default only passes in which the house did something are shown (a rule fired, a command was sent, an error);
   * the many passes where only a value moved (a sensor report, the clock) are behind the checkbox.
   */
  import TraceCard from '../components/TraceCard.svelte';
  import { home, TRACE_CAP } from '../lib/state.svelte';
  import type { Trace } from '../lib/api';

  let filter = $state('');
  let showAll = $state(false);

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

  const shown = $derived(home.traces.filter((t) => (showAll || !isQuiet(t)) && matches(t, filter)));
</script>

<section class="intro">
  <p>
    Vad motorn har gjort, senaste först. Varje gång något händer, en sensor rapporterar, klockan slår eller någon trycker
    på en knapp, går motorn igenom tabellerna en gång: den räknar om cellerna, prövar reglerna och skickar kommandon.
    Varje kort är en sådan genomgång: överst <b>orsaken</b>, sedan vilka <b>värden som ändrades</b>, vilka <b>regler som fyrade</b>
    och vilka <b>kommandon</b> som skickades till enheterna.
  </p>
  <p class="muted">
    Använd den för att se varför något hände, eller inte hände. Motorn sparar de senaste {TRACE_CAP} genomgångarna; äldre försvinner.
  </p>
</section>

<div class="toolbar">
  <input type="search" placeholder="Filtrera: cell, regel, åtgärd, orsak…" bind:value={filter} aria-label="Filtrera loggen" />
  <label class="check" title="Annars visas bara genomgångar där en regel fyrade, ett kommando skickades eller något gick fel">
    <input type="checkbox" bind:checked={showAll} /> Visa även när bara ett värde ändrades
  </label>
  <span class="spacer"></span>
  <span class="muted small">{shown.length} / {home.traces.length} (max {TRACE_CAP})</span>
</div>

{#if !shown.length}
  <div class="empty">{home.traces.length ? (showAll ? 'Inget matchar' : 'Ingen regel har fyrat ännu. Kryssa i rutan för att se allt.') : 'Inget i loggen ännu'}</div>
{:else}
  <div class="list">
    {#each shown as t (t.at + t.cause)}
      <TraceCard trace={t} />
    {/each}
  </div>
{/if}

<style>
  .intro {
    max-width: 72ch;
    margin-bottom: var(--space-4);
  }
  .intro p {
    margin: 0 0 var(--space-2);
    font-size: 15px;
    line-height: 1.55;
    color: var(--ink);
  }
  .intro p.muted {
    font-size: 13px;
    color: var(--ink-faint);
  }
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
