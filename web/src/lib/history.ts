/**
 * Shapes PocketBase history rows for the Historik view. Pure functions, no Svelte.
 * Everything is grouped by room, like Live: climate rows carry their room name in `location` (as it was when the
 * row was written), heating rows are mapped to a room through their thermostat, power rows are appliances.
 * Names come from the tables: a history `sensor` / `name` constant is traced back through history.tsv to the
 * device or cell whose formula feeds that record, and that device's or cell's Swedish `name` is shown.
 */
import { capitalise } from './format';
import { parseTsv } from './tsv';

export type Rec = Record<string, unknown>;

/** [epoch seconds, value] pairs, ascending. */
export type Points = [number, number][];

export interface Series {
  label: string;
  points: Points;
  stepped?: boolean;
  /** Drawn dashed: targets and outdoor temperature, things to compare against. */
  dash?: boolean;
  /** Series with the same key share a colour (a thermostat and its target); defaults to the label. */
  colorKey?: string;
}

export interface Names {
  /** device id (lowercase) -> Swedish name */
  devices: Record<string, string>;
  /** device id -> room id */
  deviceRoom: Record<string, string>;
  /** device id -> kind (light, pwm, thermostat ...) */
  deviceKind: Record<string, string>;
  /** device id -> rated power in W (devices.tsv `watts`) */
  deviceWatts: Record<string, number>;
  /** room id -> Swedish name as stored (lowercase) */
  rooms: Record<string, string>;
  /** history constant (record `sensor` / `name`) -> the device or cell id its record reads */
  sources: Record<string, string>;
  /** cell id -> Swedish name (cells.tsv `name`) */
  cells: Record<string, string>;
}

const REF_RE = /[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*/g;

/** Builds the name lookups from the raw table texts (GET /api/tables). */
export function namesFromTables(files: Record<string, string>): Names {
  const rows = (file: string) => {
    const t = parseTsv(files[file] ?? '');
    return t.rows.map((r) => Object.fromEntries(t.header.map((h, i) => [h, r[i] ?? ''])));
  };
  const devices: Record<string, string> = {};
  const deviceRoom: Record<string, string> = {};
  const deviceKind: Record<string, string> = {};
  const deviceWatts: Record<string, number> = {};
  for (const d of rows('devices.tsv')) {
    if (!d['id']) continue;
    const w = Number(d['watts']);
    if (d['watts'] && Number.isFinite(w) && w > 0) deviceWatts[d['id']] = w;
    devices[d['id']] = d['name'] || d['id'];
    deviceKind[d['id']] = d['kind'] ?? '';
    if (d['room']) deviceRoom[d['id']] = d['room'];
  }
  const rooms: Record<string, string> = {};
  for (const r of rows('rooms.tsv')) if (r['id']) rooms[r['id']] = r['name'] || r['id'];
  const cells: Record<string, string> = {};
  for (const c of rows('cells.tsv')) if (c['id'] && c['name']) cells[c['id']] = c['name'];

  // history.tsv: per record, the quoted constant in `sensor` / `name`, and the first device or cell its formulas read.
  const constant = new Map<string, string>();
  const reads = new Map<string, string>();
  for (const h of rows('history.tsv')) {
    const rec = h['record'];
    const f = h['formula'] ?? '';
    if (!rec) continue;
    const q = /^"(.*)"$/.exec(f);
    if (q && (h['field'] === 'sensor' || h['field'] === 'name')) constant.set(rec, q[1]!);
    else if (!q && !reads.has(rec)) {
      for (const ref of f.match(REF_RE) ?? []) {
        const dev = ref.split('.')[0]!;
        if (devices[dev]) {
          reads.set(rec, dev);
          break;
        }
        if (cells[ref]) {
          reads.set(rec, ref);
          break;
        }
      }
    }
  }
  const sources: Record<string, string> = {};
  for (const [rec, c] of constant) {
    const r = reads.get(rec);
    if (r) sources[c] = r;
  }
  return { devices, deviceRoom, deviceKind, deviceWatts, rooms, sources, cells };
}

/** Swedish name for a history constant ("motion2", "FLOOR1", "humidifier"): the device or cell behind it, else the constant. */
export function sourceName(names: Names, key: string): string {
  const id = names.sources[key] ?? key.toLowerCase();
  return names.devices[id] ?? names.cells[id] ?? capitalise(key.replace(/_/g, ' '));
}

/** Device or cell id behind a history constant, lowercased device id as fallback. */
export function sourceId(names: Names, key: string): string {
  return names.sources[key] ?? key.toLowerCase();
}

/**
 * Room id of a climate history row. `location` is the room's name when the row was written; a room renamed since
 * (rooms.tsv `name`) no longer matches, so then the room the sensor is in now is used, else the location itself.
 */
export function roomOfLocation(names: Names, location: string, sensor?: string): string {
  const hit = Object.entries(names.rooms).find(([, n]) => n.toLowerCase() === location.toLowerCase());
  if (hit) return hit[0];
  const now = sensor ? names.deviceRoom[sourceId(names, sensor)] : undefined;
  return now ?? location;
}

export const ts = (r: Rec): number | null => {
  const w = r['when'];
  if (typeof w !== 'string') return null;
  const ms = Date.parse(w.replace(' ', 'T'));
  return Number.isNaN(ms) ? null : ms / 1000;
};

export const num = (r: Rec, f: string): number | null => {
  const v = r[f];
  if (typeof v === 'boolean') return v ? 1 : 0;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

/**
 * One series per distinct `by` value (labelled by `label`), y = field * scale, rows without a value skipped.
 * Climate records carry every field for every sensor, so a sensor without a hygrometer or light sensor writes 0:
 * `skipZero` drops 0 values (humidity is never 0 %), `dropAllZero` drops a series that is 0 the whole interval.
 */
export function seriesBy(
  items: Rec[],
  by: string,
  field: string,
  label: (key: string) => string,
  opts: { scale?: number; stepped?: boolean; dash?: boolean; skipZero?: boolean; dropAllZero?: boolean; colorKey?: (key: string) => string } = {},
): Series[] {
  const groups = new Map<string, Points>();
  for (const r of items) {
    const t = ts(r);
    const v = num(r, field);
    if (t === null || v === null || (opts.skipZero && v === 0)) continue;
    const key = String(r[by] ?? '?');
    let pts = groups.get(key);
    if (!pts) groups.set(key, (pts = []));
    pts.push([t, v * (opts.scale ?? 1)]);
  }
  return [...groups.entries()]
    .filter(([, points]) => !opts.dropAllZero || points.some((p) => p[1] !== 0))
    .map(([key, points]): Series => {
      const s: Series = { label: label(key), points: points.sort((a, b) => a[0] - b[0]) };
      if (opts.stepped) s.stepped = true;
      if (opts.dash) s.dash = true;
      if (opts.colorKey) s.colorKey = opts.colorKey(key);
      return s;
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'sv'));
}

/**
 * The room value over time: the mean of all its sources per time bucket (seconds). Sources report at different
 * moments, so each source's latest value is carried into the bucket until it reports again.
 */
export function meanSeries(series: Series[], bucket: number, label: string): Series | null {
  const all = series.flatMap((s) => s.points.map((p) => p[0]));
  if (!all.length) return null;
  const start = Math.floor(Math.min(...all) / bucket) * bucket;
  const end = Math.max(...all);
  const idx = series.map(() => 0);
  const last: (number | null)[] = series.map(() => null);
  const out: Points = [];
  for (let t = start; t <= end + bucket; t += bucket) {
    const sums: number[] = [];
    series.forEach((s, i) => {
      const inBucket: number[] = [];
      while (idx[i]! < s.points.length && s.points[idx[i]!]![0] < t + bucket) {
        inBucket.push(s.points[idx[i]!]![1]);
        idx[i]!++;
      }
      if (inBucket.length) last[i] = inBucket.reduce((a, b) => a + b, 0) / inBucket.length;
      if (last[i] !== null) sums.push(last[i]!);
    });
    if (sums.length) out.push([Math.min(t + bucket / 2, end), sums.reduce((a, b) => a + b, 0) / sums.length]);
  }
  return { label, points: out };
}

/** On/off spans of a 0/100 (or boolean) series, for the timeline: [start, end] epoch seconds while on. */
export function onSpans(points: Points, until: number): [number, number][] {
  const spans: [number, number][] = [];
  let from: number | null = null;
  for (const [t, v] of points) {
    if (v > 0 && from === null) from = t;
    else if (v <= 0 && from !== null) {
      spans.push([from, t]);
      from = null;
    }
  }
  if (from !== null) spans.push([from, until]);
  return spans;
}


/**
 * True for a series that pulses: an on/off heater logged as 0 and 100 at every switch (before such a heater got a
 * quarter-hour share in history.tsv), switching often. Drawn as it is, it reads as a solid wall. A series that also
 * holds later share rows (any percent) still counts when its 0/100 part switches often.
 */
export function isPulsing(points: Points): boolean {
  let switches = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]![1];
    const b = points[i]![1];
    if ((a === 0 || a === 100) && (b === 0 || b === 100) && a !== b) switches++;
  }
  return switches > 12;
}

/**
 * The time-weighted mean per bucket (seconds) of a stepped percent series: for 0/100 rows that is the share of the
 * bucket spent on, for share rows their average. Each value holds until the next row; time before the first row in
 * the interval is left out.
 */
export function dutySeries(points: Points, bucket: number, since: number, until: number): Points {
  const out: Points = [];
  let i = 0;
  let value: number | null = null;
  for (let start = Math.floor(since / bucket) * bucket; start < until; start += bucket) {
    const end = Math.min(start + bucket, until);
    let sum = 0;
    let known = 0;
    let t = Math.max(start, since);
    while (t < end) {
      while (i < points.length && points[i]![0] <= t) value = points[i++]![1];
      const next = i < points.length ? Math.min(points[i]![0], end) : end;
      if (value !== null) {
        known += next - t;
        sum += value * (next - t);
      }
      t = next;
    }
    if (known > 0) out.push([start, Math.round(sum / known)]);
  }
  return out;
}
