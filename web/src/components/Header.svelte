<script lang="ts">
  import { home } from '../lib/state.svelte';
  import type { View } from '../lib/routes';

  let { view }: { view: View } = $props();

  const NAV: { id: View; label: string }[] = [
    { id: 'heat', label: 'Värme' },
    { id: 'program', label: 'Program' },
    { id: 'rooms', label: 'Rum' },
    { id: 'tables', label: 'Tabeller' },
    { id: 'trace', label: 'Logg' },
    { id: 'history', label: 'Grafer' },
    { id: 'costs', label: 'Kostnader' },
  ];


  /** The house's name: setting `title` in settings.tsv, "pioneer-home" when it is empty. Also the browser tab title. */
  const title = $derived.by(() => {
    const v = home.cells['title']?.value;
    return typeof v === 'string' && v.trim() ? v.trim() : 'pioneer-home';
  });
  $effect(() => {
    document.title = title;
  });

  /** The header's height as the CSS variable --header-h, so sticky parts of a page (HeatStrips' readout) sit under it. */
  let headerEl = $state<HTMLElement | null>(null);
  $effect(() => {
    if (!headerEl) return;
    const set = () => document.documentElement.style.setProperty('--header-h', `${headerEl!.offsetHeight}px`);
    const ro = new ResizeObserver(set);
    ro.observe(headerEl);
    set();
    return () => ro.disconnect();
  });

  /** The system's icon, far left: a link to the setting `start_url` (a start page for all the home's services) when there is one. */
  const startUrl = $derived.by(() => {
    const v = home.cells['start_url']?.value;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  });
</script>

<header bind:this={headerEl}>
  <div class="bar">
    {#if startUrl}
      <a class="icon" href={startUrl} title="Startsidan" aria-label="Startsidan"><img src="./favicon.svg" alt="" width="28" height="28" /></a>
    {:else}
      <img class="icon" src="./favicon.svg" alt="" width="28" height="28" />
    {/if}
    <a class="brand" href="#/heat" aria-label={title}>
      <span class="dot" class:ok={home.connected} title={home.connected ? 'ansluten' : 'frånkopplad, återansluter…'}></span>
      <span class="title">{title}</span>
      <span class="conn">{home.connected ? 'ansluten' : 'frånkopplad'}</span>
    </a>
    <nav>
      {#each NAV as n (n.id)}
        {@const on = view === n.id || (n.id === 'program' && view === 'modes')}
        <a href={'#/' + n.id} class:active={on} aria-current={on ? 'page' : undefined}>{n.label}</a>
      {/each}
    </nav>
    <div class="status">
      {#if home.health?.dryRun}
        <span class="pill warn" title="DRY_RUN=true: åtgärder loggas men skickas inte">TORRKÖRNING</span>
      {/if}
    </div>
  </div>
  {#if home.configError}
    <div class="banner" role="alert">
      <strong>Konfigurationsfel</strong>
      <code>{home.configError}</code>
    </div>
  {/if}
</header>

<style>
  /* The light nav variant: paper with a line rule below. */
  header {
    position: sticky;
    top: 0;
    z-index: 20;
    background: var(--paper);
    border-bottom: 1px solid var(--line);
    padding-top: env(safe-area-inset-top);
  }
  .bar {
    max-width: 1200px;
    margin: 0 auto;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-4);
    padding: var(--space-2) var(--space-5);
  }
  @media (min-width: 1000px) {
    .bar {
      padding-left: var(--space-10);
      padding-right: var(--space-10);
    }
  }
  .icon {
    display: inline-flex;
    flex-shrink: 0;
    border-radius: var(--radius-s);
  }
  a.icon:hover {
    background: var(--paper-hover);
  }
  a.icon:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  /* the icon and the name sit together, the nav keeps its own gap */
  .icon + .brand {
    margin-left: calc(-1 * var(--space-2));
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--ink);
    text-decoration: none;
  }
  .title {
    font-family: var(--font-display);
    font-weight: 900;
    font-size: 18px;
    line-height: 1;
    letter-spacing: -0.01em;
    text-transform: uppercase;
  }
  /* A hole in the card: filled (ochre) when connected, empty when not. */
  .dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--paper);
    border: 1px solid var(--line-strong);
    flex-shrink: 0;
  }
  .dot.ok {
    background: var(--ochre);
  }
  .conn {
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.4;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  nav {
    display: flex;
    gap: var(--space-4);
  }
  nav a {
    padding: var(--space-1) 0;
    border-bottom: 2px solid transparent;
    color: var(--ink);
    text-decoration: none;
    font-family: var(--font-ui);
    font-size: 15px;
    line-height: 1.4;
  }
  nav a:hover,
  nav a.active {
    border-bottom-color: currentColor;
  }
  .status {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .banner {
    background: var(--paper-sunken);
    color: var(--alarm);
    border-top: 1px solid var(--alarm);
    padding: var(--space-2) var(--space-5);
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
    align-items: baseline;
    font-size: 14px;
    line-height: 1.5;
  }
  .banner code {
    color: var(--ink);
    white-space: pre-wrap;
    word-break: break-word;
  }
  @media (max-width: 640px) {
    .bar {
      padding: var(--space-2) var(--space-3);
    }
    .title {
      display: none;
    }
    nav {
      order: 3;
      width: 100%;
      justify-content: space-around;
      gap: var(--space-1);
    }
    nav a {
      flex: 1;
      text-align: center;
    }
    .status {
      margin-left: auto;
    }
  }
</style>
