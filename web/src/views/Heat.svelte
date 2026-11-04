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
  import VarRow from '../components/live/VarRow.svelte';
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
    {@const target = typeof r.target?.value === 'number' ? r.target.value : null}
    <section class="room card" aria-labelledby="h-{r.id}">
      <header>
        <h2 id="h-{r.id}">{r.title}</h2>
        {#if r.heaters.length}
          <span class="pill" class:on={heatingNow}>{heatingNow ? 'värmer' : 'vilar'}</span>
        {/if}
      </header>
      <div class="now">
        <b class="temp value">{r.temperature === null ? '—' : formatQuantity(Math.round(r.temperature * 10) / 10, '°C')}</b>
        <span class="faint small">
          {#if r.humidity !== null}{formatQuantity(Math.round(r.humidity), '%')} fukt · {/if}{r.sources.length ? r.sources.join(', ') : 'ingen givare'}
        </span>
      </div>

      {#if r.target}
        <ul class="target"><VarRow cell={r.target} /></ul>
        {#if r.plan !== null && target !== null && r.plan !== target}
          <p class="aside">Planen säger {formatQuantity(r.plan, '°C')}; måltemperaturen följer med vid nästa byte.</p>
        {/if}
      {:else if r.plan !== null}
        <p class="aside">Planerat {formatQuantity(r.plan, '°C')}. Ingen termostat i rummet än.</p>
      {/if}

      <ol class="modes" aria-label="Rummets temperatur per läge">
        {#each modes as m (m.id)}
          <li class:inuse={m.inUse}>
            <span class="hole" class:filled={m.inUse} aria-hidden="true"></span>
            <span class="mname">{m.name}</span>
            <b class="value">{r.modeTemps[m.id] === null ? '—' : formatQuantity(r.modeTemps[m.id]!, '°C')}</b>
            {#if m.inUse}<span class="sr">(räknas nu)</span>{/if}
          </li>
        {/each}
      </ol>

      {#if r.heaters.length}
        <ul class="heaters">
          {#each r.heaters as h (h.id)}
            <li>
              <span>{h.name}</span>
              <span class="value small">
                {#if h.offline}nås inte{:else if h.heating === true}värmer{#if h.demand !== null && h.demand > 0} {Math.round(h.demand)} %{/if}{:else if h.heating === false}vilar{:else}—{/if}
                {#if h.setpoint !== null && !h.offline} · mål {formatQuantity(h.setpoint, '°C')}{/if}
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
        <span class="sub">{costs.length ? costs.map((c) => `${c.label} ${kr(c.sek)}`).join(' · ') : 'ingen värmekälla med effekt'}</span>
      </div>
    </div>
    {#if bars.length}
      <CostBars labels={['timme']} series={bars} buckets={hourLabels} tickEvery={6} />
    {/if}
    <div class="charts">
      {#if temperatures.length}
        <Chart since={span.since} until={span.until} title="Temperatur" unit="°C" series={temperatures} height={240} />
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
          note={demand.some((s) => s.label.endsWith(' *')) ? '* Slår av och på i korta pulser; kurvan visar hur stor del av varje kvart den värmer.' : undefined}
        />
      {/if}
    </div>
    <p class="note">Kostnaden är en uppskattning: effekt × värmebehov × spotpris med moms och påslag, som under Kostnader.</p>
  {/if}
</section>

<style>
  /* The mode block: a forest surface, the one big poster line of the page. */
  .hero {
    background: var(--surface-forest);
    color: var(--on-dark);
    border-radius: var(--radius-panel);
    padding: var(--space-6) var(--space-6) var(--space-5);
    margin-bottom: var(--space-5);
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
    font-size: clamp(44px, 9vw, 84px);
    line-height: 0.95;
    letter-spacing: -0.01em;
    text-transform: uppercase;
    margin: var(--space-2) 0 var(--space-3);
  }
  .status {
    margin: 0;
    font-size: 16px;
    line-height: 1.5;
    max-width: 60ch;
  }
  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-5);
  }
  .choice {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 44px;
    padding: 8px 20px 8px 14px;
    border-radius: var(--radius-pill);
    border: 1px solid var(--on-dark);
    background: var(--surface-forest);
    color: var(--on-dark);
    font-family: var(--font-ui);
    font-size: 17px;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
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
    font-size: 11px;
    font-weight: 400;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  /* A punch-card hole: filled = counts now, empty = not. */
  .hole {
    width: 12px;
    height: 12px;
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
    margin: var(--space-3) 0 0;
    font-size: 14px;
    line-height: 1.5;
  }

  .rooms {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
    gap: var(--space-5);
    margin-bottom: var(--space-5);
    align-items: start;
  }
  .room {
    padding: var(--space-5);
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
    font-size: 20px;
    line-height: 1.1;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0;
  }
  .now {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin: var(--space-4) 0 var(--space-3);
  }
  .temp {
    font-family: var(--font-mono);
    font-size: 44px;
    line-height: 1;
    font-weight: 400;
  }
  .target {
    list-style: none;
    margin: 0;
    padding: var(--space-2) 0;
    border-top: 1px solid var(--line);
  }
  .aside {
    margin: 0 0 var(--space-2);
    font-family: var(--font-prose);
    font-style: italic;
    font-size: 14px;
    line-height: 1.5;
    color: var(--ink-muted);
  }
  .modes {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: var(--space-3) 0 0;
    border-top: 1px solid var(--line);
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
    gap: var(--space-2);
  }
  .modes li {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    column-gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
  }
  .modes li.inuse {
    border: 2px solid var(--surface-forest);
    padding: calc(var(--space-2) - 1px) calc(var(--space-3) - 1px);
  }
  .modes .mname {
    font-size: 13px;
    color: var(--ink-muted);
  }
  .modes .hole {
    color: var(--surface-forest);
  }
  .modes .value {
    grid-column: 1 / -1;
    font-size: 15px;
  }
  .heaters {
    list-style: none;
    margin: var(--space-3) 0 0;
    padding: var(--space-3) 0 0;
    border-top: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: 14px;
  }
  .heaters li {
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .panel {
    background: var(--paper-raised);
    border: 1px solid var(--line);
    border-radius: var(--radius-panel);
    padding: var(--space-5);
    min-width: 0;
  }
  .recent-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }
  .totals {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-6);
    margin-bottom: var(--space-5);
  }
  .total {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .total .label {
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .total .big {
    font-family: var(--font-mono);
    font-size: 36px;
    font-weight: 400;
    line-height: 1.1;
  }
  .total .sub {
    font-size: 13px;
    color: var(--ink-muted);
  }
  .charts {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    margin-top: var(--space-6);
  }
  .note {
    margin: var(--space-5) 0 0;
    font-size: 13px;
    color: var(--ink-faint);
  }
  .state {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-5);
    border: 1px solid var(--line);
    border-radius: var(--radius-card);
    font-size: 15px;
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
    font-size: 13px;
    line-height: 1.5;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
  @media (max-width: 640px) {
    .hero {
      padding: var(--space-5) var(--space-4) var(--space-4);
    }
    .choice {
      flex: 1 1 40%;
      justify-content: center;
    }
  }
</style>
