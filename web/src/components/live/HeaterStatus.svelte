<script lang="ts">
  /**
   * A heater with its own clock that nothing can read or steer (devices.tsv kind heater, source estimate).
   * part="status": the estimated heating word and the setpoint its clock gives now (the row), marked as estimated.
   * part="details": its clock (cells <room>_heater_night, _night_from, _day, _day_from when they exist), the
   * estimated power now, how far the program service has learnt it (GET /api/program `local`), and its note in
   * devices.tsv.
   */
  import { onMount } from 'svelte';
  import { api, type Cell, type ProgramState } from '../../lib/api';
  import { formatQuantity, formatValue } from '../../lib/format';
  import { parseTsv } from '../../lib/tsv';
  import { home } from '../../lib/state.svelte';
  import Reading from './Reading.svelte';
  import Icon from './Icon.svelte';

  let { device, props, part = 'status' }: { device: string; props: Record<string, Cell>; part?: 'status' | 'details' } = $props();

  const room = $derived(typeof props['room']?.value === 'string' ? (props['room'].value as string) : '');

  const num = (p: string): number | null => {
    const v = props[p]?.value;
    return typeof v === 'number' ? v : null;
  };
  const setpoint = $derived(num('setpoint'));
  const demand = $derived(num('demand'));

  /** The clock as cells: night temperature and start, day temperature and start. */
  const clock = $derived.by(() => {
    const c = (s: string) => home.cells[`${room}_heater_${s}`];
    const [night, nightFrom, day, dayFrom] = [c('night'), c('night_from'), c('day'), c('day_from')];
    if (!night || !nightFrom || !day || !dayFrom) return null;
    const t = (x: Cell) => formatValue(x.value, x.id, x.prop, home.now);
    const deg = (x: Cell) => (typeof x.value === 'number' ? formatQuantity(x.value, '°C') : '—');
    return [`Nattläge ${deg(night)} från ${t(nightFrom)}`, `dagläge ${deg(day)} från ${t(dayFrom)}`];
  });

  /** Its row in devices.tsv: rated watts and note. */
  const row = $derived.by(() => {
    const tb = parseTsv(home.tables?.files?.['devices.tsv'] ?? '');
    const col = (c: string) => tb.header.indexOf(c);
    const r = tb.rows.find((x) => x[col('id')] === device);
    const w = Number(r?.[col('watts')] ?? '');
    return { watts: Number.isFinite(w) && w > 0 ? w : null, note: col('note') >= 0 ? (r?.[col('note')] ?? '') : '' };
  });
  const watts = $derived(row.watts);
  const note = $derived(row.note);

  let program = $state<ProgramState | null>(null);
  onMount(() => {
    if (part !== 'details') return;
    const load = () => void api.program().then((p) => (program = p)).catch(() => undefined);
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  });
  const local = $derived(program?.local?.find((l) => l.id === device) ?? null);
  const kw = $derived(watts !== null && demand !== null ? (watts / 1000) * (demand / 100) : null);
</script>

{#if part === 'status'}
  <div class="heater">
    <div class="now">
      {#if demand === null}
        <span class="state off" title="uppskattningen vet inte än om den håller temperaturen">okänt</span>
      {:else if demand > 0}
        <span class="state on"><Icon name="heat" size={14} />värmer&nbsp;≈{Math.round(demand)}&nbsp;%</span>
      {:else}
        <span class="state off">vilar</span>
      {/if}
    </div>
    {#if setpoint !== null}<Reading value={setpoint} unit="°C" label="mål" />{/if}
  </div>
  <p class="sub small">egen klocka, styrs inte · uppskattad</p>
{:else}
  <div class="info small">
    {#if clock}<p><b>Klocka:</b> {clock.join(', ')}, varje dag.</p>{/if}
    <p>
      <b>Nu:</b>
      {#if kw !== null}ungefär {formatQuantity(Math.round(kw * 100) / 100, 'kW')} ({Math.round(demand ?? 0)} % av {formatQuantity(watts! / 1000, 'kW')}){:else}okänt{/if}.
      Systemet varken läser eller styr den: andelen uppskattas ur rummets temperatur, klockans inställning och utetemperaturen
      (fullt långt under målet, av långt över, däremellan vad rummet tappar).
    </p>
    {#if local}
      <p>
        <b>Inlärning:</b>
        {#if local.model}lärt av {local.model.nOff} timmar avsvalning och {local.model.nOn} timmar uppvärmning.{:else}{local.note ?? 'lär sig ännu'}.{/if}
      </p>
    {/if}
    {#if note}<p class="note">{note}</p>{/if}
  </div>
{/if}

<style>
  .heater {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2) var(--space-4);
  }
  .now {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  /* The same badges as a thermostat's (ThermostatControl.svelte). */
  .state {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 6px 12px;
    border-radius: var(--radius-pill);
    border: 1px solid var(--line-strong);
    white-space: nowrap;
  }
  .state.on {
    background: var(--surface-rust);
    border-color: var(--surface-rust);
    color: var(--on-dark);
  }
  .state.off {
    background: var(--paper);
    color: var(--ink-muted);
  }
  .small {
    font-size: 12px;
    line-height: 1.5;
  }
  .sub {
    margin: 0;
    color: var(--ink-faint);
  }
  .info p {
    margin: 0 0 var(--space-1);
    max-width: 60ch;
  }
  .note {
    color: var(--ink-muted);
  }
</style>
