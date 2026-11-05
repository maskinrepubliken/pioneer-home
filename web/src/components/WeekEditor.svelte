<script lang="ts">
  /**
   * The week schedule (week.tsv) as a grid to paint: 24 hours down, Monday to Sunday across. Choose a mode as the
   * brush and tap or drag over hours; with "Övergång" on, the brush is added to an hour instead (two modes = a
   * transition) and taken away again when it is there. Saved through PUT /api/tables/week.tsv, which validates first.
   * Each mode has its own fill and letter, so the grid reads on an e-ink panel too.
   */
  import { saveTable } from '../lib/api';
  import { heatModes } from '../lib/heat';
  import { home, notify } from '../lib/state.svelte';
  import { DAY_NAMES, parseWeek, serializeWeek, slotOf, type WeekGrid } from '../lib/week';

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

  let brush = $state<string | null>(null);
  $effect(() => {
    if (brush === null && modes.length) brush = modes[0]!.id;
  });
  let transition = $state(false);

  /** Fills by a mode's place in the list: light, dark, outlined; a letter on each. */
  const FILLS = ['ochre', 'ink', 'line', 'forest', 'rust'];
  const fill = (id: string) => FILLS[Math.max(0, modes.findIndex((m) => m.id === id)) % FILLS.length];
  const letter = (id: string) => (modes.find((m) => m.id === id)?.name ?? id).slice(0, 1).toUpperCase();
  const nameOf = (id: string) => modes.find((m) => m.id === id)?.name ?? id;

  function paint(day: number, hour: number, first: boolean) {
    if (!brush) return;
    const cur = grid[day]![hour]!;
    let next: string[];
    if (!transition) next = [brush];
    else if (cur.includes(brush)) next = cur.length > 1 ? cur.filter((m) => m !== brush) : cur;
    else next = [...cur.slice(-1), brush];
    // while dragging, a transition brush only adds (taking away belongs to a single tap)
    if (!first && transition && next.length < cur.length) return;
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
    const c = cellAt(e.clientX, e.clientY);
    if (!c) return;
    painting = true;
    lastCell = `${c.day}:${c.hour}`;
    paint(c.day, c.hour, true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function move(e: PointerEvent) {
    if (!painting) return;
    const c = cellAt(e.clientX, e.clientY);
    if (!c || `${c.day}:${c.hour}` === lastCell) return;
    lastCell = `${c.day}:${c.hour}`;
    paint(c.day, c.hour, false);
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
  }

  const now = $derived(slotOf(home.now));
</script>

<section class="week" aria-labelledby="h-week">
  <header class="head">
    <h2 id="h-week">Veckoschema</h2>
    <span class="faint small">tryck eller dra över timmarna</span>
  </header>
  <div class="tools" role="toolbar" aria-label="Pensel">
    {#each modes as m (m.id)}
      <button class="btn small brush" class:on={brush === m.id} aria-pressed={brush === m.id} onclick={() => (brush = m.id)}>
        <span class="sw {fill(m.id)}" aria-hidden="true">{letter(m.id)}</span>{m.name}
      </button>
    {/each}
    <label class="trans">
      <input type="checkbox" bind:checked={transition} />
      Lägg till som övergång
    </label>
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="grid" onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up}>
    <span></span>
    {#each DAY_NAMES as d, i (d)}<span class="day" class:today={i === now.day}>{d}</span>{/each}
    {#each Array.from({ length: 24 }, (_, h) => h) as h (h)}
      <span class="hour">{String(h).padStart(2, '0')}</span>
      {#each DAY_NAMES as _, day (day)}
        {@const cell = grid[day]![h]!}
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
    <span>två i samma timme = övergång (det varmaste läget minus en grad)</span>
  </p>
  {#if errors.length}<p class="errors" role="alert">{errors.join(' · ')}</p>{/if}
  <div class="actions">
    <button class="btn primary" disabled={!dirty || saving} onclick={save}>{saving ? 'Sparar…' : 'Spara'}</button>
    <button class="btn" disabled={!dirty || saving} onclick={revert}>Ångra</button>
    {#if dirty}<span class="small">ändrat, inte sparat</span>{/if}
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
  .trans {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-size: 14px;
  }
  .grid {
    display: grid;
    grid-template-columns: 26px repeat(7, minmax(0, 1fr));
    gap: 2px;
    touch-action: none;
    user-select: none;
    max-width: 560px;
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
    cursor: pointer;
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
