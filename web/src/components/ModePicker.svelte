<script lang="ts">
  /**
   * The heating mode, at the top of Värme: what is in force now, the next switch of the week schedule, the buttons to
   * choose Program (the week schedule, heated by price and weather), a mode to hold (Hemma, Sova, Borta: the
   * heat_use_<mode> cells) or Manuellt, and what the chosen one means. See lib/heat.ts for the cells it reads.
   * A mode chosen holds at once, until further notice; for a while (ASK_MS, or until the page is left) the choices of
   * how long show under the buttons: the rest of the day (until the week schedule's night mode, the cell
   * heat_night_mode, begins: the night keeps its place), a day more, a time picked in a dialog, or until further
   * notice, the one in force marked. Choosing the mode in force again brings them back. The end goes to the cell
   * heat_until; the rule heat_until_end returns to Program then, and the program plans the time after it by the
   * schedule, so it can warm the house in time for a return.
   */
  import { MANUAL, MANUAL_NAME, PROGRAM, PROGRAM_NAME, heatModes, heatState } from '../lib/heat';
  import { DAY_NAMES, nextChange, nextSwitches, parseWeek, slotOf } from '../lib/week';
  import { isTimestamp } from '../lib/format';
  import { home, sendAction } from '../lib/state.svelte';

  const modes = $derived(heatModes(Object.values(home.cells)));
  const heat = $derived(heatState(home.cells));
  const active = $derived(modes.filter((m) => m.inUse));
  const name = (id: string) => modes.find((m) => m.id === id)?.name ?? id;
  const week = $derived(parseWeek(home.tables?.files?.['week.tsv'] ?? ''));
  const next = $derived(heat.mode === PROGRAM ? nextChange(week, home.now) : null);
  const when = (ms: number) => {
    const s = slotOf(ms);
    const today = slotOf(home.now).day;
    const d = new Date(ms);
    const hh = String(s.hour).padStart(2, '0') + (d.getMinutes() ? `:${String(d.getMinutes()).padStart(2, '0')}` : '');
    const inWeek = ms - home.now < 6 * 86_400_000;
    const day = !inWeek ? `${d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' })} ` : s.day === today ? '' : s.day === (today + 1) % 7 ? 'i morgon ' : `${DAY_NAMES[s.day]} `;
    return `${day}kl ${hh}`;
  };

  /** When the mode chosen by hand ends (heat_until), null = until further notice. */
  const until = $derived.by(() => {
    const v = home.cells['heat_until']?.value;
    return isTimestamp(v ?? null) ? (v as { $timestamp: number }).$timestamp : null;
  });
  const night = $derived(typeof home.cells['heat_night_mode']?.value === 'string' ? (home.cells['heat_night_mode']!.value as string) : null);
  const hasUntil = $derived('heat_until' in home.cells);

  /** What is in force now, as the big line: the modes (two in a transition), or Manuellt. */
  const title = $derived(heat.mode === MANUAL ? MANUAL_NAME : active.length ? active.map((m) => m.name).join(' + ') : heat.mode === null ? '—' : PROGRAM_NAME);
  const eyebrow = $derived(heat.mode === PROGRAM ? 'Program · veckoschemat' : heat.mode === MANUAL ? 'Värmeläge' : 'Valt läge');

  /** The modes to hold on the left, Program and Manuellt on the right. */
  const held = $derived(modes.map((m) => ({ id: m.id, name: m.name, what: 'tills du väljer något annat' })));
  const others = [
    { id: PROGRAM, name: PROGRAM_NAME, what: 'veckoschemat, värmer när elen är billig' },
    { id: MANUAL, name: MANUAL_NAME, what: 'målen som de är nu, ändras för hand' },
  ];
  const choices = $derived([...held, ...others]);

  let choosing = $state<string | null>(null);
  /** The mode whose duration is being asked for. */
  let asking = $state<string | null>(null);
  let custom = $state('');
  let dialog = $state<HTMLDialogElement | null>(null);

  /** The choices hide after this long without a touch (not while the time dialog is open). */
  const ASK_MS = 15_000;
  let askTimer: ReturnType<typeof setTimeout> | null = null;
  function keepAsking() {
    if (askTimer) clearTimeout(askTimer);
    askTimer = setTimeout(() => {
      if (!dialog?.open) asking = null;
    }, ASK_MS);
  }
  $effect(() => () => {
    if (askTimer) clearTimeout(askTimer);
  });

  /** The quick ends for a mode: the rest of the day and a day more (or the night and a night more for the night mode). */
  const quick = $derived.by(() => {
    if (!asking) return [];
    const m = asking;
    const nightMode = night;
    if (nightMode && week.some((d) => d.some((h) => h.includes(nightMode)))) {
      const ends = nextSwitches(week, home.now, nightMode, m === nightMode ? 'end' : 'start', 2);
      const labels = m === nightMode ? ['I natt', 'I natt och nästa'] : ['Idag', 'I morgon också'];
      return ends.map((at, i) => ({ label: labels[i]!, at }));
    }
    const midnight = new Date(home.now);
    midnight.setHours(24, 0, 0, 0);
    return [
      { label: 'Idag', at: midnight.getTime() },
      { label: 'I morgon också', at: midnight.getTime() + 86_400_000 },
    ];
  });

  /** A mode, until further notice (the end cleared first, so an old end never ends the new mode). */
  async function apply(id: string) {
    choosing = id;
    if (hasUntil) await sendAction('set heat_until NULL');
    await sendAction(`set heat_mode ${id}`);
    choosing = null;
  }
  /** The end of the mode in force; null = until further notice. */
  async function setEnd(end: number | null) {
    choosing = asking;
    asking = null;
    await sendAction(`set heat_until ${end === null ? 'NULL' : new Date(end).toISOString()}`);
    choosing = null;
  }
  function choose(id: string) {
    if (choosing) return;
    const holds = hasUntil && id !== PROGRAM && id !== MANUAL;
    if (id !== heat.mode || (!holds && until !== null)) void apply(id);
    // a mode to hold: it holds at once until further notice, and how long can be chosen for a while
    asking = holds ? id : null;
    if (holds) keepAsking();
  }
  function openTime() {
    const d = new Date(until ?? home.now + 3 * 3_600_000);
    if (until === null) d.setMinutes(0, 0, 0);
    const two = (n: number) => String(n).padStart(2, '0');
    custom = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
    dialog?.showModal();
  }
  function closeTime() {
    dialog?.close();
    keepAsking();
  }
  /** Which choice is in force: an end that is one of the quick ones, another time, or none. */
  const endChoice = $derived(until === null ? 'none' : quick.some((q) => q.at === until) ? String(until) : 'time');
</script>

<section class="picker" aria-labelledby="h-mode">
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
    {:else if until !== null}
      {name(heat.mode)} {when(until)}, sedan Program. Programmet värmer efter elpris inom lägets temperaturer och i tid inför schemat efter.
    {:else}
      {name(heat.mode)} gäller tills du väljer något annat. Programmet värmer efter elpris inom lägets temperaturer.
    {/if}
  </p>
  {#if heat.mode !== null}
    <div class="choices" role="radiogroup" aria-label="Välj värmeläge">
      {#each [held, others] as group, g (g)}
        <div class="group" class:held={g === 0} style="--n: {group.length}">
          {#each group as c (c.id)}
            {@const chosen = heat.mode === c.id}
            <button class="choice" class:chosen class:asking={asking === c.id} role="radio" aria-checked={chosen} disabled={choosing !== null} onclick={() => choose(c.id)}>
              <span class="hole" class:filled={chosen} aria-hidden="true"></span>
              <span class="cname">{c.name}</span>
            </button>
          {/each}
        </div>
      {/each}
    </div>
    {#if asking}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div class="ask" role="group" aria-labelledby="h-ask" onpointerdown={keepAsking} onkeydown={keepAsking}>
        <p class="ask-title" id="h-ask">Hur länge ska {name(asking)} gälla?</p>
        <div class="ask-options">
          <button class="choice" class:chosen={endChoice === 'none'} aria-pressed={endChoice === 'none'} disabled={choosing !== null} onclick={() => setEnd(null)}><span class="cname">Tills vidare</span><span class="sub">tills du väljer annat</span></button>
          {#each quick as q (q.label)}
            <button class="choice" class:chosen={endChoice === String(q.at)} aria-pressed={endChoice === String(q.at)} disabled={choosing !== null} onclick={() => setEnd(q.at)}><span class="cname">{q.label}</span><span class="sub">till {when(q.at)}</span></button>
          {/each}
          <button class="choice" class:chosen={endChoice === 'time'} aria-pressed={endChoice === 'time'} aria-haspopup="dialog" disabled={choosing !== null} onclick={openTime}><span class="cname">Till en vald tid</span><span class="sub">{endChoice === 'time' && until !== null ? `till ${when(until)}` : 'datum och klockslag'}</span></button>
        </div>
      </div>
    {:else}
      {@const chosen = choices.find((c) => c.id === heat.mode)}
      {#if chosen}<p class="what">{chosen.name}: {until !== null && chosen.id !== PROGRAM && chosen.id !== MANUAL ? `${when(until)}, sedan Program` : chosen.what}.</p>{/if}
    {/if}
  {/if}
  <dialog class="timebox" bind:this={dialog} aria-labelledby="h-time" onclose={keepAsking}>
    <form method="dialog" onsubmit={(e) => (e.preventDefault(), custom && (closeTime(), void setEnd(new Date(custom).getTime())))}>
      <p class="time-title" id="h-time">{asking ? name(asking) : 'Läget'} till</p>
      <input type="datetime-local" bind:value={custom} required />
      <div class="time-actions">
        <button class="btn primary" type="submit" disabled={!custom || new Date(custom).getTime() <= home.now}>Välj</button>
        <button class="btn" type="button" onclick={closeTime}>Avbryt</button>
      </div>
    </form>
  </dialog>
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
  /* The held modes fill the left; Program and Manuellt sit apart on the right. */
  .choices {
    display: flex;
    justify-content: space-between;
    gap: var(--space-4);
    margin-top: var(--space-4);
  }
  .group {
    display: grid;
    grid-template-columns: repeat(var(--n), minmax(0, 1fr));
    gap: var(--space-1);
    flex: 2 1 0;
    max-width: 420px;
    min-width: 0;
  }
  .group:not(.held) {
    flex: 1.4 1 0;
    max-width: 290px;
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
  .what {
    margin: var(--space-2) 0 0;
    font-size: 13px;
    line-height: 1.45;
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
    /* Too narrow for five in a row: the modes on one line, Program and Manuellt under them on the right, each
       button as wide as a mode's. */
    .choices {
      flex-direction: column;
      align-items: flex-end;
      gap: var(--space-1);
    }
    .group,
    .group:not(.held) {
      flex: none;
      width: 100%;
      max-width: none;
    }
    .group:not(.held) {
      width: calc((100% - 2 * var(--space-1)) * 2 / 3 + var(--space-1));
    }
    .choice {
      font-size: 14px;
      gap: 5px;
      padding: 6px 4px;
    }
  }
  /* How long a mode chosen by hand holds: quick ends, until further notice, or a time picked. */
  .ask {
    margin-top: var(--space-3);
    max-width: 680px;
  }
  .ask-title {
    margin: 0 0 var(--space-2);
    font-size: 14px;
    font-weight: 600;
  }
  .ask-options {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--space-1);
  }
  .ask-options .choice {
    flex-direction: column;
    gap: 2px;
    min-height: 48px;
  }
  .sub {
    font-size: 12px;
    font-weight: 400;
  }
  /* The time picked: a dialog on paper, over the page. */
  .timebox {
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-panel);
    background: var(--paper);
    color: var(--ink);
    padding: var(--space-5);
    width: min(360px, calc(100vw - 32px));
  }
  /* no tint behind it (no opacity for tone): the dialog's own border sets it apart */
  .timebox::backdrop {
    background: transparent;
  }
  .time-title {
    margin: 0 0 var(--space-3);
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .timebox input {
    width: 100%;
    font: inherit;
    font-size: 16px;
    color: var(--ink);
    background: var(--paper);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-s);
    padding: 8px 10px;
  }
  .timebox input:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }
  .time-actions {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }
  .choice.asking {
    outline: 2px solid var(--on-dark);
    outline-offset: 2px;
  }
</style>
