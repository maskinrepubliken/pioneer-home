<script lang="ts">
  /**
   * The house's heat loss (GET /api/heatloss; engine core/heatloss.ts): watts per °C between inside and out, measured two
   * ways in the dark (Jämn värme: steady hours; Avsvalning: cooling hours with the heaters at rest), one row per era
   * between the events in events.tsv, so a renovation step or insulation shows as a change.
   * The engine measures as the days pass; this only shows it. Lower is better; under each value the kWh a day at 0 °C
   * outside and 18 °C inside.
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
  const rooms = $derived((st?.rooms ?? []).map((r) => roomName(r, home.rooms).toLowerCase()).join(' och '));
  /** kWh a day at 0 °C outside and 18 °C inside, with the free heat taken off */
  const perDay = (ua: number) => Math.max(0, Math.round(((ua * 18 - (st?.freeHeat ?? 0)) * 24) / 100) / 10);

  /** The worked example: the newest value of either measure (jämn värme first), compared with the first one */
  const n = (v: number, d = 0) => v.toLocaleString('sv-SE', { maximumFractionDigits: d, minimumFractionDigits: d });
  const values = $derived(
    (st?.eras ?? []).flatMap((e, i) => {
      const when = e.title ? `sedan ${day(e.at)}` : 'från mätningens början';
      const c = st?.cooling?.eras[i];
      if (e.ua !== null) return [{ ua: e.ua, label: `jämn värme ${when}` }];
      if (c && c.ua !== null) return [{ ua: c.ua, label: `avsvalningen ${when}` }];
      return [];
    }),
  );
  const latest = $derived(values[values.length - 1] ?? null);
  const first = $derived(values.length > 1 ? values[0]! : null);
  const q = $derived(st?.freeHeat ?? 0);
  const at = (ua: number, out: number) => {
    const w = ua * (18 - out);
    return { diff: 18 - out, w, kw: Math.max(0, w - q) / 1000 };
  };
</script>

<section class="panel" aria-labelledby="h-heatloss">
  <header class="head">
    <h3 id="h-heatloss">Energieffektivitet</h3>
  </header>
  {#if failed && !st}
    <p class="small faint">Motorn svarar inte på /api/heatloss.</p>
  {:else if !st}
    <p class="small faint">Hämtar…</p>
  {:else}
    <p class="small">
      Hur mycket värme {rooms || 'de uppvärmda rummen'} tappar, mätt på två sätt när det är mörkt ute. Lägre är bättre. Varje rad
      gäller tiden mellan två händelser. Under värdet står vad värmen drar per dygn vid 0 °C ute och 18 °C inne, och hur många
      mätningar värdet bygger på.
    </p>
    <table class="loss">
      <thead><tr><th>Från</th><th title="det mer exakta måttet">Jämn värme</th><th>Avsvalning</th></tr></thead>
      <tbody>
        {#each st.eras as e, i (i)}
          {@const c = st.cooling?.eras[i]}
          <tr>
            <td>{e.at ? day(i === 0 ? e.at.slice(0, 10) : e.at) : '—'}{#if e.title}<span class="title"> · {e.title}</span>{:else if i === 0}<span class="title"> · mätningen börjar</span>{/if}</td>
            <td class="value">{#if e.ua !== null}<b>{e.ua}</b>{#if e.se !== null}<span class="pm"> ±{e.se}</span>{/if}{:else}—{/if}{#if e.ua !== null}<span class="kwh">{n(perDay(e.ua), 1)} kWh/dygn</span>{/if}<span class="kwh">{e.nights} st</span></td>
            <td class="value">{#if c && c.ua !== null}<b>{c.ua}</b>{#if c.se !== null}<span class="pm"> ±{c.se}</span>{/if}{:else}—{/if}{#if c && c.ua !== null}<span class="kwh">{n(perDay(c.ua), 1)} kWh/dygn</span>{/if}<span class="kwh">{c?.hours ?? 0} st</span></td>
          </tr>
        {/each}
      </tbody>
    </table>
    <div class="how">
      <h4>Två sätt att mäta</h4>
      <p>
        <b>Jämn värme är det mer exakta måttet.</b> Det använder tretimmarsperioder i mörker då rummen höll jämn temperatur och ingen
        eldade. Då drar elementen precis lika mycket el som det läcker ut värme. Rummen står dock sällan still, eftersom programmet
        låter dem svalna på kvällen och värmer upp dem på natten, så det tar tid att samla mätningar.
      </p>
      <p>
        <b>Avsvalning är grövre men ger fler mätningar.</b> Det använder timmar i mörker då elementen vilar och rummen svalnar. Hur fort
        de svalnar visar hur fort värmen läcker ut, när man vet hur mycket värme huset rymmer.{#if st.cooling?.capacity}{" "}Huset rymmer ungefär
        {n(st.cooling.capacity, 1)} kWh per grad.{/if} Det lärs in där båda måtten finns, och isolering ändrar det inte. Timmar efter att rummen
        blivit varmare utan el, alltså en brasa, räknas inte.
      </p>
    </div>
    {#if latest && latest.ua !== null}
      {@const ua = latest.ua}
      {@const zero = at(ua, 0)}
      {@const cold = at(ua, -10)}
      <div class="how">
        <h4>Så räknas det</h4>
        <p>
          Båda måtten räknas i watt per kelvin, W/K. En kelvin är lika stort steg som en grad, så måttet anger hur många watt som hela
          tiden läcker ut för varje grad det är varmare inne än ute.
        </p>
        <p>
          Det senaste värdet är <b>{ua} W/K</b> från {latest.label}. Vid 18 °C inne och 0 °C ute blir det {ua} × {zero.diff} = {n(zero.w)} W.
          {#if q}Rummen får {q} W gratis från resten av huset och apparater, så elementen behöver ge {n(zero.w)} − {q} ≈ {n(zero.kw, 2)} kW.{:else}Elementen behöver ge {n(zero.kw, 2)} kW.{/if}
          Över ett dygn blir det ungefär <b>{n(zero.kw * 24)} kWh</b>.
        </p>
        <p>
          Vid −10 °C ute är skillnaden {cold.diff} grader: {ua} × {cold.diff} = {n(cold.w)} W{#if q}, minus {q} W blir {n(cold.kw, 2)} kW{:else}, alltså {n(cold.kw, 2)} kW{/if}.
        </p>
        {#if first && first.ua !== latest.ua}
          {@const d = first.ua - ua}
          <p>
            Vid mätningens början var värdet {first.ua} W/K. Det är {n(Math.abs(d))} W {d > 0 ? 'mindre' : 'mer'} per grad nu. Vid 0 °C ute blir det
            {n(Math.abs(d))} × 18 = {n(Math.abs(d) * 18)} W, ungefär <b>{n((Math.abs(d) * 18 * 24) / 1000, 1)} kWh per dygn {d > 0 ? 'mindre' : 'mer'}</b>.
          </p>
        {/if}
        <p>Måtten beror inte på vädret, så en kall och en mild vecka går att jämföra rakt av. Talet efter ± är osäkerheten, som är stor när mätningarna är få.</p>
      </div>
    {/if}
    <p class="note">
      {st.counted} av {st.measured} perioder med jämn värme räknas{#if st.extra}, {st.extra} föll bort på grund av eldning{/if}. Eldning syns
      som att rummets givare för extra värme är mer än 2 °C varmare än termostaterna, eller att rummen blir varmare utan att elementen
      värmer och utan sol.
      {#if st.freeHeat === null}Värdena kommer när minst fem perioder med jämn värme är mätta.{/if}
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
  .kwh {
    display: block;
    font-size: 12px;
    color: var(--ink-muted);
  }
  .how {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    font-size: 14px;
    line-height: 1.5;
    padding-top: var(--space-3);
    border-top: 1px solid var(--line);
  }
  .how h4 {
    font-size: 13px;
    font-weight: 600;
    margin: 0;
  }
  .how p {
    margin: 0;
    max-width: 62ch;
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
