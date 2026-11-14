<script lang="ts">
  /**
   * The house's heat loss (GET /api/heatloss; engine core/heatloss.ts): watts per °C between inside and out, from quiet
   * nights, one row per era between the events in events.tsv, so a renovation step or insulation shows as a change.
   * The engine measures each night as it passes; this only shows it. Lower is better. Under Nätterna each night's own
   * value, the newest last.
   */
  import { onMount } from 'svelte';
  import { api, type HeatLossState } from '../lib/api';
  import { roomName } from '../lib/format';
  import { home } from '../lib/state.svelte';

  let st = $state<HeatLossState | null>(null);
  let failed = $state(false);
  onMount(() => {
    const load = () =>
      void api
        .heatLoss()
        .then((s) => ((st = s), (failed = false)))
        .catch(() => (failed = true));
    load();
    const t = setInterval(load, 15 * 60_000);
    return () => clearInterval(t);
  });

  const day = (s: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}:\d{2}))?$/.exec(s);
    if (!m) return s;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return `${d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' })}${m[4] ? ` ${m[4]}` : ''}`;
  };
  /** kWh a day at 0 °C outside and 18 °C inside, with the free heat taken off */
  const perDay = (ua: number) => Math.max(0, Math.round(((ua * 18 - (st?.freeHeat ?? 0)) * 24) / 100) / 10);
  const rooms = $derived((st?.rooms ?? []).map((r) => roomName(r, home.rooms).toLowerCase()).join(' och '));
  let open = $state(false);
</script>

<section class="panel" aria-labelledby="h-heatloss">
  <header class="head">
    <h3 id="h-heatloss">Värmeförlust</h3>
    {#if st && st.counted}<button class="btn small" onclick={() => (open = !open)} aria-expanded={open}>{open ? 'Dölj nätterna' : 'Nätterna'}</button>{/if}
  </header>
  {#if failed && !st}
    <p class="small faint">Motorn svarar inte på /api/heatloss.</p>
  {:else if !st}
    <p class="small faint">Hämtar…</p>
  {:else}
    <p class="small">
      Watt per grad mellan inne och ute i {rooms || 'de uppvärmda rummen'}, mätt stilla nätter {st.window.from}–{st.window.to} utan eldning.
      Lägre är bättre. En rad per tid mellan två händelser.
    </p>
    <table class="loss">
      <thead><tr><th>Från</th><th>Nätter</th><th>W/K</th><th title="vid 0 °C ute och 18 °C inne">kWh/dygn</th></tr></thead>
      <tbody>
        {#each st.eras as e, i (i)}
          <tr>
            <td>{e.at ? day(e.at) : '—'}{#if e.title}<span class="title"> · {e.title}</span>{:else if i === 0}<span class="title"> · mätningen börjar</span>{/if}</td>
            <td class="value">{e.nights}</td>
            <td class="value">{#if e.ua !== null}<b>{e.ua}</b>{#if e.se !== null}<span class="pm"> ±{e.se}</span>{/if}{:else}—{/if}</td>
            <td class="value">{e.ua !== null ? perDay(e.ua) : '—'}</td>
          </tr>
          {#if open && e.perNight.length}
            <tr class="nights"><td colspan="4">{e.perNight.slice(-14).map((n) => `${day(n.date)} ${n.ua}`).join(' · ')}</td></tr>
          {/if}
        {/each}
      </tbody>
    </table>
    <p class="note">
      {st.counted} av {st.measured} nätter räknas{#if st.extra}{" "}({st.extra} med eldning och {st.unsteady} då rummen svalnade eller värmdes){/if}.
      {#if st.freeHeat !== null}Rummen får också ungefär {st.freeHeat} W utan el (resten av huset, apparater); det räknas in, annars ser milda nätter bättre ut än kalla.{:else}Värdena kommer när minst fem stilla nätter är mätta.{/if}
      kWh/dygn: vad värmen skulle dra vid 0 °C ute och 18 °C inne. ± är osäkerheten; med få nätter är den stor.
    </p>
    {#if st.errors.length}<p class="small errors">{st.errors.join(' · ')}</p>{/if}
  {/if}
</section>

<style>
  .panel {
    background: var(--paper-raised);
    border: 1px solid var(--line);
    border-radius: var(--radius-panel);
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-top: var(--space-5);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  h3 {
    font-size: 14px;
    font-weight: 600;
    margin: 0;
  }
  .small {
    font-size: 13px;
    line-height: 1.5;
    margin: 0;
  }
  .loss {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  }
  .loss th {
    text-align: left;
    font-family: var(--font-display);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink-muted);
    padding: 0 var(--space-2) var(--space-2) 0;
    border-bottom: 1px solid var(--line);
  }
  .loss th:not(:first-child),
  .loss td.value {
    text-align: right;
    white-space: nowrap;
  }
  .loss td {
    padding: var(--space-2) var(--space-2) var(--space-2) 0;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }
  .title,
  .pm {
    color: var(--ink-muted);
  }
  .pm {
    font-size: 12px;
  }
  .nights td {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--ink-muted);
  }
  .note {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--ink-faint);
  }
  .errors {
    color: var(--alarm);
  }
</style>
