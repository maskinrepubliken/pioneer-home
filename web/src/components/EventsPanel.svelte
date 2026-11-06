<script lang="ts">
  /**
   * Events in the period shown (events.tsv, lib/events.ts): where one era of the statistics ends and the next
   * begins, newest last, and a small form to add one (saved through PUT /api/tables/events.tsv, which validates
   * first; Tabeller edits or removes them). Used on Kostnader and Grafer; every chart marks the same events.
   */
  import { saveTable } from '../lib/api';
  import { addEvent, atText, eventWhen, eventsIn, parseEvents } from '../lib/events';
  import { home, notify } from '../lib/state.svelte';

  let { since, until }: { since: number; until: number } = $props();

  const text = $derived(home.tables?.files?.['events.tsv'] ?? '');
  const all = $derived(parseEvents(text));
  const inPeriod = $derived(eventsIn(all, since, until));

  let open = $state(false);
  let when = $state('');
  let title = $state('');
  let note = $state('');
  let saving = $state(false);
  let errors = $state<string[]>([]);

  function start() {
    // the browser's datetime-local wants YYYY-MM-DDTHH:MM
    when = atText(new Date()).replace(' ', 'T');
    title = '';
    note = '';
    errors = [];
    open = true;
  }
  async function save() {
    if (!title.trim() || !when) {
      errors = ['Skriv vad som hände och när.'];
      return;
    }
    saving = true;
    errors = [];
    try {
      const res = await saveTable('events.tsv', addEvent(text, when.replace('T', ' '), title, note), { message: `händelse: ${title.trim()}` });
      if (res.status === 422) errors = res.errors.map((e) => `rad ${e.line}: ${e.message}`);
      else if (!res.ok) errors = [`sparat, men motorn kunde inte läsa in det: ${res.reloadError ?? 'okänt fel'}`];
      else {
        open = false;
        notify('Händelsen är sparad.');
      }
    } catch (e) {
      errors = [(e as Error).message];
    }
    saving = false;
  }
</script>

<section class="events" aria-labelledby="h-events">
  <header class="head">
    <h3 id="h-events">Händelser</h3>
    {#if !open}<button class="btn small" onclick={start}>Ny händelse</button>{/if}
  </header>
  {#if inPeriod.length}
    <ol>
      {#each inPeriod as e (e.t)}
        <li><span class="when">{eventWhen(e)}</span> <b>{e.title}</b>{#if e.note}<span class="note"> · {e.note}</span>{/if}</li>
      {/each}
    </ol>
    <p class="small faint">Streckade linjer i diagrammen. Statistiken före och efter en händelse hör till olika epoker och jämförs inte rakt av.</p>
  {:else}
    <p class="small faint">Inga händelser i perioden{all.length ? ` (senaste: ${eventWhen(all[all.length - 1]!)}, ${all[all.length - 1]!.title})` : ''}.</p>
  {/if}
  {#if open}
    <form class="add" onsubmit={(e) => (e.preventDefault(), void save())}>
      <label>När <input type="datetime-local" bind:value={when} required /></label>
      <label>Vad hände <input type="text" bind:value={title} placeholder="Fönstren isolerade" maxlength="80" required /></label>
      <label>Anteckning <input type="text" bind:value={note} placeholder="valfri" maxlength="200" /></label>
      {#if errors.length}<p class="errors" role="alert">{errors.join(' · ')}</p>{/if}
      <div class="actions">
        <button class="btn primary" type="submit" disabled={saving}>{saving ? 'Sparar…' : 'Spara'}</button>
        <button class="btn" type="button" disabled={saving} onclick={() => (open = false)}>Avbryt</button>
      </div>
    </form>
  {/if}
</section>

<style>
  .events {
    margin-top: var(--space-5);
    padding-top: var(--space-3);
    border-top: 1px solid var(--line);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-2);
  }
  h3 {
    font-size: 14px;
    font-weight: 600;
    margin: 0;
  }
  ol {
    list-style: none;
    margin: 0 0 var(--space-2);
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: 14px;
  }
  .when {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--ink-muted);
  }
  .note {
    color: var(--ink-muted);
  }
  .small {
    font-size: 12px;
    line-height: 1.5;
    margin: 0;
  }
  .add {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-3);
    max-width: 420px;
  }
  .add label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 13px;
    color: var(--ink-muted);
  }
  .add input {
    font: inherit;
    font-size: 15px;
    color: var(--ink);
    background: var(--paper);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-s);
    padding: 6px 8px;
  }
  .add input:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }
  .actions {
    display: flex;
    gap: var(--space-2);
  }
  .errors {
    color: var(--alarm);
    font-size: 13px;
    margin: 0;
  }
</style>
