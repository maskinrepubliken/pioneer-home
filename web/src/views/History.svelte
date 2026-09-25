<script lang="ts">
  /** Charts over PocketBase history via /api/history/:collection. */
  import Chart, { type Series } from '../components/Chart.svelte';
  import { api, ApiError } from '../lib/api';
  import { timeOnly } from '../lib/format';

  type Range = '24h' | '7d' | '30d';
  const RANGES: { id: Range; label: string; ms: number }[] = [
    { id: '24h', label: '24 h', ms: 86_400_000 },
    { id: '7d', label: '7 d', ms: 7 * 86_400_000 },
    { id: '30d', label: '30 d', ms: 30 * 86_400_000 },
  ];
  let range = $state<Range>('24h');

  type Rec = Record<string, unknown>;
  interface Loaded {
    items: Rec[];
    error: string | null;
  }
  const empty = (): Loaded => ({ items: [], error: null });
  let climate = $state<Loaded>(empty());
  let heating = $state<Loaded>(empty());
  let power = $state<Loaded>(empty());
  let weather = $state<Loaded>(empty());
  let loading = $state(false);
  let loadedAt = $state<number | null>(null);

  async function fetchOne(collection: string, since: Date, until: Date): Promise<Loaded> {
    try {
      const res = await api.history(collection, since, until);
      return { items: Array.isArray(res.items) ? res.items : [], error: null };
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      const msg = status === 404 || status >= 500 || status === 0 ? 'Historik inte tillgänglig ännu' : (e as Error).message;
      return { items: [], error: msg };
    }
  }

  async function load() {
    loading = true;
    const until = new Date();
    const since = new Date(until.getTime() - (RANGES.find((r) => r.id === range)?.ms ?? 86_400_000));
    const [c, h, p, w] = await Promise.all(['climate', 'heating', 'power', 'weather'].map((col) => fetchOne(col, since, until)));
    climate = c!;
    heating = h!;
    power = p!;
    weather = w!;
    loading = false;
    loadedAt = Date.now();
  }

  $effect(() => {
    void range;
    void load();
  });

  const ts = (r: Rec): number | null => {
    const w = r['when'];
    if (typeof w !== 'string') return null;
    const ms = Date.parse(w);
    return Number.isNaN(ms) ? null : ms / 1000;
  };
  const num = (r: Rec, f: string): number | null => {
    const v = r[f];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };

  /** One series per distinct value of `by`, y = field (scaled), skipping nulls. */
  function seriesBy(items: Rec[], by: string, field: string, scale = 1, stepped = false): Series[] {
    const groups = new Map<string, [number, number][]>();
    for (const r of items) {
      const t = ts(r);
      const v = num(r, field);
      if (t === null || v === null) continue;
      const key = String(r[by] ?? '?');
      let pts = groups.get(key);
      if (!pts) groups.set(key, (pts = []));
      pts.push([t, v * scale]);
    }
    return [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], 'sv'))
      .map(([label, points]) => ({ label, points: points.sort((a, b) => a[0] - b[0]), stepped }));
  }

  const tempSeries = $derived(seriesBy(climate.items, 'location', 'temperature'));
  const humSeries = $derived(seriesBy(climate.items, 'location', 'humidity', 100));
  const luxSeries = $derived(seriesBy(climate.items, 'location', 'illuminance'));
  const demandSeries = $derived(seriesBy(heating.items, 'sensor', 'pi', 1, true));
  const floorSeries = $derived([
    ...seriesBy(heating.items, 'sensor', 'current').map((s) => ({ ...s, label: `${s.label} aktuell` })),
    ...seriesBy(heating.items, 'sensor', 'target', 1, true).map((s) => ({ ...s, label: `${s.label} mål` })),
  ]);
  const powerSeries = $derived(seriesBy(power.items, 'name', 'powerlevel', 1, true));
  const weatherSeries = $derived.by((): Series[] => {
    const pts: [number, number][] = [];
    for (const r of weather.items) {
      const t = ts(r);
      const v = num(r, 'temperature');
      if (t !== null && v !== null) pts.push([t, v]);
    }
    return pts.length ? [{ label: 'Utomhus', points: pts.sort((a, b) => a[0] - b[0]) }] : [];
  });
</script>

<div class="toolbar">
  <div class="tabs inline" role="tablist">
    {#each RANGES as r (r.id)}
      <button role="tab" class:active={range === r.id} aria-selected={range === r.id} onclick={() => (range = r.id)}>{r.label}</button>
    {/each}
  </div>
  <span class="spacer"></span>
  <span class="muted small">
    {#if loading}laddar…{:else if loadedAt}uppdaterad {timeOnly(loadedAt)}{/if}
  </span>
  <button class="btn small" disabled={loading} onclick={() => load()}>Uppdatera</button>
</div>

<div class="charts">
  <section>
    <h2 class="group">Klimat</h2>
    {#if climate.error}
      <div class="card msg muted">{climate.error}</div>
    {:else}
      <Chart title="Temperatur" unit="°C" series={tempSeries} />
      <Chart title="Luftfuktighet" unit="%" series={humSeries} min={0} max={100} />
      <Chart title="Ljus" unit="lx" series={luxSeries} min={0} />
    {/if}
  </section>

  <section>
    <h2 class="group">Värme</h2>
    {#if heating.error}
      <div class="card msg muted">{heating.error}</div>
    {:else}
      <Chart title="Golvvärme: effektbehov" unit="%" series={demandSeries} min={0} max={100} />
      <Chart title="Golvvärme: temperatur och mål" unit="°C" series={floorSeries} />
    {/if}
  </section>

  <section>
    <h2 class="group">Effekt</h2>
    {#if power.error}
      <div class="card msg muted">{power.error}</div>
    {:else}
      <Chart title="Effekt: fläktnivå, luftfuktare och automatik" unit="%" series={powerSeries} min={0} max={100} />
    {/if}
  </section>

  <section>
    <h2 class="group">Väder</h2>
    {#if weather.error}
      <div class="card msg muted">{weather.error}</div>
    {:else}
      <Chart title="Utomhustemperatur" unit="°C" series={weatherSeries} />
    {/if}
  </section>
</div>

<style>
  .charts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 480px), 1fr));
    gap: 0 var(--space-6);
  }
  section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  /* "bildtext": the not-available message. */
  .msg {
    padding: var(--space-5);
    text-align: center;
    font-family: var(--font-prose);
    font-style: italic;
    font-size: 15px;
    line-height: 1.55;
    color: var(--ink-muted);
  }
  /* Range picker: a segmented capsule; the chosen segment is ink on paper, plus its word. */
  .tabs.inline {
    border-bottom: none;
    margin-bottom: 0;
    background: var(--paper);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-pill);
    padding: 2px;
    gap: 2px;
  }
  .tabs.inline button {
    border-bottom: none;
    border-radius: var(--radius-pill);
    padding: 3px 12px;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    color: var(--ink);
  }
  .tabs.inline button:hover {
    background: var(--paper-hover);
  }
  .tabs.inline button.active,
  .tabs.inline button.active:hover {
    background: var(--ink);
    color: var(--paper);
  }
  .small {
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
  }
</style>
