/**
 * The validated, in-memory shape of everything in tables/. Produced by loader.ts, consumed by the engine.
 * Nothing here knows about MQTT or PocketBase; those are adapters.
 */
import type { Ast } from '../formula/api.js';
import type { Duration, Value, ValueType } from '../formula/values.js';
import type { KindSpec } from '../core/kinds.js';

export interface Located {
  file: string;
  line: number;
}

export interface SettingDef extends Located {
  key: string;
  value: Value;
  raw: string;
}

export interface DeviceDef extends Located {
  id: string;
  room: string;
  kind: KindSpec;
  /** 'z2m' -> zigbee2mqtt friendly name; 'mqtt' -> generic JSON topic */
  source: { type: 'z2m'; friendly: string } | { type: 'mqtt'; topic: string };
  name: string;
  note: string;
}

export interface RoomDef extends Located {
  id: string;
  name: string;
  note: string;
}

export interface VarDef extends Located {
  id: string;
  type: ValueType;
  initial: Value;
  /** room the cell belongs to (cells.tsv `room`), for grouping in the UI */
  room: string | null;
}

export interface DerivedDef extends Located {
  id: string;
  formula: Ast;
  source: string;
  type: ValueType;
  timeDependent: boolean;
  refs: string[];
  room: string | null;
}

export interface SceneDef extends Located {
  name: string;
  /** device id -> target tokens */
  targets: { device: string; tokens: string[]; line: number }[];
}

export type ScheduleTime =
  | { kind: 'clock'; msSinceMidnight: number }
  | { kind: 'sun'; event: 'sunrise' | 'sunset'; offsetMs: number };

export type RuleTrigger =
  | { kind: 'edge' }
  | { kind: 'change'; cell: string }
  | { kind: 'event' }
  | { kind: 'at'; time: ScheduleTime; text: string; days: Set<number> };

export interface RuleDef extends Located {
  id: string;
  trigger: RuleTrigger;
  condition: Ast | null;
  conditionSource: string;
  conditionRefs: string[];
  conditionTimeDependent: boolean;
  actions: ActionDef[];
  enabled: boolean;
  note: string;
}

export interface SequenceStep extends Located {
  step: number;
  afterMs: number;
  action: ActionDef | null;
  cancelIf: Ast | null;
  cancelIfSource: string;
}

export interface SequenceDef extends Located {
  id: string;
  steps: SequenceStep[];
  /** from the `*` row, if any */
  cancelIf: Ast | null;
  cancelIfSource: string;
}

export interface HistoryField extends Located {
  field: string;
  formula: Ast;
  source: string;
  refs: string[];
  scale: number | null;
  minDelta: number | null;
}

export interface HistoryRecordDef extends Located {
  record: string;
  collection: string;
  minInterval: Duration | null;
  /** write again after this long even if nothing changed (heartbeat for "latest" views) */
  maxInterval: Duration | null;
  fields: HistoryField[];
  /** all cell refs used by any field */
  refs: string[];
}

/** A token of an action may be literal text or an embedded {formula}. */
export type ActionToken = { kind: 'text'; text: string } | { kind: 'formula'; ast: Ast; source: string };

export type ActionDef =
  | { kind: 'set-device'; device: string; tokens: ActionToken[][]; source: string }
  | { kind: 'set-var'; var: string; value: ActionToken[]; source: string }
  | { kind: 'scene'; scene: string; room: string | null; source: string }
  | { kind: 'event'; name: string; source: string }
  | { kind: 'start'; sequence: string; unlessRunning: boolean; source: string }
  | { kind: 'cancel'; sequence: string; source: string }
  | { kind: 'fade'; device: string; tokens: ActionToken[][]; overMs: number; source: string }
  | { kind: 'notify'; text: ActionToken[]; source: string }
  | { kind: 'log'; text: ActionToken[]; source: string }
  | { kind: 'script'; file: string; args: string[]; source: string };

export interface CellDef {
  id: string;
  type: ValueType;
  kind: 'input' | 'var' | 'derived' | 'setting' | 'system';
  /** device id when this is a device prop */
  device?: string;
  prop?: string;
  /** room for cells that belong to a room without being a device prop */
  room?: string;
  settable: boolean;
  transient: boolean;
}

export interface Config {
  dir: string;
  settings: Map<string, SettingDef>;
  rooms: Map<string, RoomDef>;
  devices: Map<string, DeviceDef>;
  vars: Map<string, VarDef>;
  derived: Map<string, DerivedDef>;
  scenes: Map<string, SceneDef>;
  rules: RuleDef[];
  sequences: Map<string, SequenceDef>;
  history: HistoryRecordDef[];
  /** every addressable cell, including primary aliases resolved away (aliases live in `aliases`) */
  cells: Map<string, CellDef>;
  /** short id -> full cell id, e.g. hall.light -> hall.light.state */
  aliases: Map<string, string>;
  /** (ref, value) pairs the store must track for SINCE/HOLD */
  sinceTargets: { ref: string; value: Value | undefined }[];
  timezone: string;
  latitude: number;
  longitude: number;
}

/** System cells every configuration has, fed by the engine itself. */
export const SYSTEM_CELLS: { id: string; type: ValueType }[] = [
  { id: 'sun.elevation', type: 'number' },
  { id: 'sun.azimuth', type: 'number' },
  { id: 'sun.up', type: 'boolean' },
  { id: 'weather.temperature', type: 'number' },
  { id: 'weather.humidity', type: 'number' },
  { id: 'weather.windspeed', type: 'number' },
  { id: 'weather.winddirection', type: 'number' },
  { id: 'weather.precipitation', type: 'number' },
  { id: 'weather.detail', type: 'string' },
  { id: 'weather.icon', type: 'string' },
  { id: 'event', type: 'string' },
];
