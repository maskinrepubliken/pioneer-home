<script lang="ts">
  /**
   * Stacked bars: cost per bucket (hour or day), one segment per appliance, in the chart palette order. Drawn as
   * SVG; the value of the hovered or focused bar is shown above the chart, so it reads without a legend lookup.
   */
  import { kr } from '../lib/cost';

  let {
    labels,
    series,
    buckets,
    tickEvery = 1,
  }: { labels: string[]; series: { label: string; values: number[] }[]; buckets: string[]; tickEvery?: number } = $props();

  const PALETTE = ['--surface-forest', '--ochre', '--surface-rust', '--ink', '--ink-muted'];
  const colours = PALETTE.map((p) => `var(${p})`);

  const totals = $derived(buckets.map((_, i) => series.reduce((n, s) => n + (s.values[i] ?? 0), 0)));
  const max = $derived(Math.max(...totals, 0.01));
  /** A round axis top: 1, 2 or 5 times a power of ten above the largest bar. */
  const top = $derived.by(() => {
    const p = Math.pow(10, Math.floor(Math.log10(max)));
    return [1, 2, 5, 10].map((f) => f * p).find((v) => v >= max) ?? max;
  });
  let active = $state<number | null>(null);
  const W = 100;
  const H = 40;
  const bw = $derived(W / Math.max(buckets.length, 1));
</script>

<figure class="bars">
  <figcaption>
    <span class="title">Kostnad per {labels[0]}<span class="unit">, kr</span></span>
    <span class="when">
      {#if active !== null}{buckets[active]}: <b class="value">{kr(totals[active] ?? 0)}</b>{:else}håll över en stapel{/if}
    </span>
  </figcaption>
  <div class="plot">
    <div class="axis" aria-hidden="true"><span>{kr(top)}</span><span>{kr(top / 2)}</span><span>0</span></div>
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="img" aria-label="Kostnad per {labels[0]}">
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} class="grid" />
      <line x1="0" x2={W} y1={H} y2={H} class="grid" />
      {#each buckets as b, i (i)}
        {@const x = i * bw}
        <g
          role="button"
          tabindex="0"
          aria-label="{b}: {kr(totals[i] ?? 0)}"
          onmouseenter={() => (active = i)}
          onmouseleave={() => (active = null)}
          onfocus={() => (active = i)}
          onblur={() => (active = null)}
        >
          <rect x={x} y="0" width={bw} height={H} class="hit" class:on={active === i} />
          {#each series as s, k (k)}
            {@const below = series.slice(0, k).reduce((n, o) => n + (o.values[i] ?? 0), 0)}
            {@const v = s.values[i] ?? 0}
            {#if v > 0}
              <rect x={x + bw * 0.15} width={bw * 0.7} y={H - ((below + v) / top) * H} height={(v / top) * H} fill={colours[k % colours.length]} />
            {/if}
          {/each}
        </g>
      {/each}
    </svg>
    <span></span>
    <div class="ticks" aria-hidden="true">
      {#each buckets as b, i (i)}
        {#if i % tickEvery === 0}<span style="left: {((i + 0.5) / buckets.length) * 100}%">{b}</span>{/if}
      {/each}
    </div>
  </div>
  <ul class="legend">
    {#each series as s, k (k)}
      <li><span class="sw" style="background: {colours[k % colours.length]}"></span>{s.label}</li>
    {/each}
  </ul>
</figure>

<style>
  .bars {
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
  }
  .when .value {
    font-size: 13px;
  }
  .plot {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--space-2);
  }
  .axis {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--ink-faint);
    text-align: right;
    height: 180px;
  }
  svg {
    width: 100%;
    height: 180px;
    display: block;
  }
  .grid {
    stroke: var(--line);
    stroke-width: 0.15;
    vector-effect: non-scaling-stroke;
  }
  .hit {
    fill: transparent;
  }
  .hit.on {
    fill: var(--paper-hover);
  }
  g:focus-visible {
    outline: none;
  }
  g:focus-visible .hit {
    fill: var(--paper-hover);
  }
  .ticks {
    position: relative;
    height: 18px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--ink-faint);
  }
  .ticks span {
    position: absolute;
    transform: translateX(-50%);
    white-space: nowrap;
  }
  .legend {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
    font-size: 13px;
    color: var(--ink-muted);
  }
  .legend li {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .sw {
    width: 12px;
    height: 12px;
    border-radius: 3px;
  }
</style>
