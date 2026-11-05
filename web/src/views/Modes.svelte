<script lang="ts">
  /**
   * Lägen: the heating modes (modes.tsv) to edit: each mode's name and each room's temperature in it (a stepper, or
   * Kallt = heat_cold), add and remove modes, add a room. A mode the week schedule uses cannot be removed (repaint those
   * hours on Program first). Saved through PUT /api/tables/modes.tsv, which validates first. The order is the order of
   * the buttons on Värme and the brushes on Program.
   */
  import { saveTable } from '../lib/api';
  import { COLD, modeId, parseModeTable, serializeModeTable, type ModesTable } from '../lib/modes';
  import { home, notify } from '../lib/state.svelte';
  import { parseWeek } from '../lib/week';
  import { roomName } from '../lib/format';

  const original = $derived(home.tables?.files?.['modes.tsv'] ?? '');
  let table = $state<ModesTable>(parseModeTable(''));
  let dirty = $state(false);
  $effect(() => {
    const text = original;
    if (!dirty) table = parseModeTable(text);
  });
  const touch = () => (dirty = true);

  const used = $derived(new Set(parseWeek(home.tables?.files?.['week.tsv'] ?? '').flat(2)));
  const cold = $derived(typeof home.cells['heat_cold']?.value === 'number' ? (home.cells['heat_cold']!.value as number) : null);
  const slack = $derived(home.cells['heat_overlap_slack']?.value);
  const otherRooms = $derived(Object.keys(home.rooms).filter((r) => !table.rooms.includes(r)));
  const deg = (n: number) => `${n.toLocaleString('sv-SE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} °C`;

  function step(mode: number, room: string, delta: number) {
    const t = table.modes[mode]!.temps[room];
    const base = t?.kind === 'number' ? t.value : (cold ?? 12);
    table.modes[mode]!.temps[room] = { kind: 'number', value: Math.round((base + delta) * 2) / 2 };
    touch();
  }
  function setCold(mode: number, room: string) {
    table.modes[mode]!.temps[room] = { kind: 'cold' };
    touch();
  }
  let newName = $state('');
  function addMode() {
    const name = newName.trim();
    if (!name) return;
    const id = modeId(name, table.modes.map((m) => m.id));
    table.modes.push({ id, name, temps: Object.fromEntries(table.rooms.map((r) => [r, { kind: 'cold' as const }])), note: '' });
    newName = '';
    touch();
  }
  function removeMode(i: number) {
    table.modes.splice(i, 1);
    touch();
  }
  function move(i: number, d: number) {
    const j = i + d;
    if (j < 0 || j >= table.modes.length) return;
    const [m] = table.modes.splice(i, 1);
    table.modes.splice(j, 0, m!);
    touch();
  }
  let addRoom = $state('');
  function addRoomColumn() {
    if (!addRoom) return;
    table.rooms.push(addRoom);
    for (const m of table.modes) m.temps[addRoom] = { kind: 'cold' };
    addRoom = '';
    touch();
  }

  let saving = $state(false);
  let errors = $state<string[]>([]);
  async function save() {
    saving = true;
    errors = [];
    try {
      const res = await saveTable('modes.tsv', serializeModeTable(table), { message: 'lägena ändrade på sidan Lägen' });
      if (res.status === 422) errors = res.errors.map((e) => `rad ${e.line}: ${e.message}`);
      else if (!res.ok) errors = [`sparat, men motorn kunde inte läsa in det: ${res.reloadError ?? 'okänt fel'}`];
      else {
        dirty = false;
        notify('Lägena är sparade.');
      }
    } catch (e) {
      errors = [(e as Error).message];
    }
    saving = false;
  }
  function revert() {
    table = parseModeTable(original);
    dirty = false;
    errors = [];
  }
</script>

<p class="back"><a href="#/program">← Program</a></p>

<section class="panel" aria-labelledby="h-modes">
  <header class="head">
    <h1 id="h-modes">Lägen</h1>
    <span class="faint small">temperaturen i varje rum när läget gäller</span>
  </header>
  <p class="intro">
    Veckoschemat på Program säger när lägena gäller; Värme har en knapp per läge. Kallt är {cold !== null ? deg(cold) : 'heat_cold'}: ingen skada på huset men
    ingen är där. Första timmen efter ett byte är en övergång: varje rum får det varmaste lägets temperatur minus {slack ?? 1} °C.
  </p>

  {#if !table.modes.length && home.loaded}
    <p class="intro">Inga lägen i modes.tsv än.</p>
  {/if}

  <ol class="modes">
    {#each table.modes as m, i (m.id)}
      <li class="mode">
        <div class="mhead">
          <input class="name" aria-label="Lägets namn" bind:value={m.name} oninput={touch} />
          <span class="mono faint small">{m.id}</span>
          <span class="order">
            <button class="btn small" aria-label="Flytta upp" disabled={i === 0} onclick={() => move(i, -1)}>↑</button>
            <button class="btn small" aria-label="Flytta ner" disabled={i === table.modes.length - 1} onclick={() => move(i, 1)}>↓</button>
            <button
              class="btn small"
              disabled={used.has(m.id)}
              title={used.has(m.id) ? 'Används i veckoschemat: måla över de timmarna på Program först' : 'Ta bort läget'}
              onclick={() => removeMode(i)}>Ta bort</button
            >
          </span>
        </div>
        <ul class="temps">
          {#each table.rooms as r (r)}
            {@const t = m.temps[r] ?? { kind: 'cold' }}
            <li class="temp">
              <span class="rname">{roomName(r, home.rooms)}</span>
              {#if t.kind === 'formula'}
                <span class="mono small">{t.text}</span>
              {:else}
                <span class="stepper">
                  <button class="btn small" aria-label="Sänk" onclick={() => step(i, r, -0.5)}>−</button>
                  <b class="value">{t.kind === 'cold' ? 'Kallt' : deg(t.value)}</b>
                  <button class="btn small" aria-label="Höj" onclick={() => step(i, r, 0.5)}>+</button>
                </span>
                <button class="btn small cold" class:on={t.kind === 'cold'} aria-pressed={t.kind === 'cold'} onclick={() => setCold(i, r)}>Kallt</button>
              {/if}
            </li>
          {/each}
        </ul>
      </li>
    {/each}
  </ol>

  <div class="add">
    <input placeholder="Nytt läge, t.ex. Gäster" aria-label="Nytt lägets namn" bind:value={newName} onkeydown={(e) => e.key === 'Enter' && addMode()} />
    <button class="btn small" disabled={!newName.trim()} onclick={addMode}>Lägg till läge</button>
  </div>
  {#if otherRooms.length}
    <div class="add">
      <select bind:value={addRoom} aria-label="Rum att lägga till">
        <option value="">Rum…</option>
        {#each otherRooms as r (r)}<option value={r}>{roomName(r, home.rooms)}</option>{/each}
      </select>
      <button class="btn small" disabled={!addRoom} onclick={addRoomColumn}>Lägg till rum</button>
      <span class="faint small">ett rum styrs först när det har en termostat och en regel för sitt mål</span>
    </div>
  {/if}

  {#if errors.length}<p class="errors" role="alert">{errors.join(' · ')}</p>{/if}
  <div class="actions">
    <button class="btn primary" disabled={!dirty || saving} onclick={save}>{saving ? 'Sparar…' : 'Spara'}</button>
    <button class="btn" disabled={!dirty || saving} onclick={revert}>Ångra</button>
    {#if dirty}<span class="small">ändrat, inte sparat</span>{/if}
  </div>
  <p class="faint small">Kallt är cellen {COLD}; den och övergångens avdrag (heat_overlap_slack) ändras under Tabeller → Celler.</p>
</section>

<style>
  .back {
    margin: 0 0 var(--space-3);
    font-size: 14px;
  }
  .panel {
    background: var(--paper-raised);
    border: 1px solid var(--line);
    border-radius: var(--radius-panel);
    padding: var(--space-4);
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  h1 {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 900;
    text-transform: uppercase;
    margin: 0;
  }
  .intro {
    margin: var(--space-2) 0 var(--space-3);
    font-size: 14px;
    line-height: 1.5;
    color: var(--ink-muted);
    max-width: 62ch;
  }
  .modes {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .mode {
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-card);
    padding: var(--space-3);
  }
  .mhead {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .name {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 18px;
    text-transform: uppercase;
    border: 1px solid var(--line);
    border-radius: var(--radius-m);
    padding: 4px 10px;
    background: var(--paper);
    color: var(--ink);
    min-width: 0;
    width: 12ch;
  }
  .order {
    margin-left: auto;
    display: inline-flex;
    gap: var(--space-1);
  }
  .temps {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: 0;
  }
  .temp {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) 0;
  }
  .temp + .temp {
    border-top: 1px solid var(--line);
  }
  .rname {
    font-size: 14px;
  }
  .stepper {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
  }
  .stepper .value {
    min-width: 7ch;
    text-align: center;
    font-size: 15px;
  }
  .stepper .btn {
    min-width: 32px;
    padding: 0;
  }
  .cold.on {
    background: var(--ink);
    color: var(--paper);
    border-color: var(--ink);
  }
  .add {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }
  .add input,
  .add select {
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-m);
    padding: 6px 10px;
    background: var(--paper);
    color: var(--ink);
    font-size: 14px;
  }
  .errors {
    color: var(--alarm);
    font-size: 13px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-4) 0 var(--space-2);
  }
  .small {
    font-size: 12px;
  }
  @media (max-width: 640px) {
    .panel {
      margin-left: calc(-1 * var(--space-2));
      margin-right: calc(-1 * var(--space-2));
      border-radius: var(--radius-card);
      padding: var(--space-3);
    }
  }
</style>
