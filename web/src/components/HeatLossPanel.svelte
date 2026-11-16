<script lang="ts">
  /**
   * The house's heat loss (GET /api/heatloss; engine core/heatloss.ts): watts per °C between inside and out, measured two
   * ways in the dark (Jämn värme: steady hours; Avsvalning: cooling hours with the heaters at rest), one row per era
   * between the events in events.tsv, so a renovation step or insulation shows as a change.
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
  const rooms = $derived((st?.rooms ?? []).map((r) => roomName(r, home.rooms).toLowerCase()).join(' och '));
  let open = $state(false);

  /** The worked example: the newest value of either measure (jämn värme first), compared with the first one */
  const n = (v: number, d = 0) => v.toLocaleString('sv-SE', { maximumFractionDigits: d, minimumFractionDigits: d });
  const values = $derived(
    (st?.eras ?? []).flatMap((e, i) => {
      const when = e.title ? `sedan ${day(e.at)}` : 'från mätningens början';
      const c = st?.cooling?.eras[i];
      if (e.ua !== null) return [{ ua: e.ua, label: `jämn värme, ${when}` }];
      if (c && c.ua !== null) return [{ ua: c.ua, label: `avsvalning, ${when}` }];
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
    {#if st && st.counted}<button class="btn small" onclick={() => (open = !open)} aria-expanded={open}>{open ? 'Dölj mätningarna' : 'Mätningarna'}</button>{/if}
  </header>
  {#if failed && !st}
    <p class="small faint">Motorn svarar inte på /api/heatloss.</p>
  {:else if !st}
    <p class="small faint">Hämtar…</p>
  {:else}
    <p class="small">
      Hur mycket värme {rooms || 'de uppvärmda rummen'} tappar, mätt på två sätt i mörker (ingen sol). Lägre är bättre.
      En rad per tid mellan två händelser; antalet mätningar inom parentes.
    </p>
    <table class="loss">
      <thead><tr><th>Från</th><th title="tretimmarsperioder då rummen höll jämn temperatur">Jämn värme</th><th title="timmar då rummen svalnade med elementen i vila">Avsvalning</th></tr></thead>
      <tbody>
        {#each st.eras as e, i (i)}
          {@const c = st.cooling?.eras[i]}
          <tr>
            <td>{e.at ? day(i === 0 ? e.at.slice(0, 10) : e.at) : '—'}{#if e.title}<span class="title"> · {e.title}</span>{:else if i === 0}<span class="title"> · mätningen börjar</span>{/if}</td>
            <td class="value">{#if e.ua !== null}<b>{e.ua}</b>{#if e.se !== null}<span class="pm"> ±{e.se}</span>{/if}{:else}—{/if}<span class="pm"> ({e.nights})</span></td>
            <td class="value">{#if c && c.ua !== null}<b>{c.ua}</b>{#if c.se !== null}<span class="pm"> ±{c.se}</span>{/if}{:else}—{/if}<span class="pm"> ({c?.hours ?? 0})</span></td>
          </tr>
          {#if open && e.perNight.length}
            <tr class="nights"><td colspan="3">{e.perNight.slice(-14).map((n) => `${day(n.date)} ${n.ua}`).join(' · ')}</td></tr>
          {/if}
        {/each}
      </tbody>
    </table>
    <div class="how">
      <h4>Två sätt att mäta</h4>
      <p>
        <b>Jämn värme:</b> tretimmarsperioder i mörker då rummen höll jämn temperatur och ingen eldade. Då är elen elementen drar lika
        med värmen som läcker ut. Det säkraste måttet, men det kräver att rummen står still, och det gör de sällan när programmet
        låter dem svalna på kvällen och värmer upp dem på natten.
      </p>
      <p>
        <b>Avsvalning:</b> timmar i mörker då elementen vilar och rummen svalnar. Hur fort de svalnar visar hur fort värmen läcker ut,
        räknat med hur mycket värme huset rymmer{#if st.cooling?.capacity}{" "}(ungefär {n(st.cooling.capacity, 1)} kWh per grad){/if}. Det lärs
        in där båda måtten finns och ändras inte av isolering. Fler mätningar med ert schema, men grövre. Timmar efter att rummen värmts
        upp utan el (en brasa) räknas inte.
      </p>
    </div>
    {#if latest && latest.ua !== null}
      {@const ua = latest.ua}
      {@const zero = at(ua, 0)}
      {@const cold = at(ua, -10)}
      <div class="how">
        <h4>Så räknas det</h4>
        <p>
          Båda måtten ger watt per kelvin (W/K); en kelvin är lika stort steg som en grad. Det är hur mycket värme som hela tiden läcker
          ut för varje grad det är varmare inne än ute.
        </p>
        <p>
          Med <b>{ua} W/K</b> ({latest.label}), 18 °C inne och 0 °C ute: {ua} × {zero.diff} = {n(zero.w)} W.
          {#if q}Rummen får {q} W utan el (resten av huset, apparater), så elementen ger {n(zero.w)} − {q} ≈ {n(zero.kw, 2)} kW{:else}Elementen ger {n(zero.kw, 2)} kW{/if}; × 24 timmar ≈ <b>{n(zero.kw * 24)} kWh per dygn</b>.
        </p>
        <p>
          Vid −10 °C ute är skillnaden {cold.diff} grader: {ua} × {cold.diff} = {n(cold.w)} W{#if q}, − {q} W ≈ {n(cold.kw, 2)} kW{:else} ≈ {n(cold.kw, 2)} kW{/if}.
        </p>
        {#if first && first.ua !== latest.ua}
          {@const d = first.ua - ua}
          <p>
            Från {first.ua} W/K ({first.label}) till {ua} W/K är {n(Math.abs(d))} W {d > 0 ? 'mindre' : 'mer'} per grad. Vid 0 °C ute: {n(Math.abs(d))} × 18 = {n(Math.abs(d) * 18)} W,
            ungefär <b>{n((Math.abs(d) * 18 * 24) / 1000, 1)} kWh per dygn {d > 0 ? 'mindre' : 'mer'}</b>.
          </p>
        {/if}
        <p>Måtten beror inte på vädret, så en kall och en mild vecka går att jämföra rakt av. ± är osäkerheten; med få mätningar är den stor.</p>
      </div>
    {/if}
    <p class="note">
      {st.counted} av {st.measured} perioder med jämn värme räknas{#if st.extra}{" "}({st.extra} efter eldning){/if}.
      Eldning syns som att rummets givare för extra värme (&lt;rum&gt;_extra_heat_sensor) är mer än 2 °C varmare än termostaterna, eller att
      rummen blir varmare utan att elementen värmer och utan sol.
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
  .nights td {
    font-family: var(--font-mono);
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
