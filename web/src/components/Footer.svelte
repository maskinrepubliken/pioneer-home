<script lang="ts">
  /** Footer on every page: links to the other services on the Pi (settings z2m_frontend, pocketbase_admin). */
  import { SERVICES, serviceUrl } from '../lib/services';
  import { home } from '../lib/state.svelte';
</script>

<footer>
  <nav aria-label="Tjänster på Pi:n">
    {#each SERVICES as s (s.key)}
      <a href={serviceUrl(home.cells, s.key, s.fallback)} target="_blank" rel="noopener" title={s.what}>{s.label} ↗<span class="sr">(öppnas i ny flik)</span></a>
    {/each}
  </nav>
</footer>

<style>
  footer {
    border-top: 1px solid var(--line);
    margin-top: var(--space-8);
    padding: var(--space-4) var(--space-5) calc(var(--space-4) + env(safe-area-inset-bottom));
  }
  nav {
    max-width: 1200px;
    margin: 0 auto;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-2) var(--space-5);
  }
  a {
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    color: var(--ink-muted);
    text-decoration: none;
    border-bottom: 1px solid var(--line-strong);
  }
  a:hover {
    color: var(--ink);
    border-bottom-color: currentColor;
  }
  a:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @media (min-width: 1000px) {
    footer {
      padding-left: var(--space-10);
      padding-right: var(--space-10);
    }
  }
</style>
