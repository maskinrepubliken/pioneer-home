<script lang="ts">
  /**
   * A single uPlot time-series chart. Series may have different timestamps; they are aligned
   * with uPlot.join. Rebuilds when data, width or the theme (data-theme on <html>) changes.
   */
  import uPlot from 'uplot';
  import { onMount } from 'svelte';
  import { LOCALE } from '../lib/format';

  export interface Series {
    label: string;
    /** [epoch seconds, value] pairs, ascending. */
    points: [number, number][];
    stepped?: boolean;
  }

  let { title, unit = '', series, height = 220, min, max }: { title: string; unit?: string; series: Series[]; height?: number; min?: number; max?: number } = $props();

  // The five colours of the system, read from the tokens at render time so themes just work.
  // Fixed order, never cycled. On a dark paper (ink theme) the two surfaces sink into the card,
  // so the light colours lead there and forest/rust take the last seats.
  const PALETTE_LIGHT = ['--surface-forest', '--surface-rust', '--ink', '--ochre', '--ink-muted'];
  const PALETTE_DARK = ['--ink', '--ochre', '--ink-muted', '--surface-rust', '--surface-forest'];

  let host: HTMLDivElement;
  let plot: uPlot | null = null;
  let width = $state(0);

  const fmt = (v: number | null) => (v === null || v === undefined ? '–' : `${Math.round(v * 10) / 10}${unit ? ' ' + unit : ''}`);

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

  function build() {
    plot?.destroy();
    plot = null;
    if (!host || width < 40 || !series.length) return;
    const palette = (isDarkPaper() ? PALETTE_DARK : PALETTE_LIGHT).map(css);
    const shown = series.slice(0, palette.length);
    const joined = uPlot.join(shown.map((s) => [s.points.map((p) => p[0]), s.points.map((p) => p[1])] as uPlot.AlignedData));
    const axisColor = css('--ink-faint');
    const grid = css('--line');
    const axisFont = `12px ${css('--font-mono')}`;

    const opts: uPlot.Options = {
      width,
      height,
      title,
      cursor: { drag: { x: true, y: false }, points: { size: 8 } },
      legend: { live: true },
      scales: { x: { time: true }, y: { range: rangeFn } },
      axes: [
        { stroke: axisColor, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1 }, font: axisFont },
        {
          stroke: axisColor,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid, width: 1 },
          font: axisFont,
          size: 56,
          values: (_u, vals) => vals.map((v) => `${v}${unit ? ' ' + unit : ''}`),
        },
      ],
      series: [
        { label: 'tid', value: (_u, v) => (v === null ? '' : new Date(v * 1000).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' })) },
        ...shown.map((s, i) => ({
          label: s.label,
          stroke: palette[i % palette.length]!,
          width: 2,
          spanGaps: true,
          value: (_u: uPlot, v: number | null) => fmt(v),
          ...(s.stepped ? { paths: uPlot.paths.stepped!({ align: 1 }) } : {}),
        })),
      ],
    };
    plot = new uPlot(opts, joined, host);
  }

  function rangeFn(_u: uPlot, dataMin: number | null, dataMax: number | null): uPlot.Range.MinMax {
    if (dataMin === null || dataMax === null) return [min ?? 0, max ?? 1];
    let lo = min ?? dataMin;
    let hi = max ?? dataMax;
    if (min === undefined && max === undefined) {
      const pad = (hi - lo || 1) * 0.08;
      lo -= pad;
      hi += pad;
    }
    return [lo, hi];
  }

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
    void series;
    void width;
    void unit;
    build();
  });
</script>

<div class="card chart">
  <div class="host" bind:this={host}></div>
  {#if !series.length}
    <div class="empty small">{title}: inga data i det här intervallet</div>
  {/if}
</div>

<style>
  .chart {
    padding: var(--space-4) var(--space-2) var(--space-2);
    overflow: hidden;
  }
  .host {
    width: 100%;
  }
  .small {
    padding: var(--space-4) 0;
  }
  .chart :global(.u-title) {
    font-family: var(--font-ui);
    font-size: 14px;
    line-height: 1.5;
    font-weight: 600;
    color: var(--ink);
    text-align: left;
    padding-left: var(--space-2);
  }
</style>
