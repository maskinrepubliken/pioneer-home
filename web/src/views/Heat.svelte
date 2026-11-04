<script lang="ts">
  /**
   * Värme, the landing page: the heating mode (Schema or a mode chosen by hand), every heated room with its
   * temperature, target and heat sources, and the last 48 hours: temperatures, heating demand and what the heat
   * cost. Modes and rooms come from cell naming conventions (lib/heat.ts); history and cost reuse lib/history.ts
   * and lib/cost.ts, limited to thermostats.
   */
  import { onMount } from 'svelte';
  import Chart from '../components/Chart.svelte';
  import CostBars from '../components/CostBars.svelte';
  import { api, ApiError, type PriceSlot } from '../lib/api';
  import { computeCosts, costPerBucket, isUnreachable, kr, type CostResult } from '../lib/cost';
  import { formatQuantity, roomName, timeOnly } from '../lib/format';
  import { AUTO, cellNotes, heatModes, heatRooms, heatState } from '../lib/heat';
  import { dutySeries, isPulsing, meanSeries, namesFromTables, roomOfLocation, seriesBy, sourceId, sourceName, type Rec, type Series } from '../lib/history';
  import { buildLive } from '../lib/live';
  import { home, sendAction } from '../lib/state.svelte';

  // ---- now ------------------------------------------------------------------------------------------------------
  const cells = $derived(Object.values(home.cells));
  const kinds = $derived(Object.fromEntries((home.tables?.devices ?? []).map((d) => [d.id, d.kind])) as Record<string, string>);
  const layout = $derived(buildLive(cells, kinds, home.rooms));
  const modes = $derived(heatModes(cells));
  const heat = $derived(heatState(home.cells));
  const rooms = $derived(heatRooms(layout, home.cells, home.rooms, modes));
  const notes = $derived(cellNotes(home.tables?.files ?? {}));
  const modeName = (id: string | null) => (id === null ? '—' : (modes.find((m) => m.id === id)?.name ?? id));
  const manual = $derived(heat.mode !== null && heat.mode !== AUTO);

  let choosing = $state<string | null>(null);
  async function choose(id: string) {
    if (choosing || id === heat.mode) return;
    choosing = id;
    await sendAction(`set heat_mode ${id}`);
    choosing = null;
  }

  /** Room target stepper: ±0.5, rapid taps sent as one `set <room>_target 19.5` (as VarRow does). */
  let pending = $state<Record<string, number>>({});
  const timers: Record<string, ReturnType<typeof setTimeout>> = {};
  function step(id: string, current: number | null, delta: number) {
    const v = Math.round(((pending[id] ?? current ?? 20) + delta) * 2) / 2;
    pending = { ...pending, [id]: v };
    clearTimeout(timers[id]);
    timers[id] = setTimeout(async () => {
      await sendAction(`set ${id} ${v}`);
      const { [id]: _, ...rest } = pending;
      pending = rest;
    }, 600);
  }
  const deg = (n: number | null) => (n === null ? '—' : formatQuantity(Math.round(n * 10) / 10, '°C'));

  /** Phones get shorter charts. */
  let narrow = $state(false);
  onMount(() => {
    const mq = matchMedia('(max-width: 640px)');
    const set = () => (narrow = mq.matches);
    set();
    mq.addEventListener('change', set);
    return () => mq.removeEventListener('change', set);
  });

  // ---- the last 48 hours ------------------------------------------------------------------------------------------
  const HOURS = 48;
  const BUCKET = 900;
  let loading = $state(true);
  let error = $state<string | null>(null);
  let climate = $state<Rec[]>([]);
  let heating = $state<Rec[]>([]);
  let weather = $state<Rec[]>([]);
  let slots = $state<PriceSlot[]>([]);
  let span = $state({ since: 0, until: 0 });
  let loadedAt = $state<number | null>(null);
  let token = 0;

  async function load() {
    const mine = ++token;
    loading = loadedAt === null;
    // whole hours, so the cost bars line up with the clock
    const until = new Date();
    const since = new Date(Math.floor(until.getTime() / 3_600_000) * 3_600_000 - (HOURS - 1) * 3_600_000);
    try {
      const [c, h, w, p] = await Promise.all([
        api.history('climate', since, until),
        api.history('heating', since, until),
        api.history('weather', since, until).catch(() => ({ items: [] })),
        api.prices(since, until).catch(() => null),
      ]);
      if (mine !== token) return;
      climate = Array.isArray(c.items) ? c.items : [];
      heating = Array.isArray(h.items) ? h.items : [];
      weather = Array.isArray(w.items) ? w.items : [];
      slots = p?.slots ?? [];
      span = { since: since.getTime() / 1000, until: until.getTime() / 1000 };
      error = null;
      loadedAt = Date.now();
    } catch (e) {
      if (mine !== token) return;
      const status = e instanceof ApiError ? e.status : 0;
      error = status === 404 || status >= 500 || status === 0 ? 'Historiken går inte att nå just nu.' : (e as Error).message;
    }
    loading = false;
  }

  onMount(() => {
    void load();
    const t = setInterval(() => void load(), 5 * 60_000);
    return () => clearInterval(t);
  });

  const names = $derived(namesFromTables(home.tables?.files ?? {}));
  const label = (key: string) => sourceName(names, key);
  const heatedRooms = $derived(new Set(rooms.map((r) => r.id)));
  const roomOfHeater = (r: Rec) => names.deviceRoom[sourceId(names, String(r['sensor'] ?? ''))] ?? null;
  const roomTitle = (id: string) => roomName(id, home.rooms);

  /** Per heated room: the mean of its climate sensors, else of its thermostats' own readings; plus its target. */
  const temperatures = $derived.by((): Series[] => {
    const lines: Series[] = [];
    const targets: Series[] = [];
    for (const r of rooms) {
      const c = climate.filter((x: Rec) => typeof x['location'] === 'string' && roomOfLocation(names, x['location'], String(x['sensor'] ?? '')) === r.id);
      const h = heating.filter((x: Rec) => roomOfHeater(x) === r.id);
      const sources = c.length ? seriesBy(c, 'sensor', 'temperature', label) : seriesBy(h, 'sensor', 'current', label);
      const mean = meanSeries(sources, BUCKET, r.title);
      if (mean) lines.push({ ...mean, colorKey: r.title });
      const target = seriesBy(h, 'sensor', 'target', () => `Mål ${r.title}`, { stepped: true, dash: true, colorKey: () => r.title })[0];
      if (target) targets.push(target);
    }
    const outdoor = seriesBy(weather, 'collectionName', 'temperature', () => 'Utomhus', { dash: true });
    // the chart draws five series: rooms and outdoors first, targets while there is room
    return [...lines, ...outdoor, ...targets].slice(0, 5);
  });

  /** Heating demand per heat source; a pulsing on/off heater as its share of each quarter. */
  const demand = $derived(
    seriesBy(
      heating.filter((x: Rec) => heatedRooms.has(roomOfHeater(x) ?? '')),
      'sensor',
      'pi',
      (k) => {
        const room = names.deviceRoom[sourceId(names, k)];
        return room ? `${label(k)} · ${roomTitle(room)}` : label(k);
      },
      { stepped: true },
    ).map((s) => (isPulsing(s.points) ? { ...s, label: `${s.label} *`, points: dutySeries(s.points, BUCKET, span.since, span.until) } : s)),
  );

  const cellNumber = (id: string, fallback: number) => {
    const v = home.cells[id]?.value;
    return typeof v === 'number' ? v : fallback;
  };
  const skip = (id: string) => isUnreachable(home.cells, names, id, Date.now());
  const costs = $derived.by((): CostResult[] => {
    if (span.until <= span.since) return [];
    return computeCosts({
      heating: heating.filter((x: Rec) => heatedRooms.has(roomOfHeater(x) ?? '')),
      power: [],
      names,
      pricing: { slots, vat: cellNumber('electricity_vat', 1.25), surcharge: cellNumber('electricity_surcharge', 0) },
      since: span.since,
      until: span.until,
      skip,
      roomLabel: roomTitle,
    });
  });
  const totalSek = $derived(costs.reduce((n, c) => n + c.sek, 0));
  const totalKwh = $derived(costs.reduce((n, c) => n + c.kwh, 0));
  const hours = $derived(Array.from({ length: HOURS }, (_, i) => span.since + i * 3600));
  const bars = $derived(costs.map((c) => ({ label: c.label, values: costPerBucket(c, hours.map((h) => [h, h + 3600] as [number, number])) })));
  const hourLabels = $derived(hours.map((h) => String(new Date(h * 1000).getHours()).padStart(2, '0')));
  const lastDay = $derived.by(() => {
    const from = span.until - 86_400;
    return costs.reduce((n, c) => n + costPerBucket(c, [[from, span.until]])[0]!, 0);
  });
</script>

<section class="hero" aria-labelledby="h-mode">
  <div class="hero-top">
    <p class="eyebrow" id="h-mode">Värmeläge</p>
    <h1 class="mode">{modeName(heat.active)}</h1>
    <p class="status" aria-live="polite">
      {#if !home.loaded}
        laddar…
      {:else if heat.mode === null}
        Inga värmelägen i tabellerna än (heat_mode i Celler).
      {:else if manual}
        Valt för hand. Gäller tills du väljer Schema.
      {:else}
        Följer schemat{#if notes['heat_sched_now']}: {notes['heat_sched_now']}{/if}.
      {/if}
    </p>
  </div>
  {#if heat.mode !== null}
    <div class="choices" role="radiogroup" aria-label="Välj värmeläge">
      {#each [{ id: AUTO, name: 'Schema', inUse: false }, ...modes] as m (m.id)}
        {@const chosen = heat.mode === m.id}
        <button
          class="choice"
          class:chosen
          role="radio"
          aria-checked={chosen}
          disabled={choosing !== null}
          onclick={() => choose(m.id)}
        >
          <span class="hole" class:filled={m.id === AUTO ? !manual : m.inUse} aria-hidden="true"></span>
          <span class="cname">{m.name}</span>
          {#if chosen}<span class="tag">vald</span>{/if}
        </button>
      {/each}
    </div>
    {#if !manual && modes.filter((m) => m.inUse).length > 1}
      <p class="overlap">Övergång: {modes.filter((m) => m.inUse).map((m) => m.name).join(' och ')} räknas båda just nu, varje rum får det varmaste.</p>
    {/if}
  {/if}
</section>

<div class="rooms">
  {#each rooms as r (r.id)}
    {@const heatingNow = r.heaters.some((h) => h.heating === true)}
    {@const targetId = r.target?.id ?? null}
    {@const target = typeof r.target?.value === 'number' ? r.target.value : null}
    {@const shown = targetId ? (pending[targetId] ?? target) : null}
    <section class="room card" aria-labelledby="h-{r.id}">
      <header>
        <h2 id="h-{r.id}">{r.title}</h2>
        {#if r.heaters.length}
          <span class="pill" class:on={heatingNow}>{heatingNow ? 'värmer' : 'vilar'}</span>
        {:else}
          <span class="pill neutral">ingen termostat</span>
        {/if}
      </header>
      <div class="now">
        <b class="temp value" title={r.sources.join(', ')}>{deg(r.temperature)}</b>
        {#if targetId}
          <span class="stepper" role="group" aria-label="Måltemperatur i {r.title}">
            <button class="btn small" onclick={() => step(targetId, target, -0.5)} aria-label="Sänk målet i {r.title}">−</button>
            <span class="sp"><span class="lbl">mål</span><b class="value" class:pending={targetId in pending} aria-live="polite">{deg(shown)}</b></span>
            <button class="btn small" onclick={() => step(targetId, target, 0.5)} aria-label="Höj målet i {r.title}">+</button>
          </span>
        {:else if r.plan !== null}
          <span class="plan-only"><span class="lbl">plan</span> <b class="value">{deg(r.plan)}</b></span>
        {/if}
      </div>
      {#if targetId && r.plan !== null && target !== null && r.plan !== target}
        <p class="aside">Planen säger {deg(r.plan)} från nästa byte.</p>
      {/if}

      <ol class="modes" aria-label="Rummets temperatur per läge">
        {#each modes as m (m.id)}
          <li class:inuse={m.inUse}>
            <span class="hole" class:filled={m.inUse} aria-hidden="true"></span>
            <span class="mname">{m.name}</span>
            <b class="value">{r.modeTemps[m.id] === null ? '—' : `${formatQuantity(r.modeTemps[m.id]!)}°`}</b>
            {#if m.inUse}<span class="sr">(räknas nu)</span>{/if}
          </li>
        {/each}
      </ol>

      {#if r.heaters.length}
        <ul class="heaters">
          {#each r.heaters as h (h.id)}
            <li>
              <span class="hname">{h.name}</span>
              <span class="value">
                {#if h.offline}nås inte{:else if h.heating === true}värmer{#if h.demand !== null && h.demand > 0}&nbsp;{Math.round(h.demand)}&nbsp;%{/if}{:else if h.heating === false}vilar{:else}—{/if}{#if h.setpoint !== null && !h.offline}&nbsp;· {deg(h.setpoint)}{/if}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/each}
</div>

<section class="panel recent" aria-labelledby="h-48">
  <header class="recent-head">
    <h2 id="h-48">Senaste 48 timmarna</h2>
    <span class="faint small">{#if loadedAt}uppdaterad {timeOnly(loadedAt, false)}{/if}</span>
  </header>
  {#if loading}
    <div class="state" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span>Hämtar historik och elpriser…</div>
  {:else if error}
    <div class="state" role="alert">{error}</div>
  {:else}
    <div class="totals">
      <div class="total">
        <span class="label">Värmen har kostat</span>
        <b class="big">{kr(totalSek)}</b>
        <span class="sub">{formatQuantity(Math.round(totalKwh * 10) / 10, 'kWh')} på 48 timmar</span>
      </div>
      <div class="total">
        <span class="label">Senaste dygnet</span>
        <b class="big">{kr(lastDay)}</b>
        <span class="sub">de senaste 24 timmarna</span>
      </div>
    </div>
    {#if bars.length}
      <CostBars labels={['timme']} series={bars} buckets={hourLabels} tickEvery={6} />
    {/if}
    <div class="charts">
      {#if temperatures.length}
        <Chart since={span.since} until={span.until} title="Temperatur" unit="°C" series={temperatures} height={narrow ? 170 : 220} />
      {/if}
      {#if demand.length}
        <Chart
          since={span.since}
          until={span.until}
          title="Värmebehov"
          unit="%"
          series={demand}
          min={0}
          max={100}
          height={narrow ? 140 : 180}
          note={demand.some((s) => s.label.endsWith(' *')) ? '* Slår av och på i korta pulser; kurvan visar hur stor del av varje kvart den värmer.' : undefined}
        />
      {/if}
    </div>
    <p class="note">Kostnaden är en uppskattning: effekt × värmebehov × spotpris med moms och påslag, som under Kostnader.</p>
  {/if}
</section>

<style>
  /* The mode block: a forest surface, the one big poster line of the page. Compact: this page lives on a phone. */
  .hero {
    background: var(--surface-forest);
    color: var(--on-dark);
    border-radius: var(--radius-panel);
    padding: var(--space-5);
    margin-bottom: var(--space-4);
  }
  .hero-top {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: var(--space-4);
  }
  .eyebrow {
    flex-basis: 100%;
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
    margin: var(--space-1) 0 0;
    font-size: 14px;
    line-height: 1.45;
    max-width: 60ch;
  }
  .choices {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
    gap: var(--space-1);
    margin-top: var(--space-4);
    max-width: 560px;
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
  .tag {
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  /* A punch-card hole: filled = counts now, empty = not. */
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
  .hero .hole.filled {
    background: var(--ochre);
    border-color: var(--ochre);
  }
  .hero .choice.chosen .hole.filled {
    background: var(--on-ochre);
    border-color: var(--on-ochre);
  }
  .overlap {
    margin: var(--space-2) 0 0;
    font-size: 13px;
    line-height: 1.45;
  }

  .rooms {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
    gap: var(--space-3);
    margin-bottom: var(--space-4);
    align-items: start;
  }
  .room {
    padding: var(--space-4);
    min-width: 0;
  }
  .room header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .room h2,
  .recent h2 {
    font-family: var(--font-display);
    font-size: 16px;
    line-height: 1.1;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0;
  }
  /* Temperature left, the target stepper right, on one line. */
  .now {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    margin: var(--space-2) 0;
  }
  .temp {
    font-family: var(--font-mono);
    font-size: 34px;
    line-height: 1;
    font-weight: 400;
  }
  .stepper,
  .plan-only {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .lbl {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .stepper .btn {
    min-width: 36px;
    min-height: 36px;
    padding: 0;
    font-size: 18px;
  }
  .sp {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 7ch;
    line-height: 1.2;
  }
  .sp .value {
    font-size: 16px;
  }
  .sp .pending {
    text-decoration: underline dotted;
  }
  .aside {
    margin: 0 0 var(--space-2);
    font-family: var(--font-prose);
    font-style: italic;
    font-size: 13px;
    line-height: 1.4;
    color: var(--ink-muted);
  }
  /* The room's temperature per mode: one row of small chips, the modes that count now with a filled hole. */
  .modes {
    list-style: none;
    margin: 0;
    padding: var(--space-2) 0 0;
    border-top: 1px solid var(--line);
    display: flex;
    gap: var(--space-1);
  }
  .modes li {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 4px 6px;
    border: 1px solid var(--line);
    border-radius: var(--radius-pill);
    font-size: 13px;
    white-space: nowrap;
  }
  .modes li.inuse {
    border: 2px solid var(--surface-forest);
    padding: 3px 5px;
  }
  .modes .mname {
    color: var(--ink-muted);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .modes .hole {
    color: var(--surface-forest);
  }
  .modes .value {
    font-size: 13px;
  }
  .heaters {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 13px;
    line-height: 1.4;
  }
  .heaters li {
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .heaters .hname {
    color: var(--ink-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .heaters .value {
    font-size: 13px;
    white-space: nowrap;
  }

  .panel {
    background: var(--paper-raised);
    border: 1px solid var(--line);
    border-radius: var(--radius-panel);
    padding: var(--space-4);
    min-width: 0;
  }
  .recent-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
  }
  .totals {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), max-content));
    gap: var(--space-3) var(--space-6);
    margin-bottom: var(--space-4);
  }
  .total {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
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
    line-height: 1.4;
    color: var(--ink-muted);
  }
  .charts {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    margin-top: var(--space-5);
  }
  .note {
    margin: var(--space-4) 0 0;
    font-size: 12px;
    color: var(--ink-faint);
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
  }
  .spinner {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 3px solid var(--line);
    border-top-color: var(--ochre);
    flex-shrink: 0;
  }
  .small {
    font-size: 12px;
    line-height: 1.5;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
  /* Phones: the hero and the panels run to the screen edge minus a small gutter, everything one size down. */
  @media (max-width: 640px) {
    .hero,
    .room,
    .panel {
      margin-left: calc(-1 * var(--space-2));
      margin-right: calc(-1 * var(--space-2));
    }
    .hero {
      padding: var(--space-4);
      border-radius: var(--radius-card);
    }
    .room {
      padding: var(--space-3) var(--space-4);
    }
    .panel {
      padding: var(--space-4) var(--space-3);
      border-radius: var(--radius-card);
    }
    .tag {
      display: none;
    }
    .choice {
      font-size: 14px;
      gap: 5px;
      padding: 6px 4px;
    }
    .temp {
      font-size: 28px;
    }
    .stepper {
      gap: var(--space-1);
    }
    .modes li {
      font-size: 12px;
      gap: 4px;
    }
    .total .big {
      font-size: 24px;
    }
  }
</style>
