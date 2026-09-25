<script lang="ts">
  import type { Trace } from '../lib/api';
  import { clock, dateTime, formatTraceValue, sequenceEvent } from '../lib/format';

  let { trace, open = false }: { trace: Trace; open?: boolean } = $props();

  // svelte-ignore state_referenced_locally
  let expanded = $state(open);
  const fired = $derived(trace.rules.filter((r) => r.fired));
  const quiet = $derived(fired.length === 0 && trace.actions.length === 0 && trace.errors.length === 0);
  const dateStr = $derived(dateTime(trace.at));
</script>

<article class="card trace" class:quiet class:has-error={trace.errors.length > 0}>
  <button class="head" onclick={() => (expanded = !expanded)} aria-expanded={expanded}>
    <span class="time mono" title={dateStr}>{clock(trace.at)}</span>
    <span class="cause">{trace.cause}</span>
    <span class="badges">
      {#if trace.changed.length}<span class="pill neutral">{trace.changed.length} ändrade</span>{/if}
      {#if trace.derived.length}<span class="pill neutral">{trace.derived.length} beräknade</span>{/if}
      {#if fired.length}<span class="pill fired">{fired.length} utlösta</span>{/if}
      {#if trace.actions.length}<span class="pill on">{trace.actions.length} {trace.actions.length === 1 ? 'åtgärd' : 'åtgärder'}</span>{/if}
      {#if trace.errors.length}<span class="pill danger">{trace.errors.length} fel</span>{/if}
    </span>
    <span class="chev" class:open={expanded}>›</span>
  </button>

  {#if expanded}
    <div class="body">
      {#if trace.errors.length}
        <section>
          <h4 class="danger-text">fel</h4>
          {#each trace.errors as e, i (i)}
            <div class="row danger-text">{e}</div>
          {/each}
        </section>
      {/if}

      {#if trace.changed.length}
        <section>
          <h4>ändrade celler</h4>
          {#each trace.changed as c, i (i)}
            <div class="row mono"><span class="id">{c.cell}</span>: {formatTraceValue(c.from)} <span class="arrow">→</span> <b>{formatTraceValue(c.to)}</b></div>
          {/each}
        </section>
      {/if}

      {#if trace.derived.length}
        <section>
          <h4>beräknade celler</h4>
          {#each trace.derived as c, i (i)}
            <div class="row mono"><span class="id">{c.cell}</span>: {formatTraceValue(c.from)} <span class="arrow">→</span> <b>{formatTraceValue(c.to)}</b></div>
          {/each}
        </section>
      {/if}

      {#if trace.rules.length}
        <section>
          <h4>regler</h4>
          {#each trace.rules as r, i (i)}
            <div class="row rule" class:fired={r.fired}>
              <span class="pill" class:fired={r.fired} class:neutral={!r.fired}>{r.fired ? 'UTLÖST' : 'nej'}</span>
              <span class="mono id">{r.id}</span>
              <span class="muted reason">{r.reason}</span>
            </div>
          {/each}
        </section>
      {/if}

      {#if trace.actions.length}
        <section>
          <h4>åtgärder</h4>
          {#each trace.actions as a, i (i)}
            <div class="row action" class:err={a.error}>
              <div>
                <span class="detail">{a.detail}</span>
                <span class="faint">({a.source})</span>
                {#if a.dryRun}<span class="pill warn">torrkörning</span>{/if}
              </div>
              {#if a.topic}
                <div class="mono topic">{a.topic} <span class="payload">{a.payload ?? ''}</span></div>
              {/if}
              {#if a.error}<div class="danger-text">{a.error}</div>{/if}
            </div>
          {/each}
        </section>
      {/if}

      {#if trace.sequences.length}
        <section>
          <h4>sekvenser</h4>
          {#each trace.sequences as s, i (i)}
            <div class="row"><span class="mono id">{s.id}</span> {sequenceEvent(s.event)}{s.step !== undefined ? ` steg ${s.step}` : ''}{s.reason ? ` — ${s.reason}` : ''}</div>
          {/each}
        </section>
      {/if}

      {#if quiet && !trace.changed.length && !trace.derived.length && !trace.rules.length}
        <div class="row nothing">Inget hände i det här passet</div>
      {/if}
    </div>
  {/if}
</article>

<style>
  /* A clickable card: line-strong edge, hover swaps the head surface. */
  .trace {
    overflow: hidden;
    border-color: var(--line-strong);
  }
  .trace.quiet .head {
    color: var(--ink-muted);
  }
  .trace.has-error {
    border-color: var(--alarm);
  }
  .head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    background: var(--paper-raised);
    border: none;
    text-align: left;
    color: var(--ink);
  }
  .head:hover {
    background: var(--paper-hover);
  }
  .head:focus-visible {
    outline-offset: -2px;
  }
  .time {
    color: var(--ink-muted);
    flex-shrink: 0;
  }
  .cause {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
  }
  .badges {
    display: flex;
    gap: var(--space-1);
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .chev {
    color: var(--ink-faint);
    font-size: 20px;
    line-height: 1;
    transform: rotate(0deg);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .body {
    border-top: 1px solid var(--line);
    padding: var(--space-2) var(--space-4) var(--space-3);
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    color: var(--ink-muted);
  }
  section {
    margin: var(--space-2) 0;
  }
  /* "etikett" */
  h4 {
    margin: var(--space-1) 0;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.4;
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--ink-faint);
  }
  h4.danger-text {
    color: var(--alarm);
  }
  .row {
    padding: 2px 0;
    word-break: break-word;
  }
  .row b {
    font-weight: 400;
    color: var(--ink);
  }
  .id {
    color: var(--ink);
  }
  .arrow {
    color: var(--ink-faint);
  }
  .rule {
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
    flex-wrap: wrap;
  }
  /* "utlösta" is the one filled bricka on the card; the action badge and row pills stay outlined. */
  .badges .pill.on,
  .rule .pill.fired {
    background: var(--paper-raised);
    border-color: var(--line-strong);
    color: var(--ink);
  }
  .rule .reason {
    font-size: 12px;
  }
  .action {
    padding: var(--space-1) 0;
  }
  .detail {
    color: var(--ink);
  }
  .action.err .detail {
    color: var(--alarm);
  }
  .topic {
    color: var(--ink-muted);
    font-size: 12px;
    margin-top: 2px;
  }
  .payload {
    color: var(--ink);
  }
  /* "bildtext" */
  .nothing {
    font-family: var(--font-prose);
    font-style: italic;
    font-size: 15px;
    line-height: 1.55;
    color: var(--ink-muted);
  }
  @media (max-width: 640px) {
    .head {
      flex-wrap: wrap;
    }
    .cause {
      flex-basis: calc(100% - 90px);
    }
    .badges {
      justify-content: flex-start;
      width: 100%;
    }
    .chev {
      position: absolute;
      right: var(--space-3);
      top: var(--space-2);
    }
    .trace {
      position: relative;
    }
  }
</style>
