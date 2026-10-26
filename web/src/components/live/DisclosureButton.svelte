<script lang="ts">
  /** Button that opens/closes a remembered disclosure (see lib/disclosure.svelte.ts). */
  import { disclosureId, isOpen, toggleOpen } from '../../lib/disclosure.svelte';
  import Icon from './Icon.svelte';

  /** compact = round icon-only info button; otherwise a pill with a chevron and `text`. */
  let { key, text = '', label, compact = false }: { key: string; text?: string; label?: string; compact?: boolean } = $props();
  const open = $derived(isOpen(key));
</script>

<button
  class="disclosure"
  class:compact
  aria-expanded={open}
  aria-controls={disclosureId(key)}
  aria-label={label}
  title={label}
  onclick={() => toggleOpen(key)}
>
  {#if compact}
    <Icon name="info" size={16} />
  {:else}
    <span class="mark" class:open><Icon name="chevron" size={14} /></span>
    {text}
  {/if}
</button>

<style>
  .disclosure {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    background: var(--paper);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-pill);
    color: var(--ink-muted);
    padding: 3px 12px;
    min-height: 28px;
    font-family: var(--font-ui);
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
  }
  .disclosure:hover {
    background: var(--paper-hover);
  }
  .disclosure[aria-expanded='true'] {
    color: var(--ink);
  }
  /* Info button next to a row: deliberately quiet. No outline, a faint 16px icon; the surface only appears on
     hover and while its details are open. The focus ring (global) still marks it for keyboard use. */
  .compact {
    justify-content: center;
    padding: 0;
    width: 26px;
    min-height: 26px;
    flex-shrink: 0;
    border-color: transparent;
    background: transparent;
    color: var(--ink-faint);
  }
  .compact:hover {
    background: var(--paper-hover);
    color: var(--ink-muted);
  }
  .compact[aria-expanded='true'] {
    background: var(--paper-sunken);
    border-color: var(--line);
    color: var(--ink);
  }
  .mark {
    display: inline-flex;
  }
  .mark.open {
    transform: rotate(90deg);
  }

</style>
