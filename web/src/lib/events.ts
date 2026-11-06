/**
 * Events (events.tsv): something that changed the house or what is measured. Every chart marks the events inside
 * its span with a dashed line, so statistics before and after an event are read as different eras. Pure functions.
 */
import { parseTsv, serialiseTsv } from './tsv';

export interface HomeEvent {
  /** epoch seconds, local time as written */
  t: number;
  /** as written: YYYY-MM-DD or YYYY-MM-DD HH:MM */
  at: string;
  title: string;
  note: string;
}

const AT = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/;

/** The events of events.tsv, oldest first; rows that do not parse are left out (the engine refuses them anyway). */
export function parseEvents(text: string): HomeEvent[] {
  const tb = parseTsv(text);
  const col = (c: string) => tb.header.indexOf(c);
  const [ia, it, inote] = [col('at'), col('title'), col('note')];
  if (ia < 0 || it < 0) return [];
  const out: HomeEvent[] = [];
  for (const r of tb.rows) {
    const at = (r[ia] ?? '').trim();
    const title = (r[it] ?? '').trim();
    const m = AT.exec(at);
    if (!m || !title) continue;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
    out.push({ t: d.getTime() / 1000, at, title, note: inote >= 0 ? (r[inote] ?? '') : '' });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Events in [since, until) (epoch seconds). */
export function eventsIn(events: HomeEvent[], since: number, until: number): HomeEvent[] {
  return events.filter((e) => e.t >= since && e.t < until);
}

/** `at` for a local Date: YYYY-MM-DD HH:MM. */
export function atText(d: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** events.tsv with one more row (the header and comments kept; a new table gets a header and a comment). */
export function addEvent(text: string, at: string, title: string, note: string): string {
  const clean = (s: string) => s.replace(/[\t\r\n]+/g, ' ').trim();
  const row = [clean(at), clean(title), clean(note)];
  const tb = parseTsv(text);
  if (!tb.header.length) {
    return `# Händelser som ändrar huset eller vad som mäts. Varje diagram markerar dem, så statistiken före och efter läses som olika epoker.\nat\ttitle\tnote\n${row.join('\t')}\n`;
  }
  tb.rows.push(tb.header.map((h) => (h === 'at' ? row[0]! : h === 'title' ? row[1]! : h === 'note' ? row[2]! : '')));
  return serialiseTsv(tb);
}

/** Short Swedish date and time: "5 nov 16:00" (no time for a whole day). */
export function eventWhen(e: HomeEvent): string {
  const d = new Date(e.t * 1000);
  const date = d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' });
  return e.at.length > 10 ? `${date} ${e.at.slice(11)}` : date;
}

/**
 * Rows for event titles at the top of a chart, so titles close together do not overlap: each takes the first row
 * where the titles before it have ended. `spans` are [left, right] in pixels, in the order the titles are drawn.
 */
export function labelRows(spans: [number, number][]): number[] {
  const ends: number[] = [];
  return spans.map(([left, right]) => {
    let row = ends.findIndex((end) => end + 6 <= left);
    if (row < 0) row = ends.length;
    ends[row] = right;
    return row;
  });
}
