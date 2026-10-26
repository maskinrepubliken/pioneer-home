<script lang="ts">
  /**
   * On/off over time as a row of squares per appliance: one square per hour (an interval of a day or less) or per
   * calendar day (7 squares for a week, about 30 for a month). A square is filled when the appliance was on for at
   * least half of it; the exact share is in its title. A square without any known state is drawn dashed. The share
   * of the whole interval and the state right now are printed at the end of the row.
   */
  import { onSpans, type Series } from '../lib/history';

  let { title, series, since, until }: { title: string; series: Series[]; since: number; until: number } = $props();

  const span = $derived(Math.max(until - since, 1));
  const hourly = $derived(span <= 26 * 3600);
  const two = (n: number) => String(n).padStart(2, '0');
  const WD = ['sön', 'mån', 'tis', 'ons', 'tor', 'fre', 'lör'];

  /** The squares: whole hours or local calendar days, the last one containing `until`. */
  const cells = $derived.by(() => {
    const out: { from: number; to: number; label: string; tick: string }[] = [];
    if (hourly) {
      const last = new Date(until * 1000);
      last.setMinutes(0, 0, 0);
      const n = Math.max(1, Math.round(span / 3600));
      for (let i = n - 1; i >= 0; i--) {
        const a = new Date(last.getTime() - i * 3_600_000);
        out.push({ from: a.getTime() / 1000, to: a.getTime() / 1000 + 3600, label: `${two(a.getHours())}:00`, tick: a.getHours() % 3 === 0 ? two(a.getHours()) : '' });
      }
    } else {
      const end = new Date(until * 1000);
      const n = Math.max(1, Math.round(span / 86_400));
      for (let i = n - 1; i >= 0; i--) {
        const a = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i);
        const b = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i + 1);
        const label = `${WD[a.getDay()]} ${a.getDate()}/${a.getMonth() + 1}`;
        const tick = n <= 7 ? WD[a.getDay()]! : (n - 1 - i) % 5 === 0 ? String(a.getDate()) : '';
        out.push({ from: a.getTime() / 1000, to: b.getTime() / 1000, label, tick });
      }
    }
    return out;
  });

  const rows = $derived(
    series.map((s) => {
      const spans = onSpans(s.points, until);
      const first = s.points[0]?.[0] ?? Infinity;
      const squares = cells.map((c) => {
        const to = Math.min(c.to, until);
        const knownFrom = Math.max(c.from, first);
        const known = Math.max(0, to - knownFrom);
        let on = 0;
        for (const [a, b] of spans) on += Math.max(0, Math.min(b, to) - Math.max(a, knownFrom));
        const share = known > 0 ? on / known : null;
        return { share, filled: share !== null && share >= 0.5, label: c.label };
      });
      let total = 0;
      for (const [a, b] of spans) total += Math.max(0, Math.min(b, until) - Math.max(a, since));
      const lastOn = (s.points[s.points.length - 1]?.[1] ?? 0) > 0;
      return { label: s.label, squares, share: Math.round((total / span) * 100), lastOn };
    }),
  );
  const pct = (x: number | null) => (x === null ? 'okänt' : `på ${Math.round(x * 100)} %`);
</script>

<figure class="onoff">
  <figcaption class="title">{title}</figcaption>
  {#if rows.length}
    <div class="grid" style="--n: {cells.length}">
      {#each rows as r, i (i)}
        <span class="name">{r.label}</span>
        <ul class="squares" aria-label={`${r.label}: på ${r.share} % av tiden, ${r.lastOn ? 'på nu' : 'av nu'}`}>
          {#each r.squares as q, k (k)}
            <li class:filled={q.filled} class:unknown={q.share === null} title={`${q.label}: ${pct(q.share)}`}></li>
          {/each}
        </ul>
        <span class="share"><b class="value">{r.share} %</b> {r.lastOn ? 'på nu' : 'av nu'}</span>
      {/each}
      <span></span>
      <ul class="ticks" aria-hidden="true">
        {#each cells as c, k (k)}<li>{c.tick}</li>{/each}
      </ul>
      <span></span>
    </div>
  {:else}
    <p class="empty">Inga data i det här intervallet.</p>
  {/if}
</figure>

<style>
  .onoff {
    margin: 0;
    min-width: 0;
  }
  .title {
    font-family: var(--font-ui);
    font-size: 15px;
    line-height: 1.4;
    font-weight: 600;
    color: var(--ink);
    margin-bottom: var(--space-3);
  }
  /* name | squares | share; the tick row sits under the squares in the same columns */
  .grid {
    display: grid;
    grid-template-columns: minmax(6em, 10em) 1fr auto;
    align-items: center;
    gap: var(--space-2) var(--space-3);
  }
  .name {
    font-size: 13px;
    line-height: 1.3;
    color: var(--ink-muted);
    overflow-wrap: break-word;
    min-width: 0;
  }
  .squares,
  .ticks {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    /* real squares: at most 28 px wide, shrinking when many (24 hours, 31 days) must fit */
    grid-template-columns: repeat(var(--n), minmax(0, 28px));
    gap: 3px;
  }
  .squares li {
    aspect-ratio: 1;
    border: 1.5px solid var(--surface-forest);
    border-radius: 3px;
    background: var(--paper);
  }
  .squares li.filled {
    background: var(--surface-forest);
  }
  .squares li.unknown {
    border-style: dashed;
    border-color: var(--line-strong);
  }
  .ticks li {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--ink-faint);
    text-align: center;
    white-space: nowrap;
  }
  .share {
    font-size: 12px;
    color: var(--ink-faint);
    white-space: nowrap;
  }
  .share .value {
    font-size: 13px;
  }
  .empty {
    margin: var(--space-3) 0;
    font-size: 13px;
    color: var(--ink-faint);
  }
</style>
