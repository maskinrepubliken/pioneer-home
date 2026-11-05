<script lang="ts">
  /**
   * The week schedule (week.tsv) as a grid to paint: 24 hours down, Monday to Sunday across. Choose a mode as the
   * brush and tap or drag over hours; each hour has one mode. Where the mode changes, the new mode's first hour is a
   * transition by itself (both modes, drawn split; lib/week.ts inForce, as the engine does). Saved through
   * PUT /api/tables/week.tsv, which validates first. Each mode has its own fill and letter, so the grid reads on an
   * e-ink panel too. The modes themselves are edited on the Lägen page. The grid only paints after Redigera: until
   * then a touch scrolls the page as usual (on a phone the grid would otherwise take every swipe).
   */
  import { saveTable } from '../lib/api';
  import { heatModes } from '../lib/heat';
  import { home, notify } from '../lib/state.svelte';
  import { DAY_NAMES, inForce, parseWeek, serializeWeek, slotOf, type WeekGrid } from '../lib/week';

  const modes = $derived(heatModes(Object.values(home.cells)));
  const original = $derived(home.tables?.files?.['week.tsv'] ?? '');
  let grid = $state<WeekGrid>(parseWeek(''));
  /** painted since the last load or save */
  let dirty = $state(false);
  $effect(() => {
    // a fresh copy whenever the saved table changes (loaded, saved, edited elsewhere) and nothing is being edited
    const text = original;
    if (!dirty) grid = parseWeek(text);
  });

  let editing = $state(false);
  let brush = $state<string | null>(null);
  $effect(() => {
    if (brush === null && modes.length) brush = modes[0]!.id;
  });

  /** Fills by a mode's place in the list: light, dark, outlined; a letter on each. Same order as MODE_FILLS (lib/week.ts). */
  const FILLS = ['ochre', 'ink', 'line', 'forest', 'rust'];
  const fill = (id: string) => FILLS[Math.max(0, modes.findIndex((m) => m.id === id)) % FILLS.length];
  const letter = (id: string) => (modes.find((m) => m.id === id)?.name ?? id).slice(0, 1).toUpperCase();
  const nameOf = (id: string) => modes.find((m) => m.id === id)?.name ?? id;

  function paint(day: number, hour: number) {
    if (!brush) return;
    const cur = grid[day]![hour]!;
    const next = [brush];
    if (next.join(' ') !== cur.join(' ')) {
      grid[day]![hour] = next;
      dirty = true;
    }
  }

  let painting = false;
  let lastCell = '';
  function cellAt(x: number, y: number): { day: number; hour: number } | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const d = el?.closest<HTMLElement>('[data-day]');
    return d ? { day: Number(d.dataset['day']), hour: Number(d.dataset['hour']) } : null;
  }
  function down(e: PointerEvent) {
    if (!editing) return;
    const c = cellAt(e.clientX, e.clientY);
    if (!c) return;
    painting = true;
    lastCell = `${c.day}:${c.hour}`;
    paint(c.day, c.hour);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function move(e: PointerEvent) {
    if (!painting) return;
    const c = cellAt(e.clientX, e.clientY);
    if (!c || `${c.day}:${c.hour}` === lastCell) return;
    lastCell = `${c.day}:${c.hour}`;
    paint(c.day, c.hour);
  }
  function up() {
    painting = false;
  }

  let saving = $state(false);
  let errors = $state<string[]>([]);
  async function save() {
    saving = true;
    errors = [];
    try {
      const res = await saveTable('week.tsv', serializeWeek(grid, original), { message: 'veckoschemat ändrat på sidan Program' });
      if (res.status === 422) errors = res.errors.map((er) => `rad ${er.line}: ${er.message}`);
      else if (!res.ok) errors = [`sparat, men motorn kunde inte läsa in det: ${res.reloadError ?? 'okänt fel'}`];
      else {
        dirty = false; // the saved table comes back through the config event and is loaded then
        editing = false;
        notify('Veckoschemat är sparat.');
      }
    } catch (e) {
      errors = [(e as Error).message];
    }
    saving = false;
  }
  function revert() {
    grid = parseWeek(original);
    dirty = false;
    errors = [];
    editing = false;
  }

  const now = $derived(slotOf(home.now));
</script>

<section class="week" aria-labelledby="h-week">
  <header class="head">
    <h2 id="h-week">Veckoschema</h2>
    {#if editing}<span class="faint small">tryck eller dra över timmarna</span>{/if}
  </header>
  {#if editing}
  <div class="tools" role="toolbar" aria-label="Pensel">
    {#each modes as m (m.id)}
      <button class="btn small brush" class:on={brush === m.id} aria-pressed={brush === m.id} onclick={() => (brush = m.id)}>
        <span class="sw {fill(m.id)}" aria-hidden="true">{letter(m.id)}</span>{m.name}
      </button>
    {/each}
    <a class="small edit" href="#/modes">Redigera lägen</a>
  </div>
  {/if}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="grid" class:editing onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up}>
    <span></span>
    {#each DAY_NAMES as d, i (d)}<span class="day" class:today={i === now.day}>{d}</span>{/each}
    {#each Array.from({ length: 24 }, (_, h) => h) as h (h)}
      <span class="hour">{String(h).padStart(2, '0')}</span>
      {#each DAY_NAMES as _, day (day)}
        {@const cell = inForce(grid, day, h)}
        <span
          class="cell"
          class:now={day === now.day && h === now.hour}
          data-day={day}
          data-hour={h}
          title="{DAY_NAMES[day]} {String(h).padStart(2, '0')}: {cell.length ? cell.map(nameOf).join(' + ') : 'inget läge'}"
        >
          {#each cell as m (m)}<span class="part {fill(m)}">{letter(m)}</span>{/each}
        </span>
      {/each}
    {/each}
  </div>

  <p class="legend small">
    {#each modes as m (m.id)}<span><span class="sw {fill(m.id)}" aria-hidden="true">{letter(m.id)}</span>{m.name}</span>{/each}
    <span>delad ruta = övergång, första timmen efter ett byte (det varmaste läget minus {home.cells['heat_overlap_slack']?.value ?? 1} °C)</span>
  </p>
  {#if errors.length}<p class="errors" role="alert">{errors.join(' · ')}</p>{/if}
  <div class="actions">
    {#if editing}
      <button class="btn primary" disabled={!dirty || saving} onclick={save}>{saving ? 'Sparar…' : 'Spara'}</button>
      <button class="btn" disabled={saving} onclick={revert}>{dirty ? 'Ångra' : 'Klar'}</button>
      {#if dirty}<span class="small">ändrat, inte sparat</span>{/if}
    {:else}
      <button class="btn" onclick={() => (editing = true)}>Redigera</button>
    {/if}
  </div>
</section>

<style>
  .week {
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
  }
  h2 {
    font-family: var(--font-display);
    font-size: 16px;
    line-height: 1.1;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0;
  }
  .tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }
  .brush.on {
    background: var(--ink);
    color: var(--paper);
    border-color: var(--ink);
  }
  .edit {
    margin-left: auto;
  }
  .grid {
    display: grid;
    grid-template-columns: 26px repeat(7, minmax(0, 1fr));
    gap: 2px;
    max-width: 560px;
  }
  /* painting: a swipe paints instead of scrolling */
  .grid.editing {
    touch-action: none;
    user-select: none;
  }
  .grid.editing .cell {
    cursor: pointer;
  }
  .day,
  .hour {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--ink-faint);
    text-align: center;
    line-height: 20px;
  }
  .day.today {
    color: var(--ink);
    font-weight: 600;
    text-decoration: underline;
  }
  .cell {
    display: flex;
    height: 20px;
    border: 1px solid var(--line);
    border-radius: 3px;
    overflow: hidden;
    background: var(--paper);
  }
  .cell.now {
    outline: 2px solid var(--ink);
    outline-offset: 1px;
  }
  .part {
    flex: 1 1 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    min-width: 0;
  }
  .part + .part {
    border-left: 1px solid var(--paper);
  }
  .ochre {
    background: var(--ochre);
    color: var(--on-ochre);
  }
  .ink {
    background: var(--ink);
    color: var(--paper);
  }
  .line {
    background: var(--paper-sunken);
    color: var(--ink);
    outline: 1px solid var(--line-strong);
    outline-offset: -1px;
  }
  .forest {
    background: var(--surface-forest);
    color: var(--on-dark);
  }
  .rust {
    background: var(--surface-rust);
    color: var(--on-dark);
  }
  .sw {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 16px;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    margin-right: 5px;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
    margin: var(--space-3) 0 0;
    color: var(--ink-muted);
  }
  .legend > span {
    display: inline-flex;
    align-items: center;
  }
  .errors {
    color: var(--alarm);
    font-size: 13px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }
  .small {
    font-size: 12px;
    line-height: 1.5;
  }
</style>
