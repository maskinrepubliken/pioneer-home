<script lang="ts" module>
  /**
   * Fills for categorical bar series, readable on a colour e-ink panel: every series has its own colour AND its own
   * pattern, so it stays apart when the glass mutes the colours (forest, rust and alarm become almost the same grey
   * there and ochre fades, see web/design/eink.md). Patterns are coarse and axis-aligned and drawn without
   * anti-aliasing (crispEdges): thin diagonal lines and small round dots turn to mush on the glass. Ochre carries
   * dark dots so it never washes out. Render <SeriesFills prefix=... /> once per chart, then fill marks and legend
   * swatches with seriesFill(prefix, i); callers keep i stable per entity (lib/cost.ts applianceOrder).
   */
  interface Style {
    colour: string;
    /** solid, or paper stripes / ink squares on the colour */
    texture: 'solid' | 'stripes' | 'squares';
  }
  const STYLES: Style[] = [
    { colour: '--ink', texture: 'solid' },
    { colour: '--surface-forest', texture: 'stripes' },
    { colour: '--ochre', texture: 'squares' },
    { colour: '--surface-rust', texture: 'solid' },
    { colour: '--ink-muted', texture: 'stripes' },
  ];

  export function seriesFill(prefix: string, i: number): string {
    const k = ((i % STYLES.length) + STYLES.length) % STYLES.length;
    return STYLES[k]!.texture === 'solid' ? `var(${STYLES[k]!.colour})` : `url(#${prefix}-${k})`;
  }
</script>

<script lang="ts">
  let { prefix }: { prefix: string } = $props();
</script>

<svg class="defs" width="0" height="0" aria-hidden="true" focusable="false">
  <defs>
    {#each STYLES as st, k (k)}
      {#if st.texture === 'stripes'}
        <pattern id="{prefix}-{k}" patternUnits="userSpaceOnUse" width="6" height="6">
          <rect width="6" height="6" fill="var({st.colour})" shape-rendering="crispEdges" />
          <rect y="4" width="6" height="2" fill="var(--paper-raised)" shape-rendering="crispEdges" />
        </pattern>
      {:else if st.texture === 'squares'}
        <pattern id="{prefix}-{k}" patternUnits="userSpaceOnUse" width="6" height="6">
          <rect width="6" height="6" fill="var({st.colour})" shape-rendering="crispEdges" />
          <rect x="2" y="2" width="2" height="2" fill="var(--ink)" shape-rendering="crispEdges" />
        </pattern>
      {/if}
    {/each}
  </defs>
</svg>

<style>
  .defs {
    position: absolute;
    width: 0;
    height: 0;
    overflow: hidden;
  }
</style>
