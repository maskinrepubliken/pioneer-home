<script lang="ts">
  /**
   * History from PocketBase (/api/history/:collection), arranged like Live: first the temperature of every room
   * side by side (the room's mean over its sources, plus outdoors), then one panel per room with each source on
   * its own line, and last the appliances (levels as a curve, on/off as a timeline). Names come from the tables
   * (see lib/history.ts), so a sensor's history is labelled with its Swedish device name.
   */
  import Chart from '../components/Chart.svelte';
  import OnOffChart from '../components/OnOffChart.svelte';
  import { api, ApiError } from '../lib/api';
  import { roomName, timeOnly } from '../lib/format';
  import { dutySeries, isPulsing, meanSeries, namesFromTables, roomOfLocation, seriesBy, sourceId, sourceName, ts, type Rec, type Series } from '../lib/history';
  import { home } from '../lib/state.svelte';

  type Range = '24h' | '7d' | '30d';
  const RANGES: { id: Range; label: string; ms: number; bucket: number }[] = [
    { id: '24h', label: '24 h', ms: 86_400_000, bucket: 900 },
    { id: '7d', label: '7 d', ms: 7 * 86_400_000, bucket: 3600 },
    { id: '30d', label: '30 d', ms: 30 * 86_400_000, bucket: 4 * 3600 },
  ];
  let range = $state<Range>('24h');
  const current = $derived(RANGES.find((r) => r.id === range)!);

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
  let span = $state<{ since: number; until: number }>({ since: 0, until: 0 });

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

  const POWER_LOOKBACK_MS = 31 * 86_400_000;
  /** A token per request: a slow answer for an earlier interval never replaces a newer one. */
  let token = 0;
  async function load() {
    const mine = ++token;
    loading = true;
    const until = new Date();
    const since = new Date(until.getTime() - current.ms);
    // power rows are written only when an appliance switches: fetch further back so the state at the start is known
    const lookback = new Date(since.getTime() - POWER_LOOKBACK_MS);
    const [c, h, p, w] = await Promise.all(['climate', 'heating', 'power', 'weather'].map((col) => fetchOne(col, col === 'power' ? lookback : since, until)));
    if (mine !== token) return;
    climate = c!;
    heating = h!;
    power = p!;
    weather = w!;
    span = { since: since.getTime() / 1000, until: until.getTime() / 1000 };
    loading = false;
    loadedAt = Date.now();
  }

  $effect(() => {
    void range;
    void load();
  });

  const names = $derived(namesFromTables(home.tables?.files ?? {}));
  const label = (key: string) => sourceName(names, key);

  /** Rows of a collection grouped by room id: climate by its `location`, heating by its thermostat's room. */
  function byRoom(items: Rec[], room: (r: Rec) => string | null): Map<string, Rec[]> {
    const out = new Map<string, Rec[]>();
    for (const r of items) {
      const k = room(r);
      if (!k) continue;
      let list = out.get(k);
      if (!list) out.set(k, (list = []));
      list.push(r);
    }
    return out;
  }
  const climateByRoom = $derived(byRoom(climate.items, (r) => (typeof r['location'] === 'string' ? roomOfLocation(names, r['location'], String(r['sensor'] ?? '')) : null)));
  const heatingByRoom = $derived(byRoom(heating.items, (r) => names.deviceRoom[sourceId(names, String(r['sensor'] ?? ''))] ?? null));

  interface RoomHistory {
    id: string;
    title: string;
    temperature: Series[];
    humidity: Series[];
    light: Series[];
    demand: Series[];
  }
  const rooms = $derived.by((): RoomHistory[] => {
    const ids = [...new Set([...climateByRoom.keys(), ...heatingByRoom.keys()])];
    const order = Object.keys(names.rooms);
    const rank = (id: string) => (order.indexOf(id) < 0 ? order.length : order.indexOf(id));
    return ids
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'sv'))
      .map((id) => {
        const c = climateByRoom.get(id) ?? [];
        const h = heatingByRoom.get(id) ?? [];
        // a target is drawn dashed in its thermostat's colour
        const targets = seriesBy(h, 'sensor', 'target', (k) => `Mål ${label(k)}`, { stepped: true, dash: true, colorKey: label });
        return {
          id,
          title: roomName(id, home.rooms),
          temperature: [...seriesBy(c, 'sensor', 'temperature', label), ...targets],
          humidity: seriesBy(c, 'sensor', 'humidity', label, { scale: 100, skipZero: true }),
          light: seriesBy(c, 'sensor', 'illuminance', label, { dropAllZero: true }),
          // an on/off heater that pulses is drawn as its share of time heating per bucket, like a thermostat's demand
          demand: seriesBy(h, 'sensor', 'pi', label, { stepped: true }).map((s) =>
            isPulsing(s.points) ? { ...s, label: `${s.label} *`, points: dutySeries(s.points, current.bucket, span.since, span.until) } : s,
          ),
        };
      })
      .filter((r) => r.temperature.length || r.humidity.length || r.light.length || r.demand.length);
  });

  const outdoor = $derived(seriesBy(weather.items, 'collectionName', 'temperature', () => 'Utomhus', { dash: true }));
  /** Every room's temperature as one line: the mean of its sources (not the targets), bucketed. */
  const overview = $derived([
    ...rooms
      .map((r) => meanSeries(r.temperature.filter((s) => !s.dash), current.bucket, r.title))
      .filter((s): s is Series => s !== null),
    ...outdoor,
  ]);

  /** Appliances: a device of kind pwm is a level (curve); everything else is on/off (timeline). */
  const powerSeries = $derived(seriesBy(power.items, 'name', 'powerlevel', (k) => k, { stepped: true }));
  const levels = $derived(powerSeries.filter((s) => names.deviceKind[sourceId(names, s.label)] === 'pwm').map((s) => ({ ...s, label: label(s.label) })));
  const switches = $derived(powerSeries.filter((s) => names.deviceKind[sourceId(names, s.label)] !== 'pwm').map((s) => ({ ...s, label: label(s.label) })));

  const noWeather = $derived(!weather.items.length);

</script>

<div class="toolbar">
  <div class="tabs inline" role="tablist" aria-label="Tidsintervall">
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

{#if loading}
  <!-- while loading only this is shown, so the previous interval's charts are never read as the new one's -->
  <div class="state" role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span>
    Hämtar historik för senaste {current.label}…
  </div>
{:else if climate.error}
  <div class="card msg">{climate.error}</div>
{:else}
  <section class="panel overview" aria-labelledby="h-overview">
    <h2 class="room" id="h-overview">Temperatur i rummen</h2>
    <Chart since={span.since} until={span.until} title="Medel per rum" unit="°C" series={overview} height={240} />
  </section>

  <div class="rooms">
    {#each rooms as r (r.id)}
      <section class="panel" aria-labelledby="h-{r.id}">
        <h2 class="room" id="h-{r.id}">{r.title}</h2>
        <div class="charts">
          {#if r.temperature.length}<Chart since={span.since} until={span.until} title="Temperatur" unit="°C" series={r.temperature} />{/if}
          {#if r.humidity.length}<Chart since={span.since} until={span.until} title="Luftfuktighet" unit="%" series={r.humidity} min={0} max={100} />{/if}
          {#if r.light.length}<Chart since={span.since} until={span.until} title="Ljus" unit="lx" series={r.light} min={0} />{/if}
          {#if r.demand.length}
            <Chart
              since={span.since}
              until={span.until}
              title="Värmebehov"
              unit="%"
              series={r.demand}
              min={0}
              max={100}
              note={r.demand.some((s) => s.label.endsWith(' *')) ? '* Slår av och på i korta pulser; kurvan visar hur stor del av tiden den värmer.' : undefined}
            />
          {/if}
        </div>
      </section>
    {/each}

    {#if levels.length || switches.length}
      <section class="panel" aria-labelledby="h-appliances">
        <h2 class="room" id="h-appliances">Apparater</h2>
        <div class="charts">
          {#if levels.length}<Chart since={span.since} until={span.until} title="Nivå" unit="%" series={levels} min={0} max={100} />{/if}
          {#if switches.length}<OnOffChart title="Tid påslagen" series={switches} since={span.since} until={span.until} />{/if}
        </div>
      </section>
    {/if}
  </div>

  {#if noWeather}
    <p class="note">Ingen väderhistorik i det här intervallet, så utomhustemperaturen saknas i jämförelsen.</p>
  {/if}
{/if}

<style>
  .panel {
    background: var(--paper-raised);
    border: 1px solid var(--line);
    border-radius: var(--radius-panel);
    padding: var(--space-5);
    min-width: 0;
  }
  .overview {
    margin-bottom: var(--space-5);
  }
  h2.room {
    font-family: var(--font-display);
    font-size: 20px;
    line-height: 1.1;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--ink);
    margin: 0 0 var(--space-4);
  }
  .state {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-6) var(--space-5);
    background: var(--paper-raised);
    border: 1px solid var(--line);
    border-radius: var(--radius-panel);
    font-size: 15px;
    color: var(--ink-muted);
  }
  /* A static ring with one ochre quarter: the words say it is loading, the ring only marks the spot (no animation). */
  .spinner {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 3px solid var(--line);
    border-top-color: var(--ochre);
    flex-shrink: 0;
  }
  .rooms {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr));
    gap: var(--space-5);
    align-items: start;
  }
  .charts {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
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
  .note {
    margin: var(--space-5) 0 0;
    font-size: 13px;
    color: var(--ink-faint);
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
