<script lang="ts">
  /**
   * Cells grouped by room -> device. The room is the device's `.room` cell (devices.tsv), the header its name from rooms.tsv.
   * Cells from cells.tsv with a `room` join that room as a "Styrning" card; those without land in "Huset".
   * Sun/weather/settings go to "System".
   */
  import type { Cell } from '../lib/api';
  import { formatDuration, roomName, systemName } from '../lib/format';
  import { home } from '../lib/state.svelte';
  import DeviceCard, { type DeviceGroup } from '../components/DeviceCard.svelte';

  let showAll = $state(false);

  interface Section {
    title: string;
    groups: DeviceGroup[];
  }

  const sections = $derived.by((): Section[] => {
    const cells = Object.values(home.cells);
    const byRoom = new Map<string, Map<string, DeviceGroup>>();
    const derived: Cell[] = [];
    const vars: Cell[] = [];
    const settings: Cell[] = [];
    const system = new Map<string, DeviceGroup>();
    const roomCells = new Map<string, Cell[]>();

    for (const c of cells) {
      if (c.device) {
        const room = c.room ?? '';
        let devices = byRoom.get(room);
        if (!devices) byRoom.set(room, (devices = new Map()));
        let g = devices.get(c.device);
        if (!g) {
          const kind = home.tables?.devices.find((d) => d.id === c.device)?.kind ?? guessKind(c.device, cells);
          devices.set(c.device, (g = { id: c.device, name: c.name ?? c.device, kind, room: c.room, cells: [] }));
        }
        g.cells.push(c);
      } else if ((c.kind === 'derived' || c.kind === 'var') && c.room) {
        let list = roomCells.get(c.room);
        if (!list) roomCells.set(c.room, (list = []));
        list.push(c);
      } else if (c.kind === 'derived') derived.push(c);
      else if (c.kind === 'var') vars.push(c);
      else if (c.kind === 'setting') settings.push(c);
      else {
        // system inputs: sun.elevation, weather.temperature ...
        const prefix = c.id.includes('.') ? c.id.slice(0, c.id.indexOf('.')) : 'system';
        let g = system.get(prefix);
        if (!g) system.set(prefix, (g = { id: prefix, name: systemName(prefix), kind: 'system', room: null, cells: [] }));
        g.cells.push(c);
      }
    }

    const out: Section[] = [];
    const names = home.rooms;
    for (const [room, list] of roomCells) {
      let devices = byRoom.get(room);
      if (!devices) byRoom.set(room, (devices = new Map()));
      // held values first (they have controls), then computed cells, each alphabetically
      list.sort((a, b) => (a.kind === b.kind ? byId(a, b) : a.kind === 'var' ? -1 : 1));
      devices.set(`cells:${room}`, { id: `cells:${room}`, name: 'Styrning', kind: 'computed', room, cells: list });
    }
    const rooms = [...byRoom.keys()].sort((a, b) => roomName(a || null, names).localeCompare(roomName(b || null, names), 'sv'));
    for (const r of rooms) {
      // devices alphabetically, the room's own cells ("Styrning") last
      const groups = [...byRoom.get(r)!.values()].sort((a, b) => Number(a.kind === 'computed') - Number(b.kind === 'computed') || a.name.localeCompare(b.name, 'sv'));
      for (const g of groups) if (g.kind !== 'computed') g.cells.sort(cellOrder);
      out.push({ title: roomName(r || null, names), groups });
    }

    const computed: DeviceGroup[] = [];
    if (vars.length) computed.push({ id: 'vars', name: 'Variabler', kind: 'computed', room: null, cells: vars.sort(byId) });
    if (derived.length) computed.push({ id: 'derived', name: 'Formler', kind: 'computed', room: null, cells: derived.sort(byId) });
    if (computed.length) out.push({ title: 'Huset', groups: computed });

    const sys = [...system.values()].sort((a, b) => a.id.localeCompare(b.id));
    for (const g of sys) g.cells.sort(byId);
    if (showAll && settings.length) sys.push({ id: 'settings', name: 'Inställningar', kind: 'system', room: null, cells: settings.sort(byId) });
    if (sys.length) out.push({ title: 'System', groups: sys });
    return out;
  });

  const PROP_ORDER = ['state', 'brightness', 'color_temp', 'color', 'level', 'occupancy', 'temperature', 'humidity', 'setpoint', 'demand', 'mode', 'running', 'illuminance', 'action', 'power', 'energy', 'pressure', 'battery', 'linkquality', 'room', 'room_name', 'available', 'last_seen'];
  function cellOrder(a: Cell, b: Cell): number {
    const ia = PROP_ORDER.indexOf(a.prop ?? '');
    const ib = PROP_ORDER.indexOf(b.prop ?? '');
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.id.localeCompare(b.id);
  }
  const byId = (a: Cell, b: Cell) => a.id.localeCompare(b.id);

  /** Fallback when /api/tables has not arrived: infer the kind from the props present. */
  function guessKind(device: string, cells: Cell[]): string {
    const props = new Set(cells.filter((c) => c.device === device).map((c) => c.prop));
    if (props.has('brightness')) return 'light';
    if (props.has('setpoint')) return 'thermostat';
    if (props.has('occupancy')) return 'motion';
    if (props.has('level')) return 'pwm';
    if (props.has('action')) return 'remote';
    if (props.has('open')) return 'contact';
    if (props.has('humidity')) return 'climate';
    if (props.has('state')) return 'plug';
    return 'device';
  }

  const visibleSections = $derived(
    sections
      .map((s) => ({ ...s, groups: s.groups.filter((g) => showAll || g.cells.some((c) => c.value !== null || g.kind !== 'computed')) }))
      .filter((s) => s.groups.length),
  );
</script>

<div class="toolbar">
  <span class="muted">
    {#if !home.loaded}
      laddar…
    {:else}
      {Object.keys(home.cells).length} celler
      {#if home.health}
        · drifttid {formatDuration(home.health.uptimeSeconds * 1000)}
      {/if}
    {/if}
  </span>
  <span class="spacer"></span>
  <label class="check"><input type="checkbox" bind:checked={showAll} /> Visa allt</label>
</div>

{#if home.loaded && !visibleSections.length}
  <div class="empty">Inga celler ännu.</div>
{/if}

{#each visibleSections as s (s.title)}
  <h2 class="group">{s.title}</h2>
  <div class="grid">
    {#each s.groups as g (g.id)}
      <DeviceCard group={g} {showAll} />
    {/each}
  </div>
{/each}

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
    gap: var(--space-6);
    align-items: start;
  }
  .toolbar .muted {
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
  }
</style>
