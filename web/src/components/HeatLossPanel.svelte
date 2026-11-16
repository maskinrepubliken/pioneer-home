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

  /** The worked example: the newest era with a value, compared with the first one */
  const n = (v: number, d = 0) => v.toLocaleString('sv-SE', { maximumFractionDigits: d, minimumFractionDigits: d });
  const valued = $derived((st?.eras ?? []).filter((e) => e.ua !== null));
  const latest = $derived(valued[valued.length - 1] ?? null);
  const first = $derived(valued.length > 1 ? valued[0]! : null);
  const q = $derived(st?.freeHeat ?? 0);
  const at = (ua: number, out: number) => {
    const w = ua * (18 - out);
    return { diff: 18 - out, w, kw: Math.max(0, w - q) / 1000 };
  };
</script>

<section class="panel" aria-labelledby="h-heatloss">
  <header class="head">
    <h3 id="h-heatloss">Värmeförlust</h3>
    {#if st && st.counted}<button class="btn small" onclick={() => (open = !open)} aria-expanded={open}>{open ? 'Dölj mätningarna' : 'Mätningarna'}</button>{/if}
  </header>
  {#if failed && !st}
    <p class="small faint">Motorn svarar inte på /api/heatloss.</p>
  {:else if !st}
    <p class="small faint">Hämtar…</p>
  {:else}
    <p class="small">
      Watt per grad mellan inne och ute i {rooms || 'de uppvärmda rummen'}, mätt i mörker (kväll, natt, tidig morgon) under tretimmarsperioder då rummen höll jämn temperatur och ingen eldade.
      Lägre är bättre. En rad per tid mellan två händelser.
    </p>
    <table class="loss">
      <thead><tr><th>Från</th><th title="tretimmarsperioder i mörker">Antal</th><th>W/K</th><th class="kwh" title="vid 0 °C ute och 18 °C inne">kWh/dygn</th><th title="alla stilla nätter, även med eldning">Med eld</th></tr></thead>
      <tbody>
        {#each st.eras as e, i (i)}
          <tr>
            <td>{e.at ? day(e.at) : '—'}{#if e.title}<span class="title"> · {e.title}</span>{:else if i === 0}<span class="title"> · mätningen börjar</span>{/if}</td>
            <td class="value">{e.nights}</td>
            <td class="value">{#if e.ua !== null}<b>{e.ua}</b>{#if e.se !== null}<span class="pm"> ±{e.se}</span>{/if}{:else}—{/if}</td>
            <td class="value kwh">{e.ua !== null ? perDay(e.ua) : '—'}</td>
            <td class="value loose">{#if st.loose?.eras[i]?.ua != null}{st.loose.eras[i]!.ua}<span class="pm"> ({st.loose.eras[i]!.nights})</span>{:else}—{/if}</td>
          </tr>
          {#if open && e.perNight.length}
            <tr class="nights"><td colspan="5">{e.perNight.slice(-14).map((n) => `${day(n.date)} ${n.ua}`).join(' · ')}</td></tr>
          {/if}
        {/each}
      </tbody>
    </table>
    {#if latest && latest.ua !== null}
      {@const ua = latest.ua}
      {@const zero = at(ua, 0)}
      {@const cold = at(ua, -10)}
      <div class="how">
        <h4>Så räknas det</h4>
        <p>
          W/K betyder watt per kelvin; en kelvin är lika stort steg som en grad. Det är hur mycket värme som hela tiden läcker ut för
          varje grad det är varmare inne än ute.
        </p>
        <p>
          Med <b>{ua} W/K</b> ({latest.title ? `sedan ${day(latest.at)}` : 'hela mätningen'}), 18 °C inne och 0 °C ute: {ua} × {zero.diff} = {n(zero.w)} W.
          {#if q}Rummen får {q} W utan el, så elementen ger {n(zero.w)} − {q} ≈ {n(zero.kw, 2)} kW{:else}Elementen ger {n(zero.kw, 2)} kW{/if}; × 24 timmar ≈ <b>{n(zero.kw * 24)} kWh per dygn</b>.
        </p>
        <p>
          Vid −10 °C ute är skillnaden {cold.diff} grader: {ua} × {cold.diff} = {n(cold.w)} W{#if q}, − {q} W ≈ {n(cold.kw, 2)} kW{:else} ≈ {n(cold.kw, 2)} kW{/if}.
        </p>
        {#if first && first.ua !== null && first.ua !== ua}
          {@const d = first.ua - ua}
          <p>
            Från {first.ua} till {ua} W/K är {n(Math.abs(d))} W {d > 0 ? 'mindre' : 'mer'} per grad. Vid 0 °C ute: {n(Math.abs(d))} × 18 = {n(Math.abs(d) * 18)} W,
            ungefär <b>{n((Math.abs(d) * 18 * 24) / 1000, 1)} kWh per dygn {d > 0 ? 'mindre' : 'mer'}</b>.
          </p>
        {/if}
        <p>Måttet beror inte på vädret, så en kall och en mild vecka går att jämföra rakt av.</p>
      </div>
    {/if}
    <p class="note">
      {st.counted} av {st.measured} stilla perioder räknas{#if st.extra}{" "}({st.extra} efter eldning){/if}.
      {#if st.freeHeat !== null}Rummen får också ungefär {st.freeHeat} W utan el (resten av huset, apparater); det räknas in, annars ser milda nätter bättre ut än kalla.{:else}Värdena kommer när minst fem stilla perioder är mätta.{/if}
      kWh/dygn: vad värmen skulle dra vid 0 °C ute och 18 °C inne. ± är osäkerheten; med få nätter är den stor.
      Eldning syns som att rummets givare för extra värme (&lt;rum&gt;_extra_heat_sensor) är mer än 2 °C varmare än termostaterna, eller att rummen blir varmare utan att elementen
      värmer och utan sol. Med eld: samma mått med alla stilla perioder, även dem efter eldning (antal inom parentes); fler
      men grövre, eftersom värmen från brasan får huset att se bättre ut än det är. Timmar då programmet värmer upp eller
      låter rummen svalna räknas inte i något av måtten: då lagras eller släpps värme i väggarna.
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
  .loose {
    color: var(--ink-muted);
  }
  /* a phone: kWh/dygn is worked out under Så räknas det */
  @media (max-width: 480px) {
    .kwh {
      display: none;
    }
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
