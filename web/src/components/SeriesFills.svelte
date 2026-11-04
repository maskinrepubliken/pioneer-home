<script lang="ts" module>
  /**
   * Fills for categorical bar series, readable on an e-ink panel: the dark colours first (on a greyscale or Kaleido
   * glass forest, rust and alarm become almost the same grey and ochre fades, see web/design/eink.md), and every
   * series after the first also carries a texture of paper-coloured lines or dots, so stacked series stay apart
   * without colour. Render <SeriesFills prefix=... /> once per chart, then fill marks and legend swatches with
   * seriesFill(prefix, i). Colours follow the series index; callers keep that index stable per entity.
   */
  export const SERIES_TOKENS = ['--ink', '--surface-forest', '--surface-rust', '--ink-muted', '--ochre'];
  type Texture = 'solid' | 'diag' | 'dots' | 'antidiag';
  const TEXTURES: Texture[] = ['solid', 'diag', 'dots', 'antidiag', 'solid'];

  export function seriesFill(prefix: string, i: number): string {
    const k = i % SERIES_TOKENS.length;
    return TEXTURES[k] === 'solid' ? `var(${SERIES_TOKENS[k]})` : `url(#${prefix}-${k})`;
  }
</script>

<script lang="ts">
  let { prefix }: { prefix: string } = $props();
</script>

<svg class="defs" width="0" height="0" aria-hidden="true" focusable="false">
  <defs>
    {#each SERIES_TOKENS as token, k (token)}
      {#if TEXTURES[k] === 'diag' || TEXTURES[k] === 'antidiag'}
        <pattern id="{prefix}-{k}" patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate({TEXTURES[k] === 'diag' ? 45 : -45})">
          <rect width="7" height="7" fill="var({token})" />
          <line x1="3.5" y1="0" x2="3.5" y2="7" stroke="var(--paper-raised)" stroke-width="1.2" />
        </pattern>
      {:else if TEXTURES[k] === 'dots'}
        <pattern id="{prefix}-{k}" patternUnits="userSpaceOnUse" width="6" height="6">
          <rect width="6" height="6" fill="var({token})" />
          <circle cx="3" cy="3" r="0.9" fill="var(--paper-raised)" />
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
