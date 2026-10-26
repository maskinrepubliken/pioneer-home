<script lang="ts">
  /**
   * A single uPlot time-series chart. Series may have different timestamps; they are aligned with uPlot.join.
   * The title (with its unit) and the legend are drawn here, not by uPlot: the legend shows each series' latest
   * value, or the value under the cursor while hovering. Time axis in 24 h Swedish form. Dashed series are
   * references (targets, outdoor). Rebuilds when data, width or the theme (data-theme on <html>) changes.
   */
  import uPlot from 'uplot';
  import { onMount } from 'svelte';
  import { formatQuantity, LOCALE } from '../lib/format';
  import type { Series } from '../lib/history';

  let {
    title,
    unit = '',
    series,
    height = 200,
    min,
    max,
    since,
    until,
    note,
  }: { title: string; unit?: string; series: Series[]; height?: number; min?: number; max?: number; since?: number; until?: number; note?: string | undefined } = $props();

  // The five colours of the system, read from the tokens at render time so themes just work.
  // Fixed order, never cycled. On a dark paper (ink theme) the two surfaces sink into the card,
  // so the light colours lead there and forest/rust take the last seats.
  // Neighbours in the order differ the most (forest and ink are both dark, so they are kept apart).
  const PALETTE_LIGHT = ['--surface-forest', '--ochre', '--surface-rust', '--ink', '--ink-muted'];
  const PALETTE_DARK = ['--ink', '--ochre', '--surface-rust', '--ink-muted', '--surface-forest'];

  let host: HTMLDivElement;
  let plot: uPlot | null = null;
  let width = $state(0);
  let colours = $state<string[]>([]);
  /** Index into the joined data under the cursor, null when not hovering. */
  let hover = $state<number | null>(null);
  let hoverTime = $state<number | null>(null);
  let joined: uPlot.AlignedData | null = null;

  /** At most five series (the palette); a stepped series (a level, a target) holds its last value up to `until`. */
  const shown = $derived(
    series.slice(0, 5).map((s) => {
      const last = s.points[s.points.length - 1];
      return s.stepped && until !== undefined && last && last[0] < until ? { ...s, points: [...s.points, [until, last[1]] as [number, number]] } : s;
    }),
  );

  function css(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /** True when the current theme's paper is darker than its ink (the ink theme), whatever set it. */
  function isDarkPaper(): boolean {
    const lum = (hex: string) => {
      const m = /^#([0-9a-f]{6})$/i.exec(hex);
      if (!m) return 1;
      const n = parseInt(m[1]!, 16);
      return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
    };
    return lum(css('--paper')) < lum(css('--ink'));
  }

  const two = (n: number) => String(n).padStart(2, '0');
  /** Tick labels: 14:00 within a day, the date at midnight, D/M when the span is several days. */
  function timeTicks(_u: uPlot, splits: number[], _ax: number, _space: number, incr: number): string[] {
    return splits.map((s) => {
      const d = new Date(s * 1000);
      const date = `${d.getDate()}/${d.getMonth() + 1}`;
      if (incr >= 86_400) return date;
      if (d.getHours() === 0 && d.getMinutes() === 0) return date;
      return `${two(d.getHours())}:${two(d.getMinutes())}`;
    });
  }

  function build() {
    plot?.destroy();
    plot = null;
    joined = null;
    if (!host || width < 40 || !shown.length) return;
    const palette = (isDarkPaper() ? PALETTE_DARK : PALETTE_LIGHT).map(css);
    // One colour per colour key, in order of first appearance: a thermostat and its dashed target match.
    const keys: string[] = [];
    for (const s of shown) if (!keys.includes(s.colorKey ?? s.label)) keys.push(s.colorKey ?? s.label);
    const pal = shown.map((s) => palette[keys.indexOf(s.colorKey ?? s.label) % palette.length]!);
    colours = pal;
    joined = uPlot.join(shown.map((s) => [s.points.map((p) => p[0]), s.points.map((p) => p[1])] as uPlot.AlignedData));
    const axisColor = css('--ink-faint');
    const grid = css('--line');
    const axisFont = `12px ${css('--font-mono')}`;

    const opts: uPlot.Options = {
      width,
      height,
      cursor: { drag: { x: true, y: false }, points: { size: 8 } },
      legend: { show: false },
      // Every chart on the page shares the chosen interval, so they line up when read top to bottom.
      scales: { x: since !== undefined && until !== undefined ? { time: true, range: [since, until] } : { time: true }, y: { range: rangeFn } },
      axes: [
        { stroke: axisColor, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1 }, font: axisFont, values: timeTicks, space: 60 },
        {
          stroke: axisColor,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid, width: 1 },
          font: axisFont,
          size: 48,
          // as many decimals as the tick step needs (0.05 kr steps show two, 5 °C steps none)
          values: (_u, vals, _ax, _space, incr) => vals.map((v) => v.toFixed(incr >= 1 ? 0 : incr >= 0.1 ? 1 : 2)),
        },
      ],
      series: [
        {},
        ...shown.map((s, i) => ({
          label: s.label,
          stroke: pal[i]!,
          width: s.dash ? 1.5 : 2,
          ...(s.dash ? { dash: [6, 4] } : {}),
          spanGaps: true,
          points: { show: false },
          ...(s.stepped ? { paths: uPlot.paths.stepped!({ align: 1 }) } : {}),
        })),
      ],
      hooks: {
        setCursor: [
          (u) => {
            const i = u.cursor.idx;
            hover = i === null || i === undefined ? null : i;
            hoverTime = hover === null ? null : ((u.data[0][hover] as number | undefined) ?? null);
          },
        ],
      },
    };
    plot = new uPlot(opts, joined, host);
  }

  function rangeFn(_u: uPlot, dataMin: number | null, dataMax: number | null): uPlot.Range.MinMax {
    if (dataMin === null || dataMax === null) return [min ?? 0, max ?? 1];
    let lo = min ?? dataMin;
    let hi = max ?? dataMax;
    if (min === undefined && max === undefined) {
      const pad = Math.max((hi - lo) * 0.1, 0.5);
      lo -= pad;
      hi += pad;
    }
    return [lo, hi];
  }

  /** Value for the legend: under the cursor (the nearest earlier value of that series), else the latest. */
  function valueOf(i: number): number | null {
    const s = shown[i];
    if (!s?.points.length) return null;
    if (hoverTime === null) return s.points[s.points.length - 1]![1];
    let v: number | null = null;
    for (const [t, y] of s.points) {
      if (t > hoverTime) break;
      v = y;
    }
    return v;
  }
  const whenText = $derived(
    hoverTime === null ? 'senast' : new Date(hoverTime * 1000).toLocaleString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  );

  onMount(() => {
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (w !== width) width = w;
    });
    ro.observe(host);
    // Themes switch only via <html data-theme>; rebuild so the colours are re-read from the tokens.
    const themeObserver = new MutationObserver(() => build());
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      ro.disconnect();
      themeObserver.disconnect();
      plot?.destroy();
    };
  });

  $effect(() => {
    // Track the reactive inputs, then rebuild.
    void shown;
    void width;
    void since;
    void unit;
    build();
  });
</script>

<figure class="chart">
  <figcaption>
    <span class="title">{title}{#if unit}<span class="unit">, {unit}</span>{/if}</span>
    {#if shown.length}<span class="when">{whenText}</span>{/if}
  </figcaption>
  <div class="host" bind:this={host}></div>
  {#if shown.length}
    <ul class="legend">
      {#each shown as s, i (i)}
        {@const v = valueOf(i)}
        <li>
          <svg class="swatch" width="20" height="8" aria-hidden="true">
            <line x1="1" y1="4" x2="19" y2="4" stroke={colours[i]} stroke-width={s.dash ? 1.5 : 2.5} stroke-dasharray={s.dash ? '5 3' : undefined} stroke-linecap="round" />
          </svg>
          <span class="name">{s.label}</span>
          <b class="value">{v === null ? '—' : formatQuantity(v, unit)}</b>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty">Inga data i det här intervallet.</p>
  {/if}
  {#if note}<p class="note">{note}</p>{/if}
</figure>

<style>
  .chart {
    margin: 0;
    min-width: 0;
  }
  figcaption {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--space-3);
    margin-bottom: var(--space-2);
  }
  .title {
    font-family: var(--font-ui);
    font-size: 15px;
    line-height: 1.4;
    font-weight: 600;
    color: var(--ink);
  }
  .unit {
    font-weight: 400;
    color: var(--ink-faint);
  }
  .when {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--ink-faint);
    white-space: nowrap;
  }
  .host {
    width: 100%;
  }
  .legend {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr));
    gap: var(--space-1) var(--space-4);
  }
  .legend li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  .swatch {
    flex-shrink: 0;
  }
  .name {
    font-size: 13px;
    line-height: 1.4;
    color: var(--ink-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }
  .legend .value {
    font-size: 14px;
  }
  .note {
    margin: var(--space-2) 0 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--ink-faint);
  }
  .empty {
    margin: var(--space-3) 0;
    font-size: 13px;
    color: var(--ink-faint);
  }
</style>
