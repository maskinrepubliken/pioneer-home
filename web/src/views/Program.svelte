<script lang="ts">
  /**
   * Program: the heating planned by price and weather (engine/src/adapters/program.ts, GET /api/program). Whether the
   * program steers (heat_mode program) with the switch to and from it, what the coming hours cost with the program
   * and with the schedule, the plan hour by hour (the same strips as Värme's history), each room's planned
   * temperature against its comfort, and each room's learnt heating curve with what the model says in words.
   */
  import { onMount } from 'svelte';
  import Chart from '../components/Chart.svelte';
  import CurveChart from '../components/CurveChart.svelte';
  import HeatStrips from '../components/HeatStrips.svelte';
  import { api, ApiError, type ProgramRoom, type ProgramState } from '../lib/api';
  import { kr } from '../lib/cost';
  import { formatQuantity, timeOnly } from '../lib/format';
  import { AUTO, MANUAL, MANUAL_NAME, MANUAL_UNTIL_SWITCH, PROGRAM, heatModes } from '../lib/heat';
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

  const mode = $derived(typeof home.cells['heat_mode']?.value === 'string' ? (home.cells['heat_mode']!.value as string) : null);
  const steering = $derived(mode === PROGRAM);
  const modes = $derived(heatModes(Object.values(home.cells)));
  const modeName = (m: string | null) =>
    m === null ? '—' : m === AUTO ? 'Schema' : m === MANUAL || m === MANUAL_UNTIL_SWITCH ? MANUAL_NAME : (modes.find((x) => x.id === m)?.name ?? m);
  let switching = $state(false);
  async function setMode(m: string) {
    switching = true;
    await sendAction(`set heat_mode ${m}`);
    switching = false;
  }

  const planned = $derived((program?.rooms ?? []).filter((r) => r.plan && r.schedule));
  const planCost = $derived(planned.reduce((s, r) => s + r.plan!.cost, 0));
  const scheduleCost = $derived(planned.reduce((s, r) => s + r.schedule!.cost, 0));
  const planEnergy = $derived(planned.reduce((s, r) => s + r.plan!.energy, 0));
  const scheduleEnergy = $derived(planned.reduce((s, r) => s + r.schedule!.energy, 0));
  const horizonEnd = $derived.by(() => {
    const steps = planned[0]?.plan?.steps ?? [];
    return steps.length ? steps[steps.length - 1]!.t + 900_000 : null;
  });

  // ---- the plan per hour, for the strips: outdoor, price, planned kW and cost per room -------------------------
  const hourly = $derived.by(() => {
    const steps0 = planned[0]?.plan?.steps ?? [];
    const hourOf = (t: number) => Math.floor(t / 3_600_000) * 3600;
    const hours = [...new Set(steps0.map((s) => hourOf(s.t)))];
    const mean = (vals: number[]) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
    const inHour = (h: number) => steps0.filter((s) => hourOf(s.t) === h);
    return {
      hours,
      outdoor: hours.map((h) => mean(inHour(h).map((s) => s.tout))),
      price: hours.map((h) => mean(inHour(h).map((s) => s.price))),
      sources: planned.map((r) => ({
        label: r.name,
        kw: hours.map((h) => r.plan!.steps.filter((s) => hourOf(s.t) === h).reduce((n, s) => n + s.power * 0.25, 0)),
        sek: hours.map((h) => r.plan!.steps.filter((s) => hourOf(s.t) === h).reduce((n, s) => n + s.cost, 0)),
      })),
    };
  });

  /** Planned temperature (end of each quarter), the comfort, and the temperature if the schedule were followed. */
  function temperatureSeries(r: ProgramRoom): Series[] {
    const end = (t: number) => (t + 900_000) / 1000;
    return [
      { label: 'Programmet', points: r.plan!.steps.map((s) => [end(s.t), s.tend] as [number, number]) },
      { label: 'Med schemat', points: r.schedule!.steps.map((s) => [end(s.t), s.tend] as [number, number]) },
      { label: 'Komfort', points: r.plan!.steps.map((s) => [s.t / 1000, s.comfort] as [number, number]), stepped: true, dash: true },
      { label: 'Lägst', points: r.plan!.steps.map((s) => [s.t / 1000, s.floor] as [number, number]), stepped: true, dash: true },
    ];
  }

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
    const sure = m.r2 >= 0.15 ? 'god' : 'låg';
    out.push(`Lärt av ${m.n} timmar; säkerheten är ${sure} (förklarar ${Math.round(m.r2 * 100)} % av timförändringarna, givarna visar bara tiondelar).`);
    return out;
  }
</script>

<section class="hero" aria-labelledby="h-program">
  <p class="eyebrow" id="h-program">Program</p>
  <h1 class="title">{steering ? 'Styr värmen' : 'Styr inte'}</h1>
  <p class="status">
    {#if steering}
      Programmet planerar värmen efter elpris och väder och håller schemats komfort, högst {num1(Number(home.cells['program_slack']?.value ?? 1))} °C under när
      elen är dyr. Byt läge på Värme eller här för att ta över.
    {:else}
      Programmet räknar fram en plan men styr inte: läget är {modeName(mode)}.
      {#if mode === MANUAL_UNTIL_SWITCH && home.cells['heat_resume']?.value === PROGRAM}Programmet tar över vid schemats nästa byte.{/if}
    {/if}
  </p>
  <div class="actions">
    {#if steering}
      <button class="btn choice" disabled={switching} onclick={() => setMode(AUTO)}>Tillbaka till Schema</button>
    {:else}
      <button class="btn choice chosen" disabled={switching} onclick={() => setMode(PROGRAM)}>Låt programmet styra</button>
    {/if}
  </div>
</section>

{#if error}
  <div class="state" role="alert">{error}</div>
{:else if !program}
  <div class="state" role="status"><span class="spinner" aria-hidden="true"></span>Hämtar planen…</div>
{:else}
  {#if program.errors.length}
    <div class="state" role="alert">{program.errors.join(' · ')}</div>
  {/if}

  {#if planned.length}
    <section class="panel" aria-labelledby="h-plan">
      <header class="head">
        <h2 id="h-plan">Kommande {horizonEnd ? Math.round((horizonEnd - planned[0]!.plan!.steps[0]!.t) / 3_600_000) : 0} timmarna</h2>
        <span class="faint small">planerad {timeOnly(program.at, false)}</span>
      </header>
      <div class="totals">
        <div class="total">
          <span class="label">Med programmet</span>
          <b class="big">{kr(planCost)}</b>
          <span class="sub">{num1(planEnergy)} kWh</span>
        </div>
        <div class="total">
          <span class="label">Med schemat</span>
          <b class="big">{kr(scheduleCost)}</b>
          <span class="sub">{num1(scheduleEnergy)} kWh</span>
        </div>
        <div class="total">
          <span class="label">Skillnad</span>
          <b class="big">{kr(Math.max(0, scheduleCost - planCost))}</b>
          <span class="sub">{scheduleCost > 0 ? Math.round((1 - planCost / scheduleCost) * 100) : 0} % mindre</span>
        </div>
      </div>
      <HeatStrips hours={hourly.hours} outdoor={hourly.outdoor} price={hourly.price} sources={hourly.sources} ahead />
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
        {#if r.setpoint !== null}<span class="pill" class:on={steering}>{steering ? 'mål nu' : 'skulle ha'} {formatQuantity(r.setpoint, '°C')}</span>{/if}
      </header>
      {#if r.note}<p class="aside">Ingen plan: {r.note}.</p>{/if}
      {#if r.plan && r.schedule}
        <Chart
          since={r.plan.steps[0]!.t / 1000}
          until={(r.plan.steps[r.plan.steps.length - 1]!.t + 900_000) / 1000}
          title="Temperatur"
          unit="°C"
          series={temperatureSeries(r)}
          height={narrow ? 160 : 200}
        />
        <p class="small faint">
          Programmet: {kr(r.plan.cost)}, saknar {num1(r.plan.shortfall)} grad·timmar. Med schemat: {kr(r.schedule.cost)}, saknar {num1(r.schedule.shortfall)}.
        </p>
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
  {#if program.fittedAt}
    <p class="note">Modellerna lärs om var sjätte timme av de senaste 28 dygnen; senast {dayTime(program.fittedAt)}. Planen görs om varje kvart från temperaturen just då.</p>
  {/if}
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
