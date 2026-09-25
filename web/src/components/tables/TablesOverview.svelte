<script lang="ts">
  /**
   * The Tabeller landing page: the model in five sentences, a card per table in three groups (Huset,
   * Beteende, System: the last one a quiet single row since those tables are rarely touched), how to make a change.
   */
  import { CHANGE_STEPS, GROUP_LEAD, GROUP_ORDER, GROUP_TITLE, OVERVIEW_INTRO, TABLES, type TableDoc } from '../../lib/docs.sv';
  import { tableHash } from '../../lib/routes';
  import { home } from '../../lib/state.svelte';
  import { parseTsv } from '../../lib/tsv';
  import { openHelp } from '../../lib/help.svelte';

  const files = $derived(home.tables?.files ?? {});

  /** Data rows only: comments, blank lines and the header are not counted. */
  function rowCount(file: string): number | null {
    const text = files[file];
    if (text === undefined) return null;
    return parseTsv(text).rows.filter((r) => r.some((c) => c !== '')).length;
  }

  const documented = $derived(TABLES.filter((t) => t.file in files));
  const undocumented = $derived(Object.keys(files).filter((f) => !TABLES.some((t) => t.file === f)).sort());

  function inGroup(group: TableDoc['group']): TableDoc[] {
    return documented.filter((t) => t.group === group);
  }
</script>

<section class="intro">
  <p class="ingress">{OVERVIEW_INTRO[0]}</p>
  {#each OVERVIEW_INTRO.slice(1) as p, i (i)}
    <p>{p}</p>
  {/each}
  <p class="helplink">
    <button class="btn small" onclick={() => openHelp('formulas')}>Hjälp: formler, åtgärder och celler</button>
  </p>
</section>

{#each GROUP_ORDER as group (group)}
  {#if inGroup(group).length}
    <h2 class="group">{GROUP_TITLE[group]}</h2>
    <p class="lead">{GROUP_LEAD[group]}</p>
    {#if group === 'system'}
      <div class="cards quiet">
        {#each inGroup(group) as t (t.file)}
          <article class="card table small">
            <header>
              <h3>{t.title}</h3>
              <span class="file">{t.file}</span>
            </header>
            <p class="purpose">{t.purpose}</p>
            <footer>
              <span class="count">{rowCount(t.file) ?? '–'} {rowCount(t.file) === 1 ? 'rad' : 'rader'}</span>
              <a class="btn small" href={tableHash(t.file)}>Öppna</a>
            </footer>
          </article>
        {/each}
      </div>
    {:else}
      <div class="cards">
        {#each inGroup(group) as t (t.file)}
          <article class="card table">
            <header>
              <h3>{t.title}</h3>
              <span class="file">{t.file}</span>
            </header>
            <p class="purpose">{t.purpose}</p>
            <dl>
              <dt>När ändrar du den</dt>
              <dd>{t.whenEdit}</dd>
              <dt>Exempel</dt>
              <dd><code>{t.example}</code></dd>
            </dl>
            <footer>
              <span class="count">{rowCount(t.file) ?? '–'} {rowCount(t.file) === 1 ? 'rad' : 'rader'}</span>
              <a class="btn small" href={tableHash(t.file)}>Öppna</a>
            </footer>
          </article>
        {/each}
      </div>
    {/if}
  {/if}
{/each}

{#if undocumented.length}
  <h2 class="group">Övriga tabeller</h2>
  <div class="cards">
    {#each undocumented as f (f)}
      <article class="card table">
        <header>
          <h3>{f.replace(/\.tsv$/, '')}</h3>
          <span class="file">{f}</span>
        </header>
        <p class="purpose">Den här tabellen saknar beskrivning.</p>
        <footer>
          <span class="count">{rowCount(f) ?? '–'} rader</span>
          <a class="btn small" href={tableHash(f)}>Öppna</a>
        </footer>
      </article>
    {/each}
  </div>
{/if}

<h2 class="group">Så här gör du en ändring</h2>
<ol class="steps">
  {#each CHANGE_STEPS as s, i (i)}
    <li>
      <span class="num">{i + 1}</span>
      <div>
        <strong>{s.title}</strong>
        <p>{s.text}</p>
      </div>
    </li>
  {/each}
</ol>

<style>
  .intro {
    max-width: 66ch;
    margin: var(--space-4) 0 var(--space-2);
  }
  /* "ingress": the one Fraunces italic sentence. */
  .ingress {
    font-family: var(--font-prose);
    font-style: italic;
    font-size: 21px;
    line-height: 1.4;
    color: var(--ink);
    margin: 0 0 var(--space-3);
  }
  .intro p {
    font-size: 15px;
    line-height: 1.55;
    color: var(--ink-muted);
    margin: 0 0 var(--space-2);
  }
  .helplink {
    margin-top: var(--space-3);
  }
  .lead {
    margin: calc(-1 * var(--space-2)) 0 var(--space-3);
    font-size: 14px;
    line-height: 1.5;
    color: var(--ink-muted);
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
    gap: var(--space-4);
    align-items: stretch;
  }
  /* System: smaller cards in one row, no "when"/"example" list. */
  .cards.quiet {
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr));
    gap: var(--space-3);
    max-width: 760px;
  }
  .card.table.small {
    padding: var(--space-4) var(--space-5);
    gap: var(--space-1);
  }
  .card.table.small h3 {
    font-size: 16px;
  }
  .card.table.small .purpose {
    font-size: 14px;
    color: var(--ink-muted);
  }
  .card.table.small footer {
    margin-top: var(--space-1);
    padding-top: var(--space-2);
  }
  .card.table {
    display: flex;
    flex-direction: column;
    padding: var(--space-5) var(--space-6);
    gap: var(--space-2);
  }
  .card header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  h3 {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 18px;
    line-height: 1.2;
    margin: 0;
    color: var(--ink);
  }
  .file,
  .count {
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.4;
    color: var(--ink-faint);
  }
  .purpose {
    margin: 0;
    font-size: 15px;
    line-height: 1.5;
    color: var(--ink);
    max-width: 34ch;
  }
  dl {
    margin: 0;
    display: grid;
    grid-template-columns: auto;
    gap: 2px;
    flex: 1;
  }
  dt {
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.4;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-faint);
    margin-top: var(--space-2);
  }
  dd {
    margin: 0;
    font-size: 14px;
    line-height: 1.5;
    color: var(--ink-muted);
  }
  dd code {
    color: var(--ink);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .card footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    margin-top: var(--space-2);
    padding-top: var(--space-3);
    border-top: 1px solid var(--line);
  }
  a.btn {
    text-decoration: none;
  }
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
    gap: var(--space-4);
    max-width: 1100px;
  }
  .steps li {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    background: var(--paper-raised);
    border: 1px solid var(--line);
    border-radius: var(--radius-card);
    padding: var(--space-4) var(--space-5);
  }
  .num {
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: var(--ochre);
    color: var(--on-ochre);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono);
    font-size: 14px;
  }
  .steps strong {
    display: block;
    font-family: var(--font-ui);
    font-weight: 600;
    font-size: 15px;
    line-height: 1.4;
    color: var(--ink);
  }
  .steps p {
    margin: var(--space-1) 0 0;
    font-size: 14px;
    line-height: 1.5;
    color: var(--ink-muted);
  }
</style>
