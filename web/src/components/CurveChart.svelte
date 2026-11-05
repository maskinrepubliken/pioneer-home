<script lang="ts">
  /**
   * A heating curve: the power a room needs to hold its temperature (y, kW) against the outdoor temperature (x, °C),
   * as the learnt model's line, with the hours the model was learnt from as dots (mean heating power in that hour).
   * Plain SVG in pixels: ink line, ink-muted dots, so it reads on an e-ink panel.
   */
  let {
    curve,
    observed = [],
    title,
    xMin = -15,
    xMax = 15,
  }: { curve: { tout: number; kw: number }[]; observed?: { tout: number; kw: number }[]; title: string; xMin?: number; xMax?: number } = $props();

  let width = $state(0);
  const H = 180;
  const L = 40;
  const B = 22;
  const T = 8;
  const R = 8;
  const top = $derived.by(() => {
    const max = Math.max(0.5, ...curve.map((p) => p.kw), ...observed.map((p) => p.kw));
    const p = Math.pow(10, Math.floor(Math.log10(max)));
    return [1, 2, 2.5, 5, 10].map((f) => f * p).find((v) => v >= max) ?? max;
  });
  const x = (v: number) => L + ((v - xMin) / (xMax - xMin)) * Math.max(width - L - R, 1);
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const path = $derived(curve.map((p, i) => `${i ? 'L' : 'M'}${x(p.tout).toFixed(1)},${y(p.kw).toFixed(1)}`).join(''));
  const xticks = $derived([-15, -10, -5, 0, 5, 10, 15].filter((v) => v >= xMin && v <= xMax));
  const num = (v: number) => v.toLocaleString('sv-SE', { maximumFractionDigits: 1 });
  const inside = $derived(observed.filter((p) => p.tout >= xMin && p.tout <= xMax));
</script>

<figure class="curve" bind:clientWidth={width}>
  <figcaption>{title} <span class="unit">kW mot utetemperatur</span></figcaption>
  {#if width > 0}
    <svg {width} height={H} role="img" aria-label="{title}: {curve.map((p) => `${num(p.tout)} °C ute ${num(p.kw)} kW`).join(', ')}">
      <line class="grid" x1={L} x2={width - R} y1={y(top / 2)} y2={y(top / 2)} />
      <line class="base" x1={L} x2={width - R} y1={y(0)} y2={y(0)} />
      <line class="grid" x1={x(0)} x2={x(0)} y1={T} y2={y(0)} />
      <text class="ax" x={L - 6} y={y(top) + 4}>{num(top)}</text>
      <text class="ax" x={L - 6} y={y(top / 2) + 4}>{num(top / 2)}</text>
      <text class="ax" x={L - 6} y={y(0) + 4}>0</text>
      {#each xticks as v (v)}
        <text class="xt" x={x(v)} y={H - 6}>{v}°</text>
      {/each}
      {#each inside as p, i (i)}
        <circle class="dot" cx={x(p.tout)} cy={y(Math.min(p.kw, top))} r="2" />
      {/each}
      <path class="line" d={path} />
    </svg>
  {/if}
  <p class="legend"><span class="sw line"></span> modellen <span class="sw dot"></span> uppmätta timmar</p>
</figure>

<style>
  .curve {
    margin: 0;
    min-width: 0;
  }
  figcaption {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: var(--space-1);
  }
  .unit {
    font-weight: 400;
    color: var(--ink-faint);
  }
  svg {
    display: block;
  }
  .grid {
    stroke: var(--line);
    stroke-dasharray: 2 3;
  }
  .base {
    stroke: var(--line-strong);
  }
  .ax,
  .xt {
    font-family: var(--font-mono);
    font-size: 10px;
    fill: var(--ink-faint);
  }
  .ax {
    text-anchor: end;
  }
  .xt {
    text-anchor: middle;
  }
  .dot {
    fill: var(--ink-muted);
  }
  .line {
    fill: none;
    stroke: var(--ink);
    stroke-width: 2.5;
    stroke-linejoin: round;
  }
  .legend {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-1) 0 0;
    font-size: 12px;
    color: var(--ink-muted);
  }
  .sw {
    display: inline-block;
  }
  .sw.line {
    width: 16px;
    height: 2.5px;
    background: var(--ink);
  }
  .sw.dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ink-muted);
    margin-left: var(--space-2);
  }
</style>
