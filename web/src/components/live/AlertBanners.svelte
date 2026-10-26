<script lang="ts">
  /**
   * Banners from alerts.tsv at the top of Live, most severe first. The level is carried by the symbol's shape
   * (octagon for danger, triangle for warning, circle for info) and a hidden word for screen readers; the surface
   * only reinforces it: alarm for danger, ochre for warning, a raised paper card for info. A room name jumps to
   * that room's panel.
   */
  import type { LiveAlert } from '../../lib/live';
  import { roomName } from '../../lib/format';
  import { home } from '../../lib/state.svelte';
  import Icon from './Icon.svelte';

  let { alerts }: { alerts: LiveAlert[] } = $props();

  const WORD = { danger: 'Fara', warning: 'Varning', info: 'Info' } as const;
  const ICON = { danger: 'danger', warning: 'alert', info: 'info' } as const;

  function show(room: string) {
    document.getElementById(`room-${room}`)?.scrollIntoView({ block: 'start' });
  }
</script>

{#if alerts.length}
  <ul class="alerts" aria-label="Larm och varningar">
    {#each alerts as a (a.id)}
      <li class="alert {a.level}" role={a.level === 'info' ? 'status' : 'alert'}>
        <span class="icon" aria-hidden="true"><Icon name={ICON[a.level]} size={24} /></span>
        <span class="sr">{WORD[a.level]}:</span>
        <span class="text">{a.text}</span>
        {#if a.room}
          <button class="room" onclick={() => show(a.room!)}>{roomName(a.room, home.rooms)} →</button>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .alerts {
    list-style: none;
    margin: 0 0 var(--space-5);
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .alert {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-m);
    border: 1px solid var(--line);
    background: var(--paper-raised);
    color: var(--ink);
  }
  .alert.danger {
    background: var(--alarm);
    border-color: var(--alarm);
    color: var(--on-dark);
  }
  .alert.warning {
    background: var(--ochre);
    border-color: var(--ochre);
    color: var(--on-ochre);
  }
  .icon {
    display: inline-flex;
    flex-shrink: 0;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .text {
    flex: 1 1 16em;
    min-width: 0;
    font-family: var(--font-ui);
    font-size: 16px;
    line-height: 1.4;
    font-weight: 600;
  }
  .room {
    font: inherit;
    font-family: var(--font-mono);
    font-size: 13px;
    color: inherit;
    background: none;
    border: none;
    border-bottom: 1px solid currentColor;
    padding: 0;
    cursor: pointer;
    white-space: nowrap;
  }
  .room:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .danger .room:focus-visible {
    outline-color: var(--focus-on-dark);
  }
</style>
