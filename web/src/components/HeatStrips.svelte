<script lang="ts">
  /**
   * What the heat cost, and why: aligned strips over the same hours, one measure each (never two y-axes):
   * outdoor temperature (line), daylight from a sensor that sees only the sky (line, when there is one), heating power per heat source (stacked bars, kW = kWh in the hour), the price
   * paid per kWh (line) and the cost per heat source (stacked bars). Hovering, tapping or the arrow keys pick an
   * hour across every strip; its values are read out above the strips, and every hour is also in the table.
   * Heat sources keep their colour by name (alphabetical), never by rank. For a plan, two strips come first: the
   * heating mode of each hour (a band in the week grid's fills, split in a transition) and each room's target per
   * quarter (stepped lines, one dash pattern per room).
   */
  import { kr } from '../lib/cost';
  import { seriesFill, seriesStroke } from '../lib/seriesFill';
  import type { ModeFill } from '../lib/week';

  interface HourMode {
    name: string;
    fill: ModeFill;
  }
  interface Target {
    label: string;
    /** °C per quarter, four per hour */
    q: (number | null)[];
  }

  interface Source {
    label: string;
    kw: number[];
    sek: number[];
  }
  let {
    hours,
    outdoor,
    sun = [],
    price,
    sources,
    order = [],
    ahead = false,
    modes = [],
    targets = [],
  }: {
    /** start of each hour, epoch seconds */
    hours: number[];
    outdoor: (number | null)[];
    /** daylight, lx per hour (setting daylight_sensor); empty or all null: no Sol strip */
    sun?: (number | null)[];
    /** kr/kWh paid (spot x VAT + surcharge) */
    price: (number | null)[];
    sources: Source[];
    /** every appliance's label in fill order (lib/cost.ts applianceOrder); labels not in it come after, by name */
    order?: string[];
    /** the hours are a plan, not history: without a pick the readout shows the first hour */
    ahead?: boolean;
    /** the heating modes in force each hour (two in a transition); empty: no Läge strip */
    modes?: HourMode[][];
    /** each room's target per quarter; empty: no Mål strip */
    targets?: Target[];
  } = $props();

  const ordered = $derived([...sources].sort((a, b) => a.label.localeCompare(b.label, 'sv')));
  const slots = $derived([...order, ...ordered.map((s) => s.label).filter((l) => !order.includes(l))]);
  /** Solid colours with a wide spread in lightness (lib/seriesFill.ts), by appliance, not rank. */
  const slot = (i: number) => slots.indexOf(ordered[i]!.label);
  const colour = (i: number) => seriesFill(slot(i));
  const outline = (i: number) => seriesStroke(slot(i));

  let width = $state(0);
  const GUTTER = 46;
  const plotW = $derived(Math.max(0, width - GUTTER));
  const n = $derived(hours.length);
  const bw = $derived(n ? plotW / n : 0);
  const x = (i: number) => GUTTER + i * bw;

  let active = $state<number | null>(null);
  /** Without a pick: the last whole hour (the current one has only just begun). */
  const shown = $derived(active ?? (ahead ? (n ? 0 : null) : n > 1 ? n - 2 : n ? 0 : null));

  const sum = (arr: number[][], i: number) => arr.reduce((t, a) => t + (a[i] ?? 0), 0);
  const kwTotal = $derived(hours.map((_, i) => sum(ordered.map((s) => s.kw), i)));
  const sekTotal = $derived(hours.map((_, i) => sum(ordered.map((s) => s.sek), i)));

  /** A round axis top: 1, 2 or 5 times a power of ten at or above the largest value. */
  function niceTop(max: number): number {
    if (max <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(max)));
    return [1, 2, 2.5, 5, 10].map((f) => f * p).find((v) => v >= max) ?? max;
  }
  function range(vals: (number | null)[]): [number, number] {
    const v = vals.filter((x): x is number => x !== null);
    if (!v.length) return [0, 1];
    const lo = Math.floor(Math.min(...v));
    const hi = Math.ceil(Math.max(...v));
    return lo === hi ? [lo - 1, hi + 1] : [lo, hi];
  }

  const H = { line: 64, bars: 78 };
  const PAD = 6;
  /** A line as an SVG path over the hour centres, broken where a value is missing. */
  function linePath(vals: (number | null)[], lo: number, hi: number, h: number): string {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      const px = x(i) + bw / 2;
      const py = PAD + (1 - (v - lo) / (hi - lo || 1)) * (h - 2 * PAD);
      d += `${pen ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`;
      pen = true;
    });
    return d;
  }
  /** Stacked bars: one rect per source and hour, a 1px surface gap between hours. */
  function stacks(key: 'kw' | 'sek', top: number, h: number) {
    const out: { x: number; y: number; w: number; h: number; c: string; s: string }[] = [];
    for (let i = 0; i < n; i++) {
      let base = h;
      ordered.forEach((s, k) => {
        const v = s[key][i] ?? 0;
        if (v <= 0) return;
        const bh = (v / top) * (h - PAD);
        base -= bh;
        // a one-pixel paper gap above each segment keeps stacked sources apart
        out.push({ x: x(i) + 0.5, y: base + 1, w: Math.max(bw - 1.5, 0.5), h: Math.max(bh - 1, 0.5), c: colour(k), s: outline(k) });
      });
    }
    return out;
  }

  /** Runs of hours with the same single mode, labelled when the name fits (a transition hour is a run by itself). */
  const modeRuns = $derived.by(() => {
    const runs: { from: number; to: number; parts: HourMode[] }[] = [];
    modes.forEach((m, i) => {
      const last = runs[runs.length - 1];
      const key = (ms: HourMode[]) => ms.map((x) => x.name).join('+');
      if (last && m.length === 1 && last.parts.length === 1 && key(last.parts) === key(m)) last.to = i;
      else runs.push({ from: i, to: i, parts: m });
    });
    return runs;
  });
  const hasModes = $derived(modes.some((m) => m.length));
  const hasTargets = $derived(targets.some((t) => t.q.some((v) => v !== null)));
  const targetRange = $derived(range(targets.flatMap((t) => t.q)));
  const DASHES = ['', '6 3', '1.5 3', '8 3 2 3'];
  /** A stepped line over the quarters, broken where a value is missing. */
  function stepPath(vals: (number | null)[], lo: number, hi: number, h: number): string {
    const qw = bw / 4;
    let d = '';
    let pen = false;
    vals.forEach((v, q) => {
      if (v === null) {
        pen = false;
        return;
      }
      const py = (PAD + (1 - (v - lo) / (hi - lo || 1)) * (h - 2 * PAD)).toFixed(1);
      const x0 = (GUTTER + q * qw).toFixed(1);
      d += pen ? `V${py}H${(GUTTER + (q + 1) * qw).toFixed(1)}` : `M${x0},${py}H${(GUTTER + (q + 1) * qw).toFixed(1)}`;
      pen = true;
    });
    return d;
  }
  /** A room's target in an hour: one value, or the range when it changes within the hour. */
  function targetIn(t: Target, i: number): string {
    const v = t.q.slice(i * 4, i * 4 + 4).filter((x): x is number => x !== null);
    if (!v.length) return '—';
    const lo = Math.min(...v);
    const hi = Math.max(...v);
    return lo === hi ? `${num1(lo)} °C` : `${num1(lo)}–${num1(hi)} °C`;
  }
  const modeIn = (i: number) => (modes[i] ?? []).map((m) => m.name).join(' + ') || '—';

  const tempRange = $derived(range(outdoor));
  const priceRange = $derived(range(price.map((p) => (p === null ? null : p))));
  const hasSun = $derived(sun.some((v) => v !== null));
  const sunTop = $derived(niceTop(Math.max(0, ...sun.filter((v): v is number => v !== null))));
  const STRIPS = $derived([
    ...(hasModes ? [{ id: 'lage', title: 'Läge', unit: '', kind: 'modes', h: 22 }] : []),
    ...(hasTargets ? [{ id: 'mal', title: 'Mål', unit: '°C', kind: 'targets', h: H.line + 8 }] : []),
    { id: 'ute', title: 'Ute', unit: '°C', kind: 'line', h: H.line },
    ...(hasSun ? [{ id: 'sol', title: 'Sol', unit: 'lx', kind: 'sun', h: H.line }] : []),
    { id: 'kw', title: 'Värme', unit: 'kW', kind: 'kw', h: H.bars },
    { id: 'pris', title: 'Elpris', unit: 'kr/kWh', kind: 'price', h: H.line },
    { id: 'kr', title: 'Kostnad', unit: 'kr', kind: 'sek', h: H.bars },
  ]);
  const lux = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v).toLocaleString('sv-SE')} lx`);
  const kwTop = $derived(niceTop(Math.max(...kwTotal, 0)));
  const sekTop = $derived(niceTop(Math.max(...sekTotal, 0)));
  const kwBars = $derived(stacks('kw', kwTop, H.bars));
  const sekBars = $derived(stacks('sek', sekTop, H.bars));

  const hh = (t: number) => String(new Date(t * 1000).getHours()).padStart(2, '0');
  const dayHour = (t: number) => {
    const d = new Date(t * 1000);
    return `${d.toLocaleDateString('sv-SE', { weekday: 'short' })} ${hh(t)}–${hh(t + 3600)}`;
  };
  /** Ticks every 6 hours on the clock. */
  const ticks = $derived(hours.map((t, i) => ({ i, t })).filter(({ t }) => new Date(t * 1000).getHours() % 6 === 0));

  const num1 = (v: number) => v.toLocaleString('sv-SE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const num2 = (v: number) => v.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function pick(e: PointerEvent, el: SVGSVGElement) {
    const r = el.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - GUTTER) / (bw || 1));
    active = i >= 0 && i < n ? i : null;
  }
  function key(e: KeyboardEvent) {
    if (!n) return;
    const cur = active ?? n - 1;
    if (e.key === 'ArrowLeft') active = Math.max(0, cur - 1);
    else if (e.key === 'ArrowRight') active = Math.min(n - 1, cur + 1);
    else return;
    e.preventDefault();
  }
  let tableOpen = $state(false);
</script>

<figure class="strips" bind:clientWidth={width}>
  <figcaption class="readout" aria-live="polite">
    {#if shown !== null}
      <span class="when">{dayHour(hours[shown]!)}{active === null ? (ahead ? ' · första timmen' : ' · senaste hela timmen') : ''}</span>
      <dl class="vals">
        {#if hasModes}<div><dt>Läge</dt><dd class="value">{modeIn(shown)}</dd></div>{/if}
        {#each hasTargets ? targets : [] as t (t.label)}<div><dt>Mål {t.label}</dt><dd class="value">{targetIn(t, shown)}</dd></div>{/each}
        <div><dt>Ute</dt><dd class="value">{outdoor[shown] === null ? '—' : `${num1(outdoor[shown]!)} °C`}</dd></div>
        {#if hasSun}<div><dt>Sol</dt><dd class="value">{lux(sun[shown])}</dd></div>{/if}
        <div><dt>Värme</dt><dd class="value">{num2(kwTotal[shown] ?? 0)} kW</dd></div>
        <div><dt>Elpris</dt><dd class="value">{price[shown] === null ? '—' : `${num2(price[shown]!)} kr/kWh`}</dd></div>
        <div><dt>Kostnad</dt><dd class="value">{kr(sekTotal[shown] ?? 0)}</dd></div>
      </dl>
    {/if}
  </figcaption>

  <div
    class="plots"
    tabindex="0"
    role="slider"
    aria-label="Timme: pilarna väljer timme"
    aria-valuemin={0}
    aria-valuemax={Math.max(n - 1, 0)}
    aria-valuenow={shown ?? 0}
    aria-valuetext={shown === null ? '' : dayHour(hours[shown]!)}
    onkeydown={key}
  >
    {#if width > 0}
      {#each STRIPS as strip (strip.id)}
        <div class="strip">
          <span class="stitle"
            >{strip.title} <span class="unit">{strip.unit}</span>
            {#if strip.kind === 'targets'}
              {#each targets as t, k (t.label)}
                <span class="key"><svg width="22" height="8" aria-hidden="true"><line x1="0" x2="22" y1="4" y2="4" stroke-dasharray={DASHES[k % DASHES.length]} /></svg>{t.label}</span>
              {/each}
            {/if}
          </span>
          <svg
            width={width}
            height={strip.h}
            role="img"
            aria-label="{strip.title} per timme"
            onpointermove={(e) => pick(e, e.currentTarget)}
            onpointerdown={(e) => pick(e, e.currentTarget)}
            onpointerleave={(e) => e.pointerType === 'mouse' && (active = null)}
          >
            <line class="base" x1={GUTTER} x2={width} y1={strip.h - 0.5} y2={strip.h - 0.5} />
            {#if strip.kind === 'modes'}
              {#each modeRuns as r (r.from)}
                {#each r.parts as m, k (k)}
                  {@const w = ((r.to - r.from + 1) * bw) / r.parts.length}
                  <rect
                    x={x(r.from) + k * w + 0.5}
                    y="1"
                    width={Math.max(w - 1, 0.5)}
                    height={strip.h - 2}
                    style="fill: {m.fill.bg}; stroke: {m.fill.line ?? 'none'}"
                    shape-rendering="crispEdges"
                  />
                {/each}
                {#if r.parts.length === 1}
                  {@const w = (r.to - r.from + 1) * bw}
                  {@const label = w >= r.parts[0]!.name.length * 7 + 8 ? r.parts[0]!.name : w >= 12 ? r.parts[0]!.name.slice(0, 1) : ''}
                  {#if label}<text class="mname" x={x(r.from) + w / 2} y={strip.h / 2 + 4} style="fill: {r.parts[0]!.fill.fg}">{label}</text>{/if}
                {/if}
              {/each}
            {:else if strip.kind === 'targets'}
              <text class="ax" x={GUTTER - 6} y={PAD + 4}>{targetRange[1]}°</text>
              <text class="ax" x={GUTTER - 6} y={strip.h - PAD}>{targetRange[0]}°</text>
              {#each targets as t, k (t.label)}
                <path class="line step" stroke-dasharray={DASHES[k % DASHES.length]} d={stepPath(t.q, targetRange[0], targetRange[1], strip.h)} />
              {/each}
            {:else if strip.kind === 'line'}
              <text class="ax" x={GUTTER - 6} y={PAD + 4}>{tempRange[1]}°</text>
              <text class="ax" x={GUTTER - 6} y={strip.h - PAD}>{tempRange[0]}°</text>
              {#if tempRange[0] < 0 && tempRange[1] > 0}
                {@const y0 = PAD + (tempRange[1] / (tempRange[1] - tempRange[0])) * (strip.h - 2 * PAD)}
                <line class="zero" x1={GUTTER} x2={width} y1={y0} y2={y0} />
              {/if}
              <path class="line" d={linePath(outdoor, tempRange[0], tempRange[1], strip.h)} />
            {:else if strip.kind === 'sun'}
              <text class="ax" x={GUTTER - 6} y={PAD + 4}>{sunTop.toLocaleString('sv-SE')}</text>
              <text class="ax" x={GUTTER - 6} y={strip.h - PAD}>0</text>
              <path class="line" d={linePath(sun, 0, sunTop, strip.h)} />
            {:else if strip.kind === 'price'}
              <text class="ax" x={GUTTER - 6} y={PAD + 4}>{num1(priceRange[1])}</text>
              <text class="ax" x={GUTTER - 6} y={strip.h - PAD}>{num1(priceRange[0])}</text>
              <path class="line" d={linePath(price, priceRange[0], priceRange[1], strip.h)} />
            {:else}
              {@const top = strip.kind === 'kw' ? kwTop : sekTop}
              <text class="ax" x={GUTTER - 6} y={PAD + 4}>{strip.kind === 'kw' ? num1(top) : num2(top)}</text>
              <text class="ax" x={GUTTER - 6} y={strip.h - 2}>0</text>
              {#each strip.kind === 'kw' ? kwBars : sekBars as b, i (i)}
                <rect x={b.x} y={b.y} width={b.w} height={b.h} fill={b.c} stroke={b.s} stroke-width="1" shape-rendering="crispEdges" />
              {/each}
            {/if}
            {#if shown !== null && active !== null}
              <rect class="cursor" x={x(shown)} y="0" width={Math.max(bw, 1)} height={strip.h} />
            {/if}
          </svg>
        </div>
      {/each}
      <svg class="xaxis" width={width} height="16" aria-hidden="true">
        {#each ticks as t (t.i)}
          <text x={x(t.i)} y="12">{hh(t.t)}</text>
        {/each}
      </svg>
    {/if}
  </div>

  <ul class="legend">
    {#each ordered as s, i (s.label)}
      <li><svg class="sw" width="14" height="14" aria-hidden="true"><rect x="0.5" y="0.5" width="13" height="13" rx="3" fill={colour(i)} stroke={outline(i)} /></svg>{s.label}</li>
    {/each}
  </ul>

  <button class="btn small tablebtn" aria-expanded={tableOpen} onclick={() => (tableOpen = !tableOpen)}>{tableOpen ? 'Dölj tabellen' : 'Visa som tabell'}</button>
  {#if tableOpen}
    <div class="tablewrap">
      <table>
        <thead><tr><th>Timme</th>{#if hasModes}<th>Läge</th>{/if}{#each hasTargets ? targets : [] as t (t.label)}<th>{t.label}</th>{/each}<th>Ute</th>{#if hasSun}<th>Sol</th>{/if}<th>Värme</th><th>Elpris</th><th>Kostnad</th></tr></thead>
        <tbody>
          {#each hours as t, i (t)}
            <tr>
              <td>{dayHour(t)}</td>
              {#if hasModes}<td>{modeIn(i)}</td>{/if}
              {#each hasTargets ? targets : [] as tg (tg.label)}<td class="value">{targetIn(tg, i)}</td>{/each}
              <td class="value">{outdoor[i] === null ? '—' : `${num1(outdoor[i]!)} °C`}</td>
              {#if hasSun}<td class="value">{lux(sun[i])}</td>{/if}
              <td class="value">{num2(kwTotal[i] ?? 0)} kW</td>
              <td class="value">{price[i] === null ? '—' : num2(price[i]!)}</td>
              <td class="value">{kr(sekTotal[i] ?? 0)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</figure>

<style>
  .strips {
    margin: 0;
    min-width: 0;
  }
  .readout {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-3);
    min-height: 44px;
    margin-bottom: var(--space-2);
    font-size: 13px;
    line-height: 1.4;
    color: var(--ink-muted);
  }
  .when {
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-faint);
    flex-basis: 100%;
  }
  /* One cell per measure: its name above, the value under it, a rule on the left between cells. */
  .vals {
    flex-basis: 100%;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) 0;
    margin: 0;
  }
  .vals > div {
    border-left: 1px solid var(--line-strong);
    padding: 0 var(--space-3) 0 var(--space-2);
  }
  .vals dt {
    font-size: 11px;
    line-height: 1.3;
    color: var(--ink-faint);
    white-space: nowrap;
  }
  .vals dd {
    margin: 0;
    color: var(--ink);
    font-size: 15px;
    line-height: 1.3;
    white-space: nowrap;
  }
  .plots {
    touch-action: pan-y;
  }
  .plots:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 4px;
    border-radius: var(--radius-s);
  }
  .strip {
    margin-top: var(--space-1);
  }
  .strip + .strip {
    border-top: 1px solid var(--line);
    padding-top: var(--space-1);
  }
  .stitle {
    display: block;
    padding-left: 46px;
    margin-bottom: 2px;
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
    pointer-events: none;
  }
  .stitle .unit {
    font-weight: 400;
    color: var(--ink-faint);
  }
  svg {
    display: block;
    overflow: visible;
  }
  .ax {
    font-family: var(--font-mono);
    font-size: 10px;
    fill: var(--ink-faint);
    text-anchor: end;
  }
  .xaxis text {
    font-family: var(--font-mono);
    font-size: 10px;
    fill: var(--ink-faint);
  }
  .base {
    stroke: var(--line-strong);
    stroke-width: 1;
  }
  .zero {
    stroke: var(--line);
    stroke-dasharray: 2 3;
  }
  /* Ute and Elpris are one line each in their own titled strip: ink, no legend entry. */
  .line {
    fill: none;
    stroke: var(--ink);
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  .step {
    stroke-width: 1.75;
    stroke-linecap: butt;
  }
  .mname {
    font-family: var(--font-ui);
    font-size: 11px;
    font-weight: 600;
    text-anchor: middle;
    pointer-events: none;
  }
  .key {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: var(--space-3);
    font-weight: 400;
    color: var(--ink-muted);
  }
  .key line {
    stroke: var(--ink);
    stroke-width: 1.75;
  }
  .cursor {
    fill: none;
    stroke: var(--ink);
    stroke-width: 1;
  }
  .legend {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
    margin: var(--space-3) 0 0;
    padding: 0;
    font-size: 13px;
    color: var(--ink-muted);
  }
  .legend li {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .sw {
    flex-shrink: 0;
  }
  .tablebtn {
    margin-top: var(--space-3);
  }
  .tablewrap {
    margin-top: var(--space-2);
    max-height: 320px;
    overflow: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th {
    position: sticky;
    top: 0;
    background: var(--paper-raised);
    text-align: right;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 400;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-faint);
    padding: var(--space-1) var(--space-2);
    border-bottom: 1px solid var(--line-strong);
  }
  th:first-child,
  td:first-child {
    text-align: left;
  }
  td {
    text-align: right;
    padding: 3px var(--space-2);
    border-bottom: 1px solid var(--line);
    white-space: nowrap;
  }
</style>
