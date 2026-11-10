<script lang="ts">
  /**
   * Program: the heating planned by price and weather (engine/src/adapters/program.ts, GET /api/program) within the
   * comfort of the week schedule (week.tsv, edited here) or of the mode chosen. What it steers by now, the week
   * schedule to paint, what the coming hours are expected to cost, the plan hour by hour (the same strips as Värme's
   * history), and per room the temperature it is expected to have, what its thermostats will be set to and when, and
   * its learnt heating curve with what the model says in words.
   */
  import { onMount } from 'svelte';
  import Chart from '../components/Chart.svelte';
  import CurveChart from '../components/CurveChart.svelte';
  import HeatStrips from '../components/HeatStrips.svelte';
  import { api, ApiError, type ProgramRoom, type ProgramState } from '../lib/api';
  import { kr } from '../lib/cost';
  import { formatQuantity, timeOnly } from '../lib/format';
  import WeekEditor from '../components/WeekEditor.svelte';
  import { MANUAL, PROGRAM, heatModes, modeName } from '../lib/heat';
  import { MODE_FILLS, inForce, parseWeek, slotOf } from '../lib/week';
  import type { Series } from '../lib/history';
  import { home, sendAction } from '../lib/state.svelte';

  let program = $state<ProgramState | null>(null);
  let error = $state<string | null>(null);
  async function load() {
    try {
      program = await api.program();
      error = null;
    } catch (e) {
      error = e instanceof ApiError && e.status === 404 ? 'Programmet körs inte i motorn.' : (e as Error).message;
    }
  }
  onMount(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  });

  let narrow = $state(false);
  onMount(() => {
    const mq = matchMedia('(max-width: 640px)');
    const set = () => (narrow = mq.matches);
    set();
    mq.addEventListener('change', set);
    return () => mq.removeEventListener('change', set);
  });

  const week = $derived(parseWeek(home.tables?.files?.['week.tsv'] ?? ''));
  const mode = $derived(typeof home.cells['heat_mode']?.value === 'string' ? (home.cells['heat_mode']!.value as string) : null);
  const modes = $derived(heatModes(Object.values(home.cells)));
  let switching = $state(false);
  async function chooseProgram() {
    switching = true;
    await sendAction(`set heat_mode ${PROGRAM}`);
    switching = false;
  }

  const planned = $derived((program?.rooms ?? []).filter((r) => r.plan));
  const planCost = $derived(planned.reduce((s, r) => s + r.plan!.cost, 0));
  const planEnergy = $derived(planned.reduce((s, r) => s + r.plan!.energy, 0));
  /** the cost of the first 24 hours of the plan */
  const dayCost = $derived.by(() => {
    const t0 = planned[0]?.plan?.steps[0]?.t ?? 0;
    return planned.reduce((n, r) => n + r.plan!.steps.filter((s) => s.t < t0 + 86_400_000).reduce((m, s) => m + s.cost, 0), 0);
  });

  // ---- the plan per hour, for the strips: outdoor, price, planned kW and cost per room -------------------------
  const hourly = $derived.by(() => {
    // the quarters ahead with their forecast and price, whether any room is planned or not
    const steps0 = program?.ahead ?? [];
    const hourOf = (t: number) => Math.floor(t / 3_600_000) * 3600;
    const hours = [...new Set(steps0.map((s) => hourOf(s.t)))];
    const mean = (vals: number[]) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
    const inHour = (h: number) => steps0.filter((s) => hourOf(s.t) === h);
    return {
      hours,
      outdoor: hours.map((h) => mean(inHour(h).map((s) => s.tout))),
      price: hours.map((h) => mean(inHour(h).map((s) => s.price))),
      // the modes the plan heats for: the week schedule (also in Manuellt, as the engine plans), or the mode chosen
      modes: hours.map((h) => {
        const s = slotOf(h * 1000);
        const ids = mode !== null && mode !== PROGRAM && mode !== MANUAL ? [mode] : inForce(week, s.day, s.hour);
        return ids.map((id) => {
          const k = modes.findIndex((m) => m.id === id);
          return { name: modes[k]?.name ?? id, fill: MODE_FILLS[Math.max(0, k) % MODE_FILLS.length]! };
        });
      }),
      // each room's target per quarter, from the first hour on
      targets: (program?.rooms ?? [])
        .filter((r) => r.setpoints.length)
        .map((r) => {
          const q: (number | null)[] = Array.from({ length: hours.length * 4 }, () => null);
          for (const p of r.setpoints) {
            const k = Math.round((p.t / 1000 - (hours[0] ?? 0)) / 900);
            if (k >= 0 && k < q.length) q[k] = p.setpoint;
          }
          return { label: r.name, q };
        }),
      sources: planned.map((r) => ({
        label: r.name,
        kw: hours.map((h) => r.plan!.steps.filter((s) => hourOf(s.t) === h).reduce((n, s) => n + s.power * 0.25, 0)),
        sek: hours.map((h) => r.plan!.steps.filter((s) => hourOf(s.t) === h).reduce((n, s) => n + s.cost, 0)),
      })),
    };
  });

  /** The temperature the room is expected to have (end of each quarter), what the thermostats are set to, and the mode's. */
  function temperatureSeries(r: ProgramRoom): Series[] {
    const end = (t: number) => (t + 900_000) / 1000;
    return [
      { label: 'Väntad temperatur', points: r.plan!.steps.map((s) => [end(s.t), s.tend] as [number, number]) },
      { label: 'Termostaten', points: r.setpoints.map((s) => [s.t / 1000, s.setpoint] as [number, number]), stepped: true },
      { label: 'Lägets temperatur', points: r.plan!.steps.map((s) => [s.t / 1000, s.comfort] as [number, number]), stepped: true, dash: true },
    ];
  }

  /** When the thermostats change setpoint in the coming hours: now, then every change (at most a dozen). */
  function changes(r: ProgramRoom): { t: number; setpoint: number }[] {
    const out: { t: number; setpoint: number }[] = [];
    for (const s of r.setpoints) if (!out.length || out[out.length - 1]!.setpoint !== s.setpoint) out.push(s);
    return out.slice(0, 12);
  }
  /** The thermostats of a room by their Swedish names. */
  const heaterNames = (r: ProgramRoom) => r.heaters.map((h) => home.cells[`${h.id}.available`]?.name ?? h.id).join(', ');
  const dayHour = (ms: number, first: boolean) => {
    if (first) return 'nu';
    const d = new Date(ms);
    const today = new Date(program?.at ?? Date.now()).toDateString() === d.toDateString();
    return today ? hhmm(ms) : `${d.toLocaleDateString('sv-SE', { weekday: 'short' })} ${hhmm(ms)}`;
  };

  const num1 = (v: number) => v.toLocaleString('sv-SE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const num2 = (v: number) => v.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  const dayTime = (ms: number) => new Date(ms).toLocaleString('sv-SE', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

  /** The model in words: holding power, how fast the room cools and warms, the sun, how sure. */
  function facts(r: ProgramRoom): string[] {
    const m = r.model!;
    const t = r.curveTemp;
    const kw = (tout: number) => r.curve.find((p) => p.tout === tout)?.kw ?? null;
    const maxKw = r.heaters.reduce((s, h) => s + h.kw, 0);
    const out: string[] = [];
    const k5 = kw(5);
    const km10 = kw(-10);
    if (k5 !== null && km10 !== null) out.push(`Behöver ${num2(k5)} kW vid +5 °C ute och ${num2(km10)} kW vid −10 °C för att hålla ${formatQuantity(t, '°C')}.`);
    // without heat, from t at 0 °C outside, toward the room's own balance (outdoor plus what d keeps)
    const balance = 0 + m.d / m.b;
    if (t - 1 > balance) {
      const h = -Math.log((t - 1 - balance) / (t - balance)) / m.b;
      out.push(`Utan värme sjunker rummet en grad på ungefär ${h < 10 ? num1(h) : Math.round(h)} timmar när det är 0 °C ute.`);
    }
    const rise = m.a * maxKw - m.b * (t - 0) + m.d;
    if (rise > 0) out.push(`Med full värme (${num1(maxKw)} kW) stiger det ${num2(rise)} °C i timmen vid 0 °C ute.`);
    else out.push(`Full värme (${num1(maxKw)} kW) räcker inte för att höja temperaturen vid 0 °C ute.`);
    if (m.c > 0.05) out.push(`Solen ger upp till ${num1(m.c)} °C i timmen en klar dag.`);
    out.push(`Lärt av ${Math.round((m.n * m.stepS) / 3600)} timmar: modellen körs ${m.horizonH} timmar framåt från uppmätt temperatur och missar då i snitt ${num2(m.rmse)} °C.`);
    return out;
  }

  /** The model against the measured temperature over the last two days. */
  function checkSeries(r: ProgramRoom): Series[] {
    const pts = r.check!.points;
    return [
      { label: 'Uppmätt', points: pts.map((p) => [p[0] / 1000, p[1]] as [number, number]) },
      { label: 'Modellen', points: pts.map((p) => [p[0] / 1000, p[2]] as [number, number]), dash: true },
    ];
  }
  const trustedText = (r: ProgramRoom) =>
    r.usable ? 'Inom gränsen: programmet planerar och förvärmer efter modellen.' : 'Utanför gränsen: programmet förvärmer inte, lägenas temperaturer gäller.';

  let learnBusy = $state(false);
  async function learnFrom(date: string | null) {
    learnBusy = true;
    await sendAction(`set program_learn_since ${date ?? 'NULL'}`);
    learnBusy = false;
    setTimeout(() => void load(), 4000);
  }
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const dateOnly = (ms: number) => new Date(ms).toLocaleDateString('sv-SE', { day: 'numeric', month: 'long' });
</script>

<section class="hero" aria-labelledby="h-program">
  <p class="eyebrow" id="h-program">Program</p>
  <h1 class="title">{mode === MANUAL ? 'Styr inte' : 'Styr värmen'}</h1>
  <p class="status">
    {#if mode === PROGRAM}
      Efter veckoschemat nedan: värmer när elen är billig och håller lägenas temperaturer, högst
      {num1(Number(home.cells['program_slack']?.value ?? 1))} °C under när elen är dyr.
    {:else if mode === MANUAL}
      Målen är ändrade för hand (Manuellt). Programmet räknar fram en plan men styr inte förrän du väljer Program eller ett läge.
    {:else}
      Inom läget {modeName(mode, modes)} hela tiden (valt på startsidan): värmer när elen är billig.
    {/if}
  </p>
  {#if mode !== PROGRAM}
    <div class="actions">
      <button class="btn choice chosen" disabled={switching} onclick={chooseProgram}>Följ veckoschemat</button>
    </div>
  {/if}
</section>

<section class="panel"><WeekEditor /></section>

{#if error}
  <div class="state" role="alert">{error}</div>
{:else if !program}
  <div class="state" role="status"><span class="spinner" aria-hidden="true"></span>Hämtar planen…</div>
{:else}
  {#if program.errors.length}
    <div class="state" role="alert">{program.errors.join(' · ')}</div>
  {/if}

  {#if program.ahead.length}
    <section class="panel" aria-labelledby="h-plan">
      <header class="head">
        <h2 id="h-plan">Kommande {Math.round((program.ahead.length * 900_000) / 3_600_000)} timmarna</h2>
        <span class="faint small">planerad {timeOnly(program.at, false)}</span>
      </header>
      {#if !planned.length}
        <p class="aside">Ingen kostnadsprognos: inget rum har en modell som programmet litar på än (se Modellen mot verkligheten nedan). Termostaterna följer lägenas temperaturer.</p>
      {:else}
      <div class="totals">
        <div class="total">
          <span class="label">Kostnad</span>
          <b class="big">{kr(planCost)}</b>
          <span class="sub">varav {kr(dayCost)} närmaste dygnet</span>
        </div>
        <div class="total">
          <span class="label">Energi</span>
          <b class="big">{num1(planEnergy)} kWh</b>
          <span class="sub">{planned.map((r) => `${r.name} ${num1(r.plan!.energy)}`).join(' · ')}</span>
        </div>
        <div class="total">
          <span class="label">Snittpris</span>
          <b class="big">{planEnergy > 0 ? kr(planCost / planEnergy) : '—'}</b>
          <span class="sub">per kWh, med moms och påslag</span>
        </div>
      </div>
      {/if}
      <HeatStrips hours={hourly.hours} outdoor={hourly.outdoor} price={hourly.price} sources={hourly.sources} modes={hourly.modes} targets={hourly.targets} ahead />
      <p class="note">
        Prognos från SMHI{#if program.forecast} ({hhmm(program.forecast.created)}){/if}. Elpriser publicerade till
        {program.pricesUntil ? dayTime(program.pricesUntil) : '—'}; efter det räknas med samma kvart dagen innan.
      </p>
    </section>
  {/if}

  {#each program.rooms as r (r.id)}
    <section class="panel room" aria-labelledby="h-{r.id}">
      <header class="head">
        <h2 id="h-{r.id}">{r.name}</h2>
        {#if r.setpoint !== null}<span class="pill" class:on={mode !== MANUAL}>{mode !== MANUAL ? 'mål nu' : 'skulle ha'} {formatQuantity(r.setpoint, '°C')}</span>{/if}
      </header>
      {#if r.note}<p class="aside">Ingen plan: {r.note}.</p>{/if}
      {#if r.plan}
        <Chart
          since={r.plan.steps[0]!.t / 1000}
          until={(r.plan.steps[r.plan.steps.length - 1]!.t + 900_000) / 1000}
          title="Temperatur"
          unit="°C"
          series={temperatureSeries(r)}
          height={narrow ? 160 : 200}
        />
        <p class="small faint">Väntad kostnad {kr(r.plan.cost)} ({num1(r.plan.energy)} kWh) de kommande {Math.round(r.plan.steps.length / 4)} timmarna.</p>
      {/if}
      {#if r.setpoints.length}
        <div class="sets">
          <h3>{mode === MANUAL ? 'Termostaterna skulle ställas' : 'Termostaterna ställs'}{#if r.heaters.length} <span class="faint">({heaterNames(r)})</span>{/if}</h3>
          <ol>
            {#each changes(r) as c, i (c.t)}
              <li><span class="when">{dayHour(c.t, i === 0)}</span> <b class="value">{formatQuantity(c.setpoint, '°C')}</b></li>
            {/each}
          </ol>
        </div>
      {/if}
      {#if r.check}
        <div class="check">
          <h3>Modellen mot verkligheten</h3>
          <Chart
            since={r.check.points[0]![0] / 1000}
            until={r.check.points[r.check.points.length - 1]![0] / 1000}
            title="Senaste {Math.round((r.check.points[r.check.points.length - 1]![0] - r.check.points[0]![0]) / 3_600_000)} timmarna"
            unit="°C"
            series={checkSeries(r)}
            height={narrow ? 140 : 170}
          />
          <p class="small">
            Modellen körs {r.model?.horizonH ?? 8} timmar i taget från uppmätt temperatur med den värme och det väder som
            var. Senaste veckan tror den att rummet är varmare än det är med i snitt <b class="value">{num2(r.check.overRmse ?? r.check.rmse)} °C</b>
            och som mest <b class="value">{num1(r.check.overMax ?? r.check.max)} °C</b> (gränserna {num1(program.learn.maxError)} och
            {num1(3 * program.learn.maxError)} °C); det är den sidan som kan lämna rummet kallt. Åt båda hållen missar den i snitt
            {num2(r.check.rmse)} °C: när rummet värms fortare än modellen tror börjar programmet bara lite tidigare.
            {#if r.check.extra}{Math.round(r.check.extra / 4)} timmar med extra värme (braskaminen) hoppades över.{/if}
            {trustedText(r)}
          </p>
        </div>
      {/if}
      {#if r.model && r.curve.length}
        <div class="model">
          <CurveChart title="Värmekurva för {formatQuantity(r.curveTemp, '°C')}" curve={r.curve} observed={r.observed} />
          <ul class="facts">
            {#each facts(r) as f, i (i)}<li>{f}</li>{/each}
          </ul>
        </div>
      {/if}
    </section>
  {/each}
  <section class="panel learn" aria-labelledby="h-learn">
    <h2 id="h-learn">Inlärning</h2>
    <p class="small">
      Modellerna lärs om varje timme av historiken sedan {program.learn.from ? dateOnly(program.learn.from) : '—'}{program.learn.since ? ' (lär om från det datumet)' : ', de senaste 28 dygnen'};
      en dag som är {num1(program.learn.halfLifeDays)} dygn gammal väger hälften, så ändringar i huset slår igenom.
      {#if program.fittedAt}Senast {dayTime(program.fittedAt)}.{/if} Planen görs om varje kvart från temperaturen just då.
    </p>
    <p class="small">När huset har ändrats, till exempel efter ett renoveringssteg, kan modellen glömma allt före i dag. Den behöver sedan två dygn innan den planerar igen.</p>
    <div class="learnactions">
      <button class="btn" disabled={learnBusy || program.learn.since === today()} onclick={() => learnFrom(today())}>Lär om från i dag</button>
      {#if program.learn.since}<button class="btn" disabled={learnBusy} onclick={() => learnFrom(null)}>Använd alla 28 dygn</button>{/if}
    </div>
  </section>
{/if}

<style>
  .hero {
    background: var(--surface-ink);
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
  .title {
    font-family: var(--font-display);
    font-weight: 900;
    font-size: clamp(30px, 6vw, 52px);
    line-height: 1;
    text-transform: uppercase;
    margin: var(--space-1) 0 0;
  }
  .status {
    margin: var(--space-2) 0 0;
    font-size: 14px;
    line-height: 1.45;
    max-width: 62ch;
  }
  .actions {
    margin-top: var(--space-4);
  }
  .choice {
    min-height: 40px;
    border-color: var(--on-dark);
    background: var(--surface-ink);
    color: var(--on-dark);
  }
  .choice:hover {
    background: var(--surface-forest);
  }
  .choice.chosen,
  .choice.chosen:hover {
    background: var(--ochre);
    border-color: var(--ochre);
    color: var(--on-ochre);
  }
  .choice:focus-visible {
    outline: 2px solid var(--focus-on-dark);
    outline-offset: 2px;
  }
  .panel {
    background: var(--paper-raised);
    border: 1px solid var(--line);
    border-radius: var(--radius-panel);
    padding: var(--space-4);
    margin-bottom: var(--space-4);
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
  }
  h2 {
    font-family: var(--font-display);
    font-size: 16px;
    line-height: 1.1;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0;
  }
  .totals {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 120px), max-content));
    gap: var(--space-3) var(--space-6);
    margin-bottom: var(--space-4);
  }
  .total {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .total .label {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .total .big {
    font-family: var(--font-mono);
    font-size: 28px;
    font-weight: 400;
    line-height: 1.1;
  }
  .total .sub {
    font-size: 12px;
    color: var(--ink-muted);
  }
  .model {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
    gap: var(--space-4);
    margin-top: var(--space-4);
    padding-top: var(--space-4);
    border-top: 1px solid var(--line);
  }
  .sets {
    margin-top: var(--space-3);
  }
  .sets h3 {
    font-size: 13px;
    font-weight: 600;
    margin: 0 0 var(--space-1);
  }
  .sets ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    font-size: 14px;
  }
  .sets li {
    white-space: nowrap;
  }
  .sets li .value,
  .sets h3 .faint {
    margin-left: 0.35em;
  }
  .when {
    color: var(--ink-muted);
  }
  .check {
    margin-top: var(--space-4);
    padding-top: var(--space-3);
    border-top: 1px solid var(--line);
  }
  .check h3 {
    font-size: 13px;
    font-weight: 600;
    margin: 0 0 var(--space-2);
  }
  .check p {
    margin: var(--space-2) 0 0;
    line-height: 1.5;
    max-width: 70ch;
  }
  .learn h2 {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0 0 var(--space-2);
  }
  .learn p {
    margin: 0 0 var(--space-2);
    line-height: 1.5;
    max-width: 70ch;
  }
  .learnactions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .facts {
    margin: 0;
    padding-left: 1.1em;
    font-size: 14px;
    line-height: 1.5;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .aside {
    margin: 0 0 var(--space-2);
    font-family: var(--font-prose);
    font-style: italic;
    font-size: 14px;
    color: var(--ink-muted);
  }
  .note {
    margin: var(--space-3) 0 0;
    font-size: 12px;
    color: var(--ink-faint);
  }
  .small {
    font-size: 12px;
    line-height: 1.5;
  }
  .state {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--line);
    border-radius: var(--radius-card);
    font-size: 14px;
    color: var(--ink-muted);
    margin-bottom: var(--space-4);
  }
  .spinner {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 3px solid var(--line);
    border-top-color: var(--ochre);
    flex-shrink: 0;
  }
  @media (max-width: 640px) {
    .hero,
    .panel {
      margin-left: calc(-1 * var(--space-2));
      margin-right: calc(-1 * var(--space-2));
      border-radius: var(--radius-card);
    }
    .panel {
      padding: var(--space-4) var(--space-3);
    }
    .total .big {
      font-size: 22px;
    }
  }
</style>
