<script lang="ts" module>
  export type IconName = 'info' | 'chevron' | 'light' | 'plug' | 'thermostat' | 'motion' | 'contact' | 'climate' | 'pwm' | 'remote' | 'heat' | 'alert' | 'danger' | 'device';
</script>

<script lang="ts">
  /**
   * Small stroke icons (1.75 px, round caps, currentColor), in the open-library style the design system allows
   * for interface icons. Keep them simple: a few strokes, no fills except dots. Add shapes here, not emoji.
   */
  let { name, size = 18 }: { name: IconName; size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  {#if name === 'info'}
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5" />
    <circle cx="12" cy="7.75" r="0.6" fill="currentColor" />
  {:else if name === 'alert'}
    <!-- warning triangle -->
    <path d="M12 3.5l9 16H3z" />
    <path d="M12 10v4.5" />
    <circle cx="12" cy="17.25" r="0.6" fill="currentColor" />
  {:else if name === 'danger'}
    <!-- filled stop octagon, exclamation mark cut out in the danger surface colour -->
    <path d="M8.3 3h7.4L21 8.3v7.4L15.7 21H8.3L3 15.7V8.3z" fill="currentColor" />
    <path d="M12 7.5v5.5" stroke="var(--alarm)" stroke-width="2.2" />
    <circle cx="12" cy="16.4" r="1.2" fill="var(--alarm)" stroke="none" />
  {:else if name === 'chevron'}
    <path d="M9 6l6 6-6 6" />
  {:else if name === 'light'}
    <!-- bulb -->
    <path d="M9 17h6M10 20.5h4" />
    <path d="M12 3.5a5.5 5.5 0 0 0-3.2 10c.7.5 1.2 1.3 1.2 2.1V17h4v-1.4c0-.8.5-1.6 1.2-2.1A5.5 5.5 0 0 0 12 3.5z" />
  {:else if name === 'plug'}
    <path d="M9 3v4M15 3v4" />
    <path d="M6.5 7h11v3a5.5 5.5 0 0 1-11 0z" />
    <path d="M12 15.5V21" />
  {:else if name === 'thermostat'}
    <!-- thermometer -->
    <path d="M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0z" />
    <path d="M12 10v7" />
  {:else if name === 'motion'}
    <!-- a figure with motion waves -->
    <circle cx="9" cy="5" r="1.6" />
    <path d="M9 8.5v6l-2.5 5.5M9 14.5l2.5 5.5M6 11h6" />
    <path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" />
  {:else if name === 'contact'}
    <!-- door -->
    <path d="M6 21V4h10v17M4 21h16" />
    <circle cx="13" cy="12.5" r="0.7" fill="currentColor" />
  {:else if name === 'climate'}
    <!-- droplet -->
    <path d="M12 3.5c3.3 4 5.5 7.1 5.5 10a5.5 5.5 0 0 1-11 0c0-2.9 2.2-6 5.5-10z" />
  {:else if name === 'pwm'}
    <!-- fan: hub and three blades -->
    <circle cx="12" cy="12" r="1.5" />
    <path d="M12 10.5C11 7 11.5 4 13.5 4s2.5 3-1.5 6.5M13.3 12.8c3.5 1 5.6 3.1 4.6 4.8s-4 .6-5.7-4.4M10.7 12.7c-2.6 2.5-5.5 3.3-6.5 1.6s1.2-3.6 6.4-3" />
  {:else if name === 'heat'}
    <!-- rising heat: three waves -->
    <path d="M8 19c-1.5-2 1.5-4 0-6s1.5-4 0-6M12 19c-1.5-2 1.5-4 0-6s1.5-4 0-6M16 19c-1.5-2 1.5-4 0-6s1.5-4 0-6" />
  {:else if name === 'remote'}
    <rect x="8" y="3" width="8" height="18" rx="3" />
    <path d="M12 7v2.5M12 14v3" />
  {:else}
    <circle cx="12" cy="12" r="8" />
  {/if}
</svg>
