<script lang="ts">
  import { onMount } from 'svelte';
  import Header from './components/Header.svelte';
  import Live from './views/Live.svelte';
  import Tables from './views/Tables.svelte';
  import Trace from './views/Trace.svelte';
  import History from './views/History.svelte';
  import { home, startHome } from './lib/state.svelte';
  import { closeEdit, isDirty, showGuard, tableEdit } from './lib/tableEdit.svelte';
  import { parseRoute, tableHash, type Route } from './lib/routes';

  let route = $state<Route>(parseRoute());

  onMount(() => {
    const onHash = () => {
      const next = parseRoute();
      const editing = tableEdit.current?.file ?? null;
      // Unsaved table edits: stay on that table and tell the user, the edit is kept.
      if (editing && isDirty() && !(next.view === 'tables' && next.file === editing)) {
        history.replaceState(null, '', tableHash(editing));
        showGuard(next.view === 'tables' ? (next.file ? 'byter tabell' : 'går till översikten') : 'byter vy');
        return;
      }
      // A clean editor for another table is simply closed; the next table page starts its own.
      if (editing && (next.view !== 'tables' || next.file !== editing)) closeEdit();
      route = next;
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isDirty()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('beforeunload', onBeforeUnload);
    const stop = startHome();
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('beforeunload', onBeforeUnload);
      stop();
    };
  });
</script>

<Header view={route.view} />

<main class="page">
  {#if route.view === 'live'}
    <Live />
  {:else if route.view === 'tables'}
    <Tables file={route.file} />
  {:else if route.view === 'trace'}
    <Trace />
  {:else}
    <History />
  {/if}
</main>

{#if home.notice}
  <div class="notice" class:error={home.notice.error} role="status">{home.notice.text}</div>
{/if}
