/**
 * The cell store: current values, previous values, when each cell last changed, and when each
 * tracked (cell, value) pair was last seen. This is what SINCE(), PREV() and CHANGED() read.
 */
import { Duration, decodeValue, encodeValue, valuesEqual, type Value } from '../formula/values.js';
import type { Config } from '../config/model.js';

export interface CellState {
  value: Value;
  prev: Value;
  /** epoch ms of the last change, or null if never set */
  changedAt: number | null;
  /** epoch ms of the last report, even if the value was identical */
  seenAt: number | null;
}

export interface CellChange {
  cell: string;
  from: Value;
  to: Value;
}

export interface StoreSnapshot {
  savedAt: number;
  cells: Record<string, { value: unknown; prev: unknown; changedAt: number | null; seenAt: number | null }>;
  lastSeen: Record<string, Record<string, number>>;
}

export class CellStore {
  private cells = new Map<string, CellState>();
  private aliases: Map<string, string>;
  private transient: Set<string>;
  /** cell -> (JSON-encoded value -> epoch ms when the cell last had that value) */
  private lastSeen = new Map<string, Map<string, number>>();
  private tracked = new Map<string, Set<string>>();
  /** cells changed during the current pass */
  private changedThisPass = new Set<string>();

  constructor(config: Config) {
    this.aliases = config.aliases;
    this.transient = new Set([...config.cells.values()].filter((c) => c.transient).map((c) => c.id));
    for (const id of config.cells.keys()) this.cells.set(id, { value: null, prev: null, changedAt: null, seenAt: null });
    for (const s of config.settings.values()) this.cells.get(s.key)!.value = s.value;
    for (const v of config.vars.values()) this.cells.get(v.id)!.value = v.initial;
    this.seedRooms(config);
    for (const t of config.sinceTargets) {
      if (t.value === undefined) continue;
      let set = this.tracked.get(t.ref);
      if (!set) this.tracked.set(t.ref, (set = new Set()));
      set.add(key(t.value));
    }
  }

  /** Re-points the store at a new config after a hot reload, keeping values of cells that still exist. */
  adopt(config: Config): void {
    const next = new Map<string, CellState>();
    for (const id of config.cells.keys()) next.set(id, this.cells.get(id) ?? { value: null, prev: null, changedAt: null, seenAt: null });
    for (const s of config.settings.values()) next.get(s.key)!.value = s.value;
    for (const v of config.vars.values()) {
      const st = next.get(v.id)!;
      if (!this.cells.has(v.id)) st.value = v.initial;
    }
    this.cells = next;
    this.seedRooms(config);
    this.aliases = config.aliases;
    this.transient = new Set([...config.cells.values()].filter((c) => c.transient).map((c) => c.id));
    this.tracked = new Map();
    for (const t of config.sinceTargets) {
      if (t.value === undefined) continue;
      let set = this.tracked.get(t.ref);
      if (!set) this.tracked.set(t.ref, (set = new Set()));
      set.add(key(t.value));
    }
  }

  /** <device>.room / <device>.room_name mirror devices.tsv and rooms.tsv; moving a sensor is a table edit. */
  private seedRooms(config: Config): void {
    for (const d of config.devices.values()) {
      const room = this.cells.get(`${d.id}.room`);
      const name = this.cells.get(`${d.id}.room_name`);
      if (room) room.value = d.room || null;
      if (name) name.value = d.room ? (config.rooms.get(d.room)?.name ?? d.room) : null;
    }
  }

  resolve(ref: string): string {
    return this.aliases.get(ref) ?? ref;
  }

  has(ref: string): boolean {
    return this.cells.has(this.resolve(ref));
  }

  get(ref: string): Value {
    return this.cells.get(this.resolve(ref))?.value ?? null;
  }

  prev(ref: string): Value {
    return this.cells.get(this.resolve(ref))?.prev ?? null;
  }

  state(ref: string): CellState | undefined {
    return this.cells.get(this.resolve(ref));
  }

  changed(ref: string): boolean {
    return this.changedThisPass.has(this.resolve(ref));
  }

  since(ref: string, now: number, value?: Value): Duration | null {
    const id = this.resolve(ref);
    const st = this.cells.get(id);
    if (!st) return null;
    if (value === undefined) return st.changedAt === null ? null : new Duration(now - st.changedAt);
    if (valuesEqual(st.value, value)) return new Duration(0);
    const at = this.lastSeen.get(id)?.get(key(value));
    return at === undefined ? null : new Duration(now - at);
  }

  /**
   * Writes a value. Returns the change if the value differed (or the cell is transient), else null.
   * Callers must be inside a pass (see beginPass / endPass) so CHANGED() works.
   */
  set(ref: string, value: Value, now: number): CellChange | null {
    const id = this.resolve(ref);
    const st = this.cells.get(id);
    if (!st) return null;
    // Remember the time the old value was last held, for SINCE(cell, value).
    this.touchSeen(id, st.value, now);
    st.seenAt = now;
    const isChange = this.transient.has(id) ? value !== null : !valuesEqual(st.value, value);
    if (!isChange) return null;
    const from = st.value;
    st.prev = from;
    st.value = value;
    st.changedAt = now;
    this.touchSeen(id, value, now);
    this.changedThisPass.add(id);
    return { cell: id, from, to: value };
  }

  private touchSeen(id: string, value: Value, now: number): void {
    const tracked = this.tracked.get(id);
    if (!tracked || value === null) return;
    const k = key(value);
    if (!tracked.has(k)) return;
    let m = this.lastSeen.get(id);
    if (!m) this.lastSeen.set(id, (m = new Map()));
    m.set(k, now);
  }

  /** Keeps `lastSeen` fresh while a cell holds a tracked value (called once per pass). */
  refreshSeen(now: number): void {
    for (const [id, tracked] of this.tracked) {
      const st = this.cells.get(id);
      if (!st || st.value === null) continue;
      const k = key(st.value);
      if (tracked.has(k)) {
        let m = this.lastSeen.get(id);
        if (!m) this.lastSeen.set(id, (m = new Map()));
        m.set(k, now);
      }
    }
  }

  beginPass(): void {
    this.changedThisPass.clear();
  }

  endPass(): string[] {
    const changed = [...this.changedThisPass];
    this.changedThisPass.clear();
    return changed;
  }

  /** Transient cells (button actions) fall back to null after the pass so they do not linger. */
  clearTransients(): void {
    for (const id of this.transient) {
      const st = this.cells.get(id);
      if (st && st.value !== null) {
        st.prev = st.value;
        st.value = null;
      }
    }
  }

  ids(): string[] {
    return [...this.cells.keys()];
  }

  entries(): [string, CellState][] {
    return [...this.cells.entries()];
  }

  snapshot(now: number): StoreSnapshot {
    const cells: StoreSnapshot['cells'] = {};
    for (const [id, st] of this.cells) cells[id] = { value: encodeValue(st.value), prev: encodeValue(st.prev), changedAt: st.changedAt, seenAt: st.seenAt };
    const lastSeen: StoreSnapshot['lastSeen'] = {};
    for (const [id, m] of this.lastSeen) lastSeen[id] = Object.fromEntries(m);
    return { savedAt: now, cells, lastSeen };
  }

  /** Restores input/var cells from a snapshot. Settings keep their table values; derived cells are recomputed by the engine. */
  restore(snap: StoreSnapshot, skip: (id: string) => boolean): void {
    for (const [id, raw] of Object.entries(snap.cells)) {
      const st = this.cells.get(id);
      if (!st || skip(id)) continue;
      st.value = decodeValue(raw.value);
      st.prev = decodeValue(raw.prev);
      st.changedAt = raw.changedAt;
      st.seenAt = raw.seenAt;
    }
    for (const [id, m] of Object.entries(snap.lastSeen)) {
      if (!this.cells.has(id)) continue;
      this.lastSeen.set(id, new Map(Object.entries(m)));
    }
  }
}

function key(v: Value): string {
  return JSON.stringify(encodeValue(v));
}
