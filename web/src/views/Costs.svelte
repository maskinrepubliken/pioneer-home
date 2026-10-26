<script lang="ts">
  /**
   * Kostnader: estimated electricity cost for a chosen period (a day, a week, a month or a custom range of days),
   * per appliance and per hour or day. Same estimate as lib/cost.ts: rated power (devices.tsv `watts`) x heating
   * demand or on-time x spot price x VAT + surcharge. While a period loads, only the loading state is shown, so old
   * numbers are never read as the new period's.
   */
  import CostBars from '../components/CostBars.svelte';
  import { api, ApiError, type PriceSlot } from '../lib/api';
  import { computeCosts, costPerBucket, isUnreachable, kr, meanSpot, type CostResult } from '../lib/cost';
  import { formatQuantity, roomName } from '../lib/format';
  import { namesFromTables, type Rec } from '../lib/history';
  import { home } from '../lib/state.svelte';

  type Kind = 'day' | 'week' | 'month' | 'custom';
  const KINDS: { id: Kind; label: string }[] = [
    { id: 'day', label: 'Dag' },
    { id: 'week', label: 'Vecka' },
    { id: 'month', label: 'Månad' },
    { id: 'custom', label: 'Eget' },
  ];
  const MAX_DAYS = 62;

  let kind = $state<Kind>('month');
  /** Any moment inside the chosen day, week or month (local time). */
  let anchor = $state(new Date());
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let customFrom = $state(iso(new Date(Date.now() - 6 * 86_400_000)));
  let customTo = $state(iso(new Date()));

  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

  interface Period {
    from: Date;
    to: Date;
    title: string;
    /** bucket boundaries and their tick labels */
    buckets: { from: Date; to: Date; label: string }[];
    per: string;
    tickEvery: number;
  }

  const period = $derived.by((): Period => {
    const wd = ['sön', 'mån', 'tis', 'ons', 'tor', 'fre', 'lör'];
    const days = (from: Date, n: number) => Array.from({ length: n }, (_, i) => addDays(from, i));
    if (kind === 'day') {
      const from = startOfDay(anchor);
      const buckets = Array.from({ length: 24 }, (_, h) => ({
        from: new Date(from.getFullYear(), from.getMonth(), from.getDate(), h),
        to: new Date(from.getFullYear(), from.getMonth(), from.getDate(), h + 1),
        label: `${String(h).padStart(2, '0')}`,
      }));
      return { from, to: addDays(from, 1), title: from.toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), buckets, per: 'timme', tickEvery: 3 };
    }
    if (kind === 'week') {
      const d = startOfDay(anchor);
      const from = addDays(d, -((d.getDay() + 6) % 7));
      const to = addDays(from, 7);
      const week = isoWeek(from);
      const buckets = days(from, 7).map((x) => ({ from: x, to: addDays(x, 1), label: `${wd[x.getDay()]} ${x.getDate()}` }));
      const range = `${from.getDate()} ${from.toLocaleDateString('sv-SE', { month: 'short' })} – ${addDays(to, -1).getDate()} ${addDays(to, -1).toLocaleDateString('sv-SE', { month: 'short' })}`;
      return { from, to, title: `Vecka ${week} · ${range}`, buckets, per: 'dag', tickEvery: 1 };
    }
    if (kind === 'month') {
      const from = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const to = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
      const n = Math.round((to.getTime() - from.getTime()) / 86_400_000);
      const buckets = days(from, n).map((x) => ({ from: x, to: addDays(x, 1), label: String(x.getDate()) }));
      return { from, to, title: from.toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' }), buckets, per: 'dag', tickEvery: 5 };
    }
    const a = new Date(`${customFrom}T00:00`);
    const b = new Date(`${customTo}T00:00`);
    const from = isNaN(a.getTime()) ? startOfDay(new Date()) : a;
    let to = addDays(isNaN(b.getTime()) || b < from ? from : b, 1);
    if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_DAYS) to = addDays(from, MAX_DAYS);
    const n = Math.round((to.getTime() - from.getTime()) / 86_400_000);
    const buckets = days(from, n).map((x) => ({ from: x, to: addDays(x, 1), label: `${x.getDate()}/${x.getMonth() + 1}` }));
    const fmt = (d: Date) => d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' });
    return { from, to, title: `${fmt(from)} – ${fmt(addDays(to, -1))}`, buckets, per: 'dag', tickEvery: Math.max(1, Math.ceil(n / 10)) };
  });

  function isoWeek(d: Date): number {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t.getTime() - y.getTime()) / 86_400_000 + 1) / 7);
  }

  function step(n: number) {
    if (kind === 'day') anchor = addDays(anchor, n);
    else if (kind === 'week') anchor = addDays(anchor, 7 * n);
    else if (kind === 'month') anchor = new Date(anchor.getFullYear(), anchor.getMonth() + n, 1);
  }
  const isCurrent = $derived(period.from.getTime() <= Date.now() && Date.now() < period.to.getTime());
  const inFuture = $derived(period.from.getTime() > Date.now());

  // ---- loading: a token per request, so a slow answer for an earlier period never replaces a newer one -----------
  let loading = $state(true);
  let error = $state<string | null>(null);
  let heating = $state<Rec[]>([]);
  let power = $state<Rec[]>([]);
  let slots = $state<PriceSlot[]>([]);
  let loadedFor = $state<{ since: number; until: number } | null>(null);
  let token = 0;

  async function load(p: Period) {
    const mine = ++token;
    loading = true;
    error = null;
    const since = p.from;
    const until = new Date(Math.min(p.to.getTime(), Date.now()));
    if (until <= since) {
      heating = [];
      power = [];
      slots = [];
      loadedFor = { since: since.getTime() / 1000, until: since.getTime() / 1000 };
      loading = false;
      return;
    }
    try {
      // power rows are written only when an appliance switches: fetch further back so the state at the start is known
      const lookback = new Date(since.getTime() - 31 * 86_400_000);
      const [h, pw, pr] = await Promise.all([api.history('heating', since, until), api.history('power', lookback, until), api.prices(since, until).catch(() => null)]);
      if (mine !== token) return;
      heating = Array.isArray(h.items) ? h.items : [];
      power = Array.isArray(pw.items) ? pw.items : [];
      slots = pr?.slots ?? [];
      loadedFor = { since: since.getTime() / 1000, until: until.getTime() / 1000 };
    } catch (e) {
      if (mine !== token) return;
      const status = e instanceof ApiError ? e.status : 0;
      error = status === 404 || status >= 500 || status === 0 ? 'Historiken går inte att nå just nu.' : (e as Error).message;
    }
    loading = false;
  }

  $effect(() => {
    void load(period);
  });

  // ---- the estimate ----------------------------------------------------------------------------------------------
  const names = $derived(namesFromTables(home.tables?.files ?? {}));
  const cellNumber = (id: string, fallback: number) => {
    const v = home.cells[id]?.value;
    return typeof v === 'number' ? v : fallback;
  };
  const vat = $derived(cellNumber('electricity_vat', 1.25));
  const surcharge = $derived(cellNumber('electricity_surcharge', 0));
  const skip = (id: string) => isUnreachable(home.cells, names, id, Date.now());

  const costs = $derived.by((): CostResult[] => {
    if (!loadedFor || loadedFor.until <= loadedFor.since) return [];
    return computeCosts({ heating, power, names, pricing: { slots, vat, surcharge }, since: loadedFor.since, until: loadedFor.until, skip, roomLabel: (r) => roomName(r, home.rooms) });
  });
  const skipped = $derived(Object.keys(names.deviceWatts).filter(skip).map((id) => names.devices[id] ?? id));
  const totalSek = $derived(costs.reduce((n, c) => n + c.sek, 0));
  const totalKwh = $derived(costs.reduce((n, c) => n + c.kwh, 0));
  const avgSpot = $derived(meanSpot(slots));
  const paidPerKwh = $derived(totalKwh > 0 ? totalSek / totalKwh : null);
  const bucketRanges = $derived(period.buckets.map((b) => [b.from.getTime() / 1000, b.to.getTime() / 1000] as [number, number]));
  const bars = $derived(costs.map((c) => ({ label: c.label, values: costPerBucket(c, bucketRanges) })));
  const unknownShare = (c: CostResult) => (loadedFor ? Math.round((c.unknown / Math.max(loadedFor.until - loadedFor.since, 1)) * 100) : 0);
  const sek2 = (n: number) => n.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
</script>

<div class="toolbar controls">
  <div class="tabs inline" role="tablist" aria-label="Period">
    {#each KINDS as k (k.id)}
      <button role="tab" class:active={kind === k.id} aria-selected={kind === k.id} onclick={() => (kind = k.id)}>{k.label}</button>
    {/each}
  </div>
  {#if kind === 'custom'}
    <label class="date">Från <input type="date" bind:value={customFrom} max={customTo} /></label>
    <label class="date">Till <input type="date" bind:value={customTo} min={customFrom} /></label>
    <span class="muted small">högst {MAX_DAYS} dagar</span>
  {:else}
    <div class="nav">
      <button class="btn small" onclick={() => step(-1)} aria-label="Föregående">‹</button>
      <button class="btn small" onclick={() => step(1)} aria-label="Nästa" disabled={isCurrent || inFuture}>›</button>
      {#if !isCurrent}<button class="btn small" onclick={() => (anchor = new Date())}>Nu</button>{/if}
    </div>
  {/if}
</div>

<h2 class="period">{period.title}</h2>

{#if loading}
  <div class="state" role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span>
    Hämtar historik och elpriser för {period.title}…
  </div>
{:else if error}
  <div class="state error" role="alert">{error}</div>
{:else if inFuture}
  <div class="state">Perioden har inte börjat än.</div>
{:else if !costs.length}
  <div class="state">Inga kostnader att visa för perioden. Kostnaden räknas för enheter som har en effekt (watts) i Enheter och som har historik.</div>
{:else}
  <section class="panel">
    <div class="top">
      <div class="total">
        <span class="label">{isCurrent ? 'Hittills' : 'Totalt'}</span>
        <b class="big">{kr(totalSek)}</b>
        <span class="sub">{formatQuantity(Math.round(totalKwh * 10) / 10, 'kWh')}</span>
      </div>
      <div class="total">
        <span class="label">Snittpris</span>
        <b class="big">{paidPerKwh === null ? '—' : `${sek2(paidPerKwh)} kr/kWh`}</b>
        <span class="sub">{avgSpot === null ? 'inga spotpriser' : `spotpris i snitt ${sek2(avgSpot)} kr/kWh utan moms`}</span>
      </div>
    </div>

    <CostBars labels={[period.per]} series={bars} buckets={period.buckets.map((b) => b.label)} tickEvery={period.tickEvery} />

    <table class="costs">
      <thead><tr><th>Apparat</th><th>Effekt</th><th>Energi</th><th>Kostnad</th><th>Andel</th></tr></thead>
      <tbody>
        {#each costs as c, i (i)}
          <tr>
            <td>{c.label}{#if unknownShare(c) >= 10}<span class="unk"> · okänt {unknownShare(c)} % av tiden</span>{/if}</td>
            <td class="value">{c.watts} W</td>
            <td class="value">{formatQuantity(Math.round(c.kwh * 10) / 10, 'kWh')}</td>
            <td class="value">{kr(c.sek)}</td>
            <td class="value">{totalSek > 0 ? Math.round((c.sek / totalSek) * 100) : 0} %</td>
          </tr>
        {/each}
        {#each skipped as name, i (i)}
          <tr class="skipped">
            <td>{name}<span class="unk"> · nås inte, räknas inte</span></td>
            <td></td>
            <td></td>
            <td class="value">—</td>
            <td></td>
          </tr>
        {/each}
      </tbody>
    </table>

    <p class="note">
      Uppskattning: effekt × värmebehov (eller tid påslagen) × spotpris per kvart med moms ({Math.round((vat - 1) * 100)} %) plus påslag
      {sek2(surcharge)} kr/kWh för nät och skatt. Effekten står i Enheter (watts), moms och påslag i Celler (electricity_vat, electricity_surcharge).
      Tid utan historik räknas som okänd, inte som påslagen.
    </p>
  </section>
{/if}

<style>
  .controls {
    flex-wrap: wrap;
    gap: var(--space-3);
  }
  .nav {
    display: inline-flex;
    gap: var(--space-2);
  }
  .date {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 14px;
    color: var(--ink-muted);
  }
  h2.period {
    font-family: var(--font-display);
    font-size: 24px;
    line-height: 1.15;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink);
    margin: var(--space-4) 0;
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
  .state.error {
    color: var(--alarm);
  }
  /* A static ring with one ochre quarter: the word says it is loading, the ring only marks the spot (no animation). */
  .spinner {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 3px solid var(--line);
    border-top-color: var(--ochre);
    flex-shrink: 0;
  }
  .panel {
    background: var(--paper-raised);
    border: 1px solid var(--line);
    border-radius: var(--radius-panel);
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }
  .top {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
  }
  .total {
    flex: 1 1 220px;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    background: var(--surface-ink);
    color: var(--on-dark);
    border-radius: var(--radius-m);
    padding: var(--space-4) var(--space-5);
  }
  .total .label {
    font-family: var(--font-display);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ochre);
  }
  .total .big {
    font-family: var(--font-mono);
    font-size: 32px;
    line-height: 1.1;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .total .sub {
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .costs {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  }
  .costs th {
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
  .costs th:not(:first-child),
  .costs td.value {
    text-align: right;
  }
  .costs td {
    padding: var(--space-2) var(--space-2) var(--space-2) 0;
    border-bottom: 1px solid var(--line);
  }
  .skipped td {
    color: var(--ink-faint);
  }
  .unk {
    font-size: 12px;
    color: var(--ink-faint);
  }
  .note {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--ink-faint);
  }
  .small {
    font-family: var(--font-mono);
    font-size: 12px;
  }
  /* Period picker: the same segmented capsule as in Grafer. */
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
</style>
