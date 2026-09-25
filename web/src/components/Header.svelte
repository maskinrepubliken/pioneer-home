<script lang="ts">
  import { home, sendAction } from '../lib/state.svelte';
  import type { View } from '../lib/routes';

  let { view }: { view: View } = $props();

  const NAV: { id: View; label: string }[] = [
    { id: 'live', label: 'Live' },
    { id: 'tables', label: 'Tabeller' },
    { id: 'trace', label: 'Spår' },
    { id: 'history', label: 'Historik' },
  ];

  let busy = $state<string | null>(null);
  async function start(seq: string) {
    busy = seq;
    await sendAction(`start ${seq}`);
    busy = null;
  }
  const sequences = $derived(home.tables?.sequences ?? []);
</script>

<header>
  <div class="bar">
    <a class="brand" href="#/live" aria-label="pioneer-home">
      <span class="dot" class:ok={home.connected} title={home.connected ? 'ansluten' : 'frånkopplad, återansluter…'}></span>
      <span class="title">pioneer-home</span>
      <span class="conn">{home.connected ? 'ansluten' : 'frånkopplad'}</span>
    </a>
    <nav>
      {#each NAV as n (n.id)}
        <a href={'#/' + n.id} class:active={view === n.id} aria-current={view === n.id ? 'page' : undefined}>{n.label}</a>
      {/each}
    </nav>
    <div class="status">
      {#if home.health?.dryRun}
        <span class="pill warn" title="DRY_RUN=true: åtgärder loggas men skickas inte">TORRKÖRNING</span>
      {/if}
      {#each sequences as seq (seq)}
        <button class="btn small" disabled={busy !== null} title={'Starta ' + seq} onclick={() => start(seq)}>▶ {seq}</button>
      {/each}
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
