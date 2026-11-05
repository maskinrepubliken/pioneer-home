<script lang="ts">
  /**
   * The heating mode: what is in force now and the buttons to choose Program (the week schedule, heated by price and
   * weather), a mode to hold (Hemma, Sova, Borta: the heat_use_<mode> cells) or Manuellt. On the start page large
   * (a button per line with what it means), on Värme compact (one row). See lib/heat.ts for the cells it reads.
   */
  import { MANUAL, MANUAL_NAME, PROGRAM, PROGRAM_NAME, heatModes, heatState } from '../lib/heat';
  import { DAY_NAMES, nextChange, parseWeek, slotOf } from '../lib/week';
  import { home, sendAction } from '../lib/state.svelte';

  let { size = 'compact' }: { size?: 'compact' | 'large' } = $props();

  const modes = $derived(heatModes(Object.values(home.cells)));
  const heat = $derived(heatState(home.cells));
  const active = $derived(modes.filter((m) => m.inUse));
  const name = (id: string) => modes.find((m) => m.id === id)?.name ?? id;
  const week = $derived(parseWeek(home.tables?.files?.['week.tsv'] ?? ''));
  const next = $derived(heat.mode === PROGRAM ? nextChange(week, home.now) : null);
  const when = (ms: number) => {
    const s = slotOf(ms);
    const today = slotOf(home.now).day;
    const hh = String(s.hour).padStart(2, '0');
    return s.day === today ? `kl ${hh}` : s.day === (today + 1) % 7 ? `i morgon kl ${hh}` : `${DAY_NAMES[s.day]} kl ${hh}`;
  };

  /** What is in force now, as the big line: the modes (two in a transition), or Manuellt. */
  const title = $derived(heat.mode === MANUAL ? MANUAL_NAME : active.length ? active.map((m) => m.name).join(' + ') : heat.mode === null ? '—' : PROGRAM_NAME);
  const eyebrow = $derived(heat.mode === PROGRAM ? 'Program · veckoschemat' : heat.mode === MANUAL ? 'Värmeläge' : 'Valt läge');

  const choices = $derived([
    { id: PROGRAM, name: PROGRAM_NAME, what: 'veckoschemat, värmer när elen är billig' },
    ...modes.map((m) => ({ id: m.id, name: m.name, what: 'hela tiden, tills du väljer annat' })),
    { id: MANUAL, name: MANUAL_NAME, what: 'målen som de är nu, ändras för hand' },
  ]);

  let choosing = $state<string | null>(null);
  async function choose(id: string) {
    if (choosing || id === heat.mode) return;
    choosing = id;
    await sendAction(`set heat_mode ${id}`);
    choosing = null;
  }
</script>

<section class="picker {size}" aria-labelledby="h-mode">
  <p class="eyebrow" id="h-mode">{eyebrow}</p>
  <h1 class="mode">{title}</h1>
  <p class="status" aria-live="polite">
    {#if !home.loaded}
      laddar…
    {:else if heat.mode === null}
      Inga värmelägen i tabellerna än (heat_mode i Celler).
    {:else if heat.mode === MANUAL}
      Målen är ändrade för hand och gäller tills du väljer Program eller ett läge.
    {:else if heat.mode === PROGRAM}
      {#if heat.transition}Övergång.{/if}
      {#if next}Nästa: {next.modes.length ? next.modes.map(name).join(' + ') : 'inget läge'} {when(next.at)}.{/if}
      Programmet värmer efter elpris och väder.
    {:else}
      {name(heat.mode)} gäller tills du väljer något annat. Programmet värmer efter elpris inom lägets temperaturer.
    {/if}
  </p>
  {#if heat.mode !== null}
    <div class="choices" role="radiogroup" aria-label="Välj värmeläge">
      {#each choices as c (c.id)}
        {@const chosen = heat.mode === c.id}
        <button class="choice" class:chosen role="radio" aria-checked={chosen} disabled={choosing !== null} onclick={() => choose(c.id)}>
          <span class="hole" class:filled={chosen} aria-hidden="true"></span>
          <span class="cname">{c.name}</span>
          {#if size === 'large'}<span class="what">{c.what}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</section>

<style>
  /* A forest surface, the one big poster line of the page. */
  .picker {
    background: var(--surface-forest);
    color: var(--on-dark);
    border-radius: var(--radius-panel);
    padding: var(--space-5);
    margin-bottom: var(--space-4);
  }
  .eyebrow {
    font-family: var(--font-display);
    font-size: 12px;
    line-height: 1.2;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--ochre);
    margin: 0;
  }
  .mode {
    font-family: var(--font-display);
    font-weight: 900;
    font-size: clamp(34px, 7vw, 60px);
    line-height: 1;
    letter-spacing: -0.01em;
    text-transform: uppercase;
    margin: var(--space-1) 0 0;
  }
  .status {
    margin: var(--space-2) 0 0;
    font-size: 14px;
    line-height: 1.45;
    max-width: 60ch;
  }
  .choices {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
    gap: var(--space-1);
    margin-top: var(--space-4);
    max-width: 680px;
  }
  .large .choices {
    grid-template-columns: 1fr;
    gap: var(--space-2);
    max-width: 520px;
  }
  .choice {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 40px;
    padding: 6px 8px;
    border-radius: var(--radius-pill);
    border: 1px solid var(--on-dark);
    background: var(--surface-forest);
    color: var(--on-dark);
    font-family: var(--font-ui);
    font-size: 15px;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    min-width: 0;
  }
  .large .choice {
    justify-content: flex-start;
    min-height: 56px;
    padding: 8px 20px;
    gap: var(--space-3);
    font-size: 18px;
  }
  .what {
    margin-left: auto;
    font-family: var(--font-ui);
    font-size: 13px;
    font-weight: 400;
    text-align: right;
  }
  .choice:hover {
    background: var(--surface-ink);
  }
  .choice:focus-visible {
    outline: 2px solid var(--focus-on-dark);
    outline-offset: 2px;
  }
  .choice.chosen,
  .choice.chosen:hover {
    background: var(--ochre);
    border-color: var(--ochre);
    color: var(--on-ochre);
  }
  .choice:disabled {
    cursor: default;
  }
  /* A punch-card hole: filled = chosen. */
  .hole {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1.5px solid currentColor;
    flex-shrink: 0;
  }
  .large .hole {
    width: 14px;
    height: 14px;
  }
  .hole.filled {
    background: currentColor;
  }
  @media (max-width: 640px) {
    .picker {
      margin-left: calc(-1 * var(--space-2));
      margin-right: calc(-1 * var(--space-2));
      padding: var(--space-4);
      border-radius: var(--radius-card);
    }
    .compact .choices {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .compact .choice {
      font-size: 14px;
      gap: 5px;
      padding: 6px 4px;
    }
    .large .choice {
      padding: 8px 14px;
      font-size: 17px;
    }
    .what {
      font-size: 12px;
    }
  }
</style>
