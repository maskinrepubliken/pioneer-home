<script lang="ts">
  /**
   * Värme, the landing page: the heating mode (Schema, a mode chosen by hand, or Manuellt), every room on one line
   * (the heated ones first, with their target), and the last 48 hours: outdoor temperature, heating power, price and
   * cost hour by hour (components/HeatStrips.svelte), and the room temperatures. Modes and rooms come from cell naming conventions (lib/heat.ts); history and cost reuse lib/history.ts
   * and lib/cost.ts, limited to thermostats.
   */
  import { onMount } from 'svelte';
  import Chart from '../components/Chart.svelte';
  import HeatStrips from '../components/HeatStrips.svelte';
  import { api, ApiError, type PriceSlot } from '../lib/api';
  import { applianceOrder, computeCosts, costPerBucket, isUnreachable, kr, kwhPerBucket, pricePerBucket, type CostResult } from '../lib/cost';
  import { formatQuantity, roomName, timeOnly } from '../lib/format';
  import { heatRooms, targetActions } from '../lib/heat';
  import ModePicker from '../components/ModePicker.svelte';
  import { meanSeries, namesFromTables, roomOfLocation, seriesBy, sourceId, sourceName, ts, num, type Rec, type Series } from '../lib/history';
  import { buildLive, excludedReadings } from '../lib/live';
  import { home, sendAction } from '../lib/state.svelte';

  // ---- now ------------------------------------------------------------------------------------------------------
  const cells = $derived(Object.values(home.cells));
  const kinds = $derived(Object.fromEntries((home.tables?.devices ?? []).map((d) => [d.id, d.kind])) as Record<string, string>);
  const layout = $derived(buildLive(cells, kinds, home.rooms));
  const rooms = $derived(heatRooms(layout, home.cells, home.rooms));
  const heated = $derived(rooms.filter((r) => r.heated));


  /** Room target stepper: ±0.5, rapid taps sent as one `set <room>_target 19.5` (as VarRow does), after `set heat_mode manual`. */
  let pending = $state<Record<string, number>>({});
  const timers: Record<string, ReturnType<typeof setTimeout>> = {};
  function step(id: string, current: number | null, delta: number) {
    const v = Math.round(((pending[id] ?? current ?? 20) + delta) * 2) / 2;
    pending = { ...pending, [id]: v };
    clearTimeout(timers[id]);
    timers[id] = setTimeout(async () => {
      // the heating mode becomes Manuellt first, so the schedule leaves the new target alone
      for (const a of targetActions(id, v, home.cells)) await sendAction(a);
      const { [id]: _, ...rest } = pending;
      pending = rest;
    }, 600);
  }
  const deg = (n: number | null) => (n === null ? '—' : formatQuantity(Math.round(n * 10) / 10, '°C'));
  /** Short form for the room list: 19.5° */
  const short = (n: number | null) => (n === null ? '—' : `${(Math.round(n * 10) / 10).toFixed(1)}°`);

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
  const heatedRooms = $derived(new Set(heated.map((r) => r.id)));
  const roomOfHeater = (r: Rec) => names.deviceRoom[sourceId(names, String(r['sensor'] ?? ''))] ?? null;
  const roomTitle = (id: string) => roomName(id, home.rooms);
  const excluded = $derived(excludedReadings(home.cells));

  /** Per heated room: the mean of its climate sensors, else of its thermostats' own readings; plus its target. */
  const temperatures = $derived.by((): Series[] => {
    const lines: Series[] = [];
    const targets: Series[] = [];
    for (const r of heated) {
      const c = climate.filter(
        (x: Rec) =>
          typeof x['location'] === 'string' &&
          roomOfLocation(names, x['location'], String(x['sensor'] ?? '')) === r.id &&
          !excluded.has(`${sourceId(names, String(x['sensor'] ?? ''))}.temperature`),
      );
      const h = heating.filter((x: Rec) => roomOfHeater(x) === r.id);
      const sources = c.length ? seriesBy(c, 'sensor', 'temperature', label) : seriesBy(h, 'sensor', 'current', label);
      const mean = meanSeries(sources, BUCKET, r.title);
      if (mean) lines.push({ ...mean, colorKey: r.title });
      const target = seriesBy(h, 'sensor', 'target', () => `Mål ${r.title}`, { stepped: true, dash: true, colorKey: () => r.title })[0];
      if (target) targets.push(target);
    }
    // the chart draws five series: rooms first, targets while there is room
    return [...lines, ...targets].slice(0, 5);
  });

  const cellNumber = (id: string, fallback: number) => {
    const v = home.cells[id]?.value;
    return typeof v === 'number' ? v : fallback;
  };
  const skip = (id: string) => isUnreachable(home.cells, names, id, Date.now());
  const pricing = $derived({ slots, vat: cellNumber('electricity_vat', 1.25), surcharge: cellNumber('electricity_surcharge', 0) });
  const costs = $derived.by((): CostResult[] => {
    if (span.until <= span.since) return [];
    return computeCosts({
      heating: heating.filter((x: Rec) => heatedRooms.has(roomOfHeater(x) ?? '')),
      power: [],
      names,
      pricing,
      since: span.since,
      until: span.until,
      skip,
      roomLabel: roomTitle,
    });
  });
  const totalSek = $derived(costs.reduce((n, c) => n + c.sek, 0));
  const totalKwh = $derived(costs.reduce((n, c) => n + c.kwh, 0));
  const hours = $derived(Array.from({ length: HOURS }, (_, i) => span.since + i * 3600));
  const buckets = $derived(hours.map((h) => [h, h + 3600] as [number, number]));
  const sources = $derived(costs.map((c) => ({ label: c.label, kw: kwhPerBucket(c, buckets), sek: costPerBucket(c, buckets) })));
  const hourlyPrice = $derived(pricePerBucket(pricing, buckets));
  /** A value per hour: the mean of the rows in it, else the last one before (rows are written on change and as heartbeats). */
  function hourly(items: Rec[], field: string): (number | null)[] {
    const rows = items
      .map((r: Rec) => [ts(r), num(r, field)] as const)
      .filter((p): p is readonly [number, number] => p[0] !== null && p[1] !== null)
      .sort((a, b) => a[0] - b[0]);
    let last: number | null = null;
    let k = 0;
    return buckets.map(([a, b]) => {
      const inside: number[] = [];
      while (k < rows.length && rows[k]![0] < b) {
        if (rows[k]![0] >= a) inside.push(rows[k]![1]);
        else last = rows[k]![1];
        k++;
      }
      if (inside.length) last = inside.reduce((n, v) => n + v, 0) / inside.length;
      return last;
    });
  }
  const hourlyOutdoor = $derived(hourly(weather, 'temperature'));
  /** Daylight: the illuminance of the sensor named by the setting daylight_sensor (one that sees only the sky). */
  const daylightSensor = $derived(typeof home.cells['daylight_sensor']?.value === 'string' ? (home.cells['daylight_sensor']?.value as string) : '');
  const hourlySun = $derived(daylightSensor ? hourly(climate.filter((r: Rec) => sourceId(names, String(r['sensor'] ?? '')) === daylightSensor), 'illuminance') : []);
  const lastDay = $derived.by(() => {
    const from = span.until - 86_400;
    return costs.reduce((n, c) => n + costPerBucket(c, [[from, span.until]])[0]!, 0);
  });
</script>

<ModePicker />

<section class="panel roomlist" aria-label="Rummen">
  {#snippet row(r: (typeof rooms)[number])}
    {@const heatingNow = r.heaters.some((h) => h.heating === true)}
    {@const demand = Math.max(0, ...r.heaters.map((h) => (h.heating === true ? (h.demand ?? 0) : 0)))}
    {@const targetId = r.target?.id ?? null}
    {@const target = typeof r.target?.value === 'number' ? r.target.value : null}
    {@const shown = targetId ? (pending[targetId] ?? target) : null}
    <li class="row">
      <div class="who">
        <span class="rname">{r.title}</span>
        <span class="sub" title={r.heaters.map((h) => `${h.name}: ${h.offline ? 'nås inte' : h.heating ? 'värmer' : 'vilar'}`).join(', ')}>
          {#if r.heated && r.heaters.length}
            <span class="hole" class:filled={heatingNow} aria-hidden="true"></span>
            {#if r.heaters.every((h) => h.offline)}nås inte{:else if heatingNow}värmer{#if demand > 0}&nbsp;{Math.round(demand)}&nbsp;%{/if}{:else}vilar{/if}
          {:else if r.heated}
            ingen termostat{#if r.plan !== null}&nbsp;· plan {short(r.plan)}{/if}
          {:else if r.humidity !== null}
            {formatQuantity(Math.round(r.humidity), '%')} fukt
          {/if}
        </span>
      </div>
      <b class="temp value" title={r.sources.join(', ')}>{short(r.temperature)}</b>
      {#if targetId}
        <span class="stepper" role="group" aria-label="Måltemperatur i {r.title}">
          <button class="btn small" onclick={() => step(targetId, target, -0.5)} aria-label="Sänk målet i {r.title}">−</button>
          <span class="sp"><span class="lbl">mål</span><b class="value" class:pending={targetId in pending} aria-live="polite">{short(shown)}</b></span>
          <button class="btn small" onclick={() => step(targetId, target, 0.5)} aria-label="Höj målet i {r.title}">+</button>
        </span>
      {:else}
        <span></span>
      {/if}
    </li>
  {/snippet}
  <ul class="rows">
    {#each rooms as r (r.id)}{@render row(r)}{/each}
  </ul>
</section>

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
    {#if sources.length}
      <HeatStrips {hours} outdoor={hourlyOutdoor} sun={hourlySun} price={hourlyPrice} {sources} order={applianceOrder(names, roomTitle)} />
    {/if}
    {#if temperatures.length}
      <div class="charts">
        <Chart since={span.since} until={span.until} title="Temperatur i rummen" unit="°C" series={temperatures} height={narrow ? 160 : 200} />
      </div>
    {/if}
    <p class="note">Värme och kostnad är uppskattningar: effekt × värmebehov, och den energin × elpriset (spotpris med moms och påslag), som under Kostnader.</p>
  {/if}
</section>

<style>
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

  /* The rooms: one line each, temperature and target in columns, so they line up and a phone shows them all. */
  .roomlist {
    margin-bottom: var(--space-4);
    padding-top: var(--space-2);
    padding-bottom: var(--space-2);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto 132px;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    min-height: 52px;
  }
  .row + .row {
    border-top: 1px solid var(--line);
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .rname {
    font-family: var(--font-ui);
    font-weight: 600;
    font-size: 15px;
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0 5px;
    font-size: 12px;
    line-height: 1.4;
    color: var(--ink-muted);
  }
  .sub .hole {
    width: 8px;
    height: 8px;
    color: var(--surface-forest);
  }
  .temp {
    font-family: var(--font-mono);
    font-size: 22px;
    line-height: 1;
    font-weight: 400;
    text-align: right;
  }
  .stepper {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-1);
  }
  .lbl {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .stepper .btn {
    min-width: 34px;
    min-height: 34px;
    padding: 0;
    font-size: 18px;
  }
  .sp {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 6ch;
    line-height: 1.15;
  }
  .sp .value {
    font-size: 15px;
  }
  .sp .pending {
    text-decoration: underline dotted;
  }

  .panel {
    background: var(--paper-raised);
    border: 1px solid var(--line);
    border-radius: var(--radius-panel);
    padding: var(--space-4);
    min-width: 0;
  }
  .recent h2 {
    font-family: var(--font-display);
    font-size: 16px;
    line-height: 1.1;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0;
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
  /* Phones: the hero and the panels run to the screen edge minus a small gutter, everything one size down. */
  @media (max-width: 640px) {
    .panel {
      margin-left: calc(-1 * var(--space-2));
      margin-right: calc(-1 * var(--space-2));
    }
    .panel {
      padding: var(--space-4) var(--space-3);
      border-radius: var(--radius-card);
    }
    .roomlist {
      padding-top: var(--space-1);
      padding-bottom: var(--space-1);
    }
    .row {
      grid-template-columns: minmax(0, 1fr) auto 116px;
      gap: var(--space-2);
      min-height: 48px;
    }
    .rname {
      font-size: 14px;
    }
    .temp {
      font-size: 19px;
    }
    .stepper .btn {
      min-width: 32px;
      min-height: 32px;
    }
    .sp {
      min-width: 5.5ch;
    }
    .sp .value {
      font-size: 14px;
    }
    .total .big {
      font-size: 24px;
    }
  }
</style>
