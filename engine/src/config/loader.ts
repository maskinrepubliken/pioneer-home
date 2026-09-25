/**
 * Loads every table in a directory into a validated Config, or a list of ConfigErrors that each
 * point at file:line. All cross-references (cells, devices, scenes, sequences) are checked here so
 * the engine can assume a consistent configuration.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { formula } from '../formula/index.js';
import { FormulaError, type Ast } from '../formula/api.js';
import { parseDuration, parseLiteral, parseTimeOfDay, typeOf, type Value, type ValueType } from '../formula/values.js';
import { getKind, KINDS, parseTargets } from '../core/kinds.js';
import { ActionParseError, actionFormulas, parseActions } from './actions.js';
import type { ConfigError } from './errors.js';
import {
  SYSTEM_CELLS,
  type ActionDef,
  type CellDef,
  type Config,
  type DerivedDef,
  type DeviceDef,
  type HistoryRecordDef,
  type RoomDef,
  type RuleDef,
  type RuleTrigger,
  type SceneDef,
  type ScheduleTime,
  type SequenceDef,
  type SettingDef,
  type VarDef,
} from './model.js';
import { readTsv, requireColumns, type TsvRow, type TsvTable } from './tsv.js';

export type LoadResult = { ok: true; config: Config; warnings: ConfigError[] } | { ok: false; errors: ConfigError[]; warnings: ConfigError[] };

const ID_RE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$/;
const DAY_NAMES: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

export const TABLE_FILES = ['settings', 'rooms', 'devices', 'cells', 'scenes', 'rules', 'sequences', 'history'] as const;
/** Older layouts: still read when present so a checkout can be migrated one table at a time. */
const LEGACY_FILES = ['vars', 'derived'] as const;

export function loadConfig(dir: string): LoadResult {
  const errors: ConfigError[] = [];
  const warnings: ConfigError[] = [];
  const tables = new Map<string, TsvTable>();

  for (const name of [...TABLE_FILES, ...LEGACY_FILES]) {
    const path = join(dir, `${name}.tsv`);
    if (!existsSync(path)) {
      if (name === 'devices' || name === 'settings') errors.push({ file: `${name}.tsv`, line: 1, message: 'file is missing' });
      else tables.set(name, { file: `${name}.tsv`, header: [], rows: [] });
      continue;
    }
    tables.set(name, readTsv(path, `${name}.tsv`));
  }
  if (existsSync(join(dir, 'schedule.tsv'))) {
    errors.push({ file: 'schedule.tsv', line: 1, message: 'schedule.tsv is no longer a table: move each row into rules.tsv as a rule with when = "at 08:00 daily" (or "at sunset-30m mon-fri")' });
  }
  if (existsSync(dir)) {
    const known = new Set<string>([...TABLE_FILES, ...LEGACY_FILES, 'schedule'].map((n) => `${n}.tsv`));
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.tsv') && !known.has(f)) warnings.push({ file: f, line: 1, message: 'unknown table, ignored' });
    }
  }
  if (errors.length) return { ok: false, errors, warnings };

  const t = (name: (typeof TABLE_FILES)[number] | (typeof LEGACY_FILES)[number]) => tables.get(name)!;
  const err = (table: TsvTable, row: TsvRow | number, message: string, column?: string) => {
    const e: ConfigError = { file: table.file, line: typeof row === 'number' ? row : row.line, message };
    if (column) e.column = column;
    errors.push(e);
  };

  // ---- cells registry --------------------------------------------------------------------
  const cells = new Map<string, CellDef>();
  const aliases = new Map<string, string>();
  const addCell = (def: CellDef, table: TsvTable, row: TsvRow) => {
    if (cells.has(def.id) || aliases.has(def.id)) {
      err(table, row, `cell "${def.id}" is defined more than once`);
      return;
    }
    cells.set(def.id, def);
  };
  for (const sc of SYSTEM_CELLS) cells.set(sc.id, { id: sc.id, type: sc.type, kind: 'system', settable: false, transient: sc.id === 'event' });

  // ---- settings --------------------------------------------------------------------------
  const settings = new Map<string, SettingDef>();
  {
    const tb = t('settings');
    errors.push(...requireColumns(tb, ['key', 'value']));
    for (const row of tb.rows) {
      const key = row.cells['key'] ?? '';
      if (!ID_RE.test(key)) {
        err(tb, row, `bad setting key "${key}"`, 'key');
        continue;
      }
      const raw = row.cells['value'] ?? '';
      const value = parseLiteral(raw);
      settings.set(key, { key, value, raw, file: tb.file, line: row.line });
      addCell({ id: key, type: typeOf(value), kind: 'setting', settable: false, transient: false }, tb, row);
    }
  }
  const timezone = String(settings.get('timezone')?.value ?? 'Europe/Stockholm');
  const latitude = Number(settings.get('latitude')?.value ?? 0);
  const longitude = Number(settings.get('longitude')?.value ?? 0);

  // ---- rooms -----------------------------------------------------------------------------
  const rooms = new Map<string, RoomDef>();
  {
    const tb = t('rooms');
    if (tb.rows.length) errors.push(...requireColumns(tb, ['id', 'name']));
    for (const row of tb.rows) {
      const id = row.cells['id'] ?? '';
      if (!/^[a-z_][a-z0-9_]*$/.test(id)) {
        err(tb, row, `bad room id "${id}" (lowercase ASCII letters, digits and _)`, 'id');
        continue;
      }
      if (rooms.has(id)) {
        err(tb, row, `room "${id}" is defined more than once`, 'id');
        continue;
      }
      rooms.set(id, { id, name: row.cells['name'] || id, note: row.cells['note'] ?? '', file: tb.file, line: row.line });
    }
  }

  // ---- devices ---------------------------------------------------------------------------
  const devices = new Map<string, DeviceDef>();
  {
    const tb = t('devices');
    errors.push(...requireColumns(tb, ['id', 'room', 'kind', 'source']));
    for (const row of tb.rows) {
      const id = row.cells['id'] ?? '';
      if (!ID_RE.test(id)) {
        err(tb, row, `bad device id "${id}" (lowercase letters, digits, _ and . only)`, 'id');
        continue;
      }
      const kind = getKind(row.cells['kind'] ?? '');
      if (!kind) {
        err(tb, row, `unknown kind "${row.cells['kind']}" (known: ${Object.keys(KINDS).join(', ')})`, 'kind');
        continue;
      }
      const src = row.cells['source'] ?? '';
      let source: DeviceDef['source'];
      if (src.startsWith('z2m:') && src.length > 4) source = { type: 'z2m', friendly: src.slice(4).trim() };
      else if (src.startsWith('mqtt:') && src.length > 5) source = { type: 'mqtt', topic: src.slice(5).trim() };
      else {
        err(tb, row, `bad source "${src}" (expected z2m:<friendly name> or mqtt:<topic>)`, 'source');
        continue;
      }
      if (devices.has(id)) {
        err(tb, row, `device "${id}" is defined more than once`, 'id');
        continue;
      }
      const room = row.cells['room'] ?? '';
      if (rooms.size && room && !rooms.has(room)) {
        err(tb, row, `unknown room "${room}" (rooms.tsv has: ${[...rooms.keys()].join(', ')})`, 'room');
        continue;
      }
      const def: DeviceDef = { id, room, kind, source, name: row.cells['name'] || id, note: row.cells['note'] ?? '', file: tb.file, line: row.line };
      devices.set(id, def);
      for (const c of kind.cells) {
        addCell(
          { id: `${id}.${c.prop}`, type: c.type, kind: 'input', device: id, prop: c.prop, settable: !!c.settable, transient: !!c.transient },
          tb,
          row,
        );
      }
      addCell({ id: `${id}.room`, type: 'string', kind: 'input', device: id, prop: 'room', settable: false, transient: false }, tb, row);
      addCell({ id: `${id}.room_name`, type: 'string', kind: 'input', device: id, prop: 'room_name', settable: false, transient: false }, tb, row);
      addCell({ id: `${id}.available`, type: 'boolean', kind: 'input', device: id, prop: 'available', settable: false, transient: false }, tb, row);
      addCell({ id: `${id}.last_seen`, type: 'timestamp', kind: 'input', device: id, prop: 'last_seen', settable: false, transient: false }, tb, row);
      if (cells.has(id)) err(tb, row, `device id "${id}" collides with an existing cell`, 'id');
      else aliases.set(id, `${id}.${kind.primary}`);
    }
  }

  // ---- cells: held values (no formula) -----------------------------------------------------
  // cells.tsv holds both kinds: a row with a formula is a derived cell, a row without is a held value
  // (var) whose type comes from `type` or from `initial`. Legacy vars.tsv / derived.tsv rows are merged in.
  const vars = new Map<string, VarDef>();
  const cellsTb = t('cells');
  if (cellsTb.rows.length) errors.push(...requireColumns(cellsTb, ['id', 'formula']));
  const VAR_TYPES = ['number', 'boolean', 'string', 'duration', 'timeofday', 'timestamp'];
  const cellRoom = (tb: TsvTable, row: TsvRow): string | null | undefined => {
    const room = row.cells['room'] ?? '';
    if (!room) return null;
    if (rooms.size && !rooms.has(room)) {
      err(tb, row, `unknown room "${room}" (rooms.tsv has: ${[...rooms.keys()].join(', ')})`, 'room');
      return undefined;
    }
    return room;
  };
  const addVar = (tb: TsvTable, row: TsvRow) => {
    const id = row.cells['id'] ?? '';
    if (!ID_RE.test(id)) {
      err(tb, row, `bad cell id "${id}"`, 'id');
      return;
    }
    const initialText = row.cells['initial'] ?? '';
    let type = (row.cells['type'] ?? '').toLowerCase() as ValueType;
    if (!type) {
      if (!initialText) {
        err(tb, row, `a held cell needs a formula, an initial value or a type`, 'initial');
        return;
      }
      type = typeOf(parseLiteral(initialText));
    }
    if (!VAR_TYPES.includes(type)) {
      err(tb, row, `bad type "${row.cells['type']}" (${VAR_TYPES.join(', ')})`, 'type');
      return;
    }
    const initial = parseLiteral(initialText, type);
    if (initial !== null && typeOf(initial) !== type) {
      err(tb, row, `initial value "${initialText}" is not a ${type}`, 'initial');
      return;
    }
    if (vars.has(id)) {
      err(tb, row, `cell "${id}" is defined more than once`, 'id');
      return;
    }
    const room = cellRoom(tb, row);
    if (room === undefined) return;
    vars.set(id, { id, type, initial, room, file: tb.file, line: row.line });
    const def: CellDef = { id, type, kind: 'var', settable: true, transient: false };
    if (room) def.room = room;
    addCell(def, tb, row);
  };
  for (const row of cellsTb.rows) if (!(row.cells['formula'] ?? '')) addVar(cellsTb, row);
  {
    const tb = t('vars');
    if (tb.rows.length) errors.push(...requireColumns(tb, ['id', 'type', 'initial']));
    for (const row of tb.rows) addVar(tb, row);
  }

  const resolve = (ref: string): string => aliases.get(ref) ?? ref;
  const refTypes = (ref: string): ValueType | undefined => cells.get(resolve(ref))?.type;

  // ---- derived (typed in dependency order) ----------------------------------------------
  const derived = new Map<string, DerivedDef>();
  {
    const legacy = t('derived');
    if (legacy.rows.length) errors.push(...requireColumns(legacy, ['id', 'formula']));
    const formulaRows: { tb: TsvTable; row: TsvRow }[] = [
      ...cellsTb.rows.filter((row) => (row.cells['formula'] ?? '') !== '').map((row) => ({ tb: cellsTb, row })),
      ...legacy.rows.map((row) => ({ tb: legacy, row })),
    ];
    const pending: { tb: TsvTable; row: TsvRow; id: string; ast: Ast; refs: string[]; room: string | null }[] = [];
    for (const { tb, row } of formulaRows) {
      const id = row.cells['id'] ?? '';
      if (!ID_RE.test(id)) {
        err(tb, row, `bad derived id "${id}"`, 'id');
        continue;
      }
      if (cells.has(id) || aliases.has(id) || pending.some((p) => p.id === id)) {
        err(tb, row, `cell "${id}" is defined more than once`, 'id');
        continue;
      }
      const src = row.cells['formula'] ?? '';
      const room = cellRoom(tb, row);
      if (room === undefined) continue;
      try {
        const ast = formula.parse(src);
        pending.push({ tb, row, id, ast, refs: formula.refs(ast).map(resolve), room });
      } catch (e) {
        err(tb, row, formulaMessage(e), 'formula');
      }
    }
    // Register with type 'any' first so forward references resolve, then infer in topo order.
    for (const p of pending) {
      const def: CellDef = { id: p.id, type: 'any', kind: 'derived', settable: false, transient: false };
      if (p.room) def.room = p.room;
      cells.set(p.id, def);
    }
    const pendingIds = new Set(pending.map((p) => p.id));
    const done = new Set<string>();
    let progress = true;
    let remaining = [...pending];
    while (remaining.length && progress) {
      progress = false;
      const next: typeof remaining = [];
      for (const p of remaining) {
        const waitingOn = p.refs.filter((r) => pendingIds.has(r) && !done.has(r) && r !== p.id);
        if (waitingOn.length) {
          next.push(p);
          continue;
        }
        const check = formula.typeCheck(p.ast, refTypes);
        for (const e of check.errors) err(p.tb, p.row, e.message, 'formula');
        cells.get(p.id)!.type = check.type;
        derived.set(p.id, {
          id: p.id,
          formula: p.ast,
          source: p.row.cells['formula'] ?? '',
          type: check.type,
          timeDependent: formula.isTimeDependent(p.ast),
          refs: p.refs,
          room: p.room,
          file: p.tb.file,
          line: p.row.line,
        });
        done.add(p.id);
        progress = true;
      }
      remaining = next;
    }
    for (const p of remaining) {
      err(p.tb, p.row, `formula is part of a dependency cycle: ${[p.id, ...p.refs.filter((r) => pendingIds.has(r) && !done.has(r))].join(' -> ')}`, 'formula');
    }
  }

  const classify = (name: string): 'device' | 'var' | undefined => (devices.has(name) ? 'device' : vars.has(name) ? 'var' : undefined);
  const actionCtx = { classify };

  const checkActionFormulas = (table: TsvTable, row: TsvRow, actions: ActionDef[], column: string) => {
    for (const a of actions) {
      for (const f of actionFormulas(a)) {
        for (const e of formula.typeCheck(f.ast, refTypes).errors) err(table, row, `in {${f.source}}: ${e.message}`, column);
      }
      if ((a.kind === 'set-device' || a.kind === 'fade') && !devices.has(a.device)) err(table, row, `unknown device "${a.device}"`, column);
      if (a.kind === 'set-device' || a.kind === 'fade') {
        // Validate literal-only target tokens now; templated ones are validated when they run.
        const literal = a.tokens.filter((tk) => tk.every((p) => p.kind === 'text')).map((tk) => tk.map((p) => (p.kind === 'text' ? p.text : '')).join(''));
        try {
          const dev = devices.get(a.device);
          if (dev) dev.kind.toPayload(parseTargets(literal), () => null);
        } catch (e) {
          err(table, row, `${a.source}: ${(e as Error).message}`, column);
        }
      }
    }
  };

  const parseActionsChecked = (table: TsvTable, row: TsvRow, text: string, column: string): ActionDef[] => {
    try {
      const actions = parseActions(text, actionCtx);
      checkActionFormulas(table, row, actions, column);
      return actions;
    } catch (e) {
      if (e instanceof ActionParseError || e instanceof FormulaError) err(table, row, e.message, column);
      else throw e;
      return [];
    }
  };

  // ---- scenes (grid) ---------------------------------------------------------------------
  const scenes = new Map<string, SceneDef>();
  {
    const tb = t('scenes');
    if (tb.rows.length) errors.push(...requireColumns(tb, ['device']));
    const sceneNames = tb.header.filter((h) => h !== 'device');
    for (const name of sceneNames) scenes.set(name, { name, targets: [], file: tb.file, line: 1 });
    for (const row of tb.rows) {
      const device = row.cells['device'] ?? '';
      const dev = devices.get(device);
      if (!dev) {
        err(tb, row, `unknown device "${device}"`, 'device');
        continue;
      }
      for (const name of sceneNames) {
        const cell = row.cells[name] ?? '';
        if (!cell) continue;
        const tokens = cell.split(/\s+/);
        try {
          dev.kind.toPayload(parseTargets(tokens), () => null);
        } catch (e) {
          err(tb, row, `scene "${name}": ${(e as Error).message}`, name);
          continue;
        }
        scenes.get(name)!.targets.push({ device, tokens, line: row.line });
      }
    }
  }

  // ---- rules -----------------------------------------------------------------------------
  const rules: RuleDef[] = [];
  {
    const tb = t('rules');
    if (tb.rows.length) errors.push(...requireColumns(tb, ['id', 'then']));
    const ids = new Set<string>();
    for (const row of tb.rows) {
      const id = row.cells['id'] ?? '';
      if (!/^[a-z_][a-z0-9_]*$/.test(id)) {
        err(tb, row, `bad rule id "${id}"`, 'id');
        continue;
      }
      if (ids.has(id)) err(tb, row, `rule id "${id}" is used twice`, 'id');
      ids.add(id);
      const trigger = parseTrigger(row.cells['when'] ?? '');
      if (!trigger) {
        err(tb, row, `bad trigger "${row.cells['when']}" (empty, "on <cell>", "on event", or "at HH:MM|sunrise|sunset[+-offset] [days]")`, 'when');
        continue;
      }
      if (trigger.kind === 'change' && !cells.has(resolve(trigger.cell))) {
        err(tb, row, `unknown cell "${trigger.cell}" in trigger`, 'when');
        continue;
      }
      const condSrc = row.cells['if'] ?? '';
      let condition: Ast | null = null;
      let condRefs: string[] = [];
      let condTime = false;
      if (condSrc) {
        try {
          condition = formula.parse(condSrc);
          const check = formula.typeCheck(condition, refTypes);
          for (const e of check.errors) err(tb, row, e.message, 'if');
          if (check.type !== 'boolean' && check.type !== 'any' && check.type !== 'null') err(tb, row, `condition must be TRUE/FALSE, this is a ${check.type}`, 'if');
          condRefs = formula.refs(condition).map(resolve);
          condTime = formula.isTimeDependent(condition);
        } catch (e) {
          err(tb, row, formulaMessage(e), 'if');
          continue;
        }
      } else if (trigger.kind === 'edge') {
        err(tb, row, `a rule without "when" needs an "if" condition to detect the rising edge`, 'if');
        continue;
      }
      const actions = parseActionsChecked(tb, row, row.cells['then'] ?? '', 'then');
      if (!actions.length) {
        if (!(row.cells['then'] ?? '')) err(tb, row, 'rule has no actions', 'then');
        continue;
      }
      const enabledText = (row.cells['enabled'] ?? 'yes').toLowerCase();
      const enabled = !['no', 'false', '0', 'off'].includes(enabledText);
      rules.push({
        id,
        trigger,
        condition,
        conditionSource: condSrc,
        conditionRefs: trigger.kind === 'change' ? [...new Set([...condRefs, resolve(trigger.cell)])] : condRefs,
        conditionTimeDependent: condTime,
        actions,
        enabled,
        note: row.cells['note'] ?? '',
        file: tb.file,
        line: row.line,
      });
    }
  }

  // ---- sequences -------------------------------------------------------------------------
  const sequences = new Map<string, SequenceDef>();
  {
    const tb = t('sequences');
    if (tb.rows.length) errors.push(...requireColumns(tb, ['sequence', 'step', 'action']));
    for (const row of tb.rows) {
      const id = row.cells['sequence'] ?? '';
      if (!/^[a-z_][a-z0-9_]*$/.test(id)) {
        err(tb, row, `bad sequence id "${id}"`, 'sequence');
        continue;
      }
      let seq = sequences.get(id);
      if (!seq) {
        seq = { id, steps: [], cancelIf: null, cancelIfSource: '', file: tb.file, line: row.line };
        sequences.set(id, seq);
      }
      const cancelSrc = row.cells['cancel_if'] ?? '';
      let cancelIf: Ast | null = null;
      if (cancelSrc) {
        try {
          cancelIf = formula.parse(cancelSrc);
          for (const e of formula.typeCheck(cancelIf, refTypes).errors) err(tb, row, e.message, 'cancel_if');
        } catch (e) {
          err(tb, row, formulaMessage(e), 'cancel_if');
          continue;
        }
      }
      const stepText = row.cells['step'] ?? '';
      if (stepText === '*') {
        seq.cancelIf = cancelIf;
        seq.cancelIfSource = cancelSrc;
        continue;
      }
      const step = Number(stepText);
      if (!Number.isInteger(step) || step < 1) {
        err(tb, row, `bad step "${stepText}" (1, 2, 3... or *)`, 'step');
        continue;
      }
      const afterText = row.cells['after'] || '0s';
      const after = parseDuration(afterText);
      if (!after) {
        err(tb, row, `bad delay "${afterText}"`, 'after');
        continue;
      }
      const actions = parseActionsChecked(tb, row, row.cells['action'] ?? '', 'action');
      if (actions.length > 1) err(tb, row, 'one action per step (add another step for the next action)', 'action');
      seq.steps.push({ step, afterMs: after.ms, action: actions[0] ?? null, cancelIf, cancelIfSource: cancelSrc, file: tb.file, line: row.line });
    }
    for (const seq of sequences.values()) {
      seq.steps.sort((a, b) => a.step - b.step);
      seq.steps.forEach((s, i) => {
        if (s.step !== i + 1) err(tb, s.line, `sequence "${seq.id}": steps must be numbered 1..n without gaps (found ${s.step} at position ${i + 1})`, 'step');
      });
    }
  }

  // ---- history ---------------------------------------------------------------------------
  const history: HistoryRecordDef[] = [];
  {
    const tb = t('history');
    if (tb.rows.length) errors.push(...requireColumns(tb, ['record', 'collection', 'field', 'formula']));
    const byRecord = new Map<string, HistoryRecordDef>();
    for (const row of tb.rows) {
      const record = row.cells['record'] ?? '';
      if (!/^[a-z_][a-z0-9_]*$/.test(record)) {
        err(tb, row, `bad record id "${record}"`, 'record');
        continue;
      }
      let rec = byRecord.get(record);
      if (!rec) {
        rec = { record, collection: row.cells['collection'] ?? '', minInterval: null, maxInterval: null, fields: [], refs: [], file: tb.file, line: row.line };
        byRecord.set(record, rec);
        history.push(rec);
      } else if (row.cells['collection'] && row.cells['collection'] !== rec.collection) {
        err(tb, row, `record "${record}" mixes collections "${rec.collection}" and "${row.cells['collection']}"`, 'collection');
      }
      const intervalText = row.cells['min_interval'] ?? '';
      if (intervalText) {
        const d = parseDuration(intervalText);
        if (!d) err(tb, row, `bad min_interval "${intervalText}"`, 'min_interval');
        else rec.minInterval = d;
      }
      const maxText = row.cells['max_interval'] ?? '';
      if (maxText) {
        const d = parseDuration(maxText);
        if (!d) err(tb, row, `bad max_interval "${maxText}"`, 'max_interval');
        else rec.maxInterval = d;
      }
      const src = row.cells['formula'] ?? '';
      try {
        const ast = formula.parse(src);
        for (const e of formula.typeCheck(ast, refTypes).errors) err(tb, row, e.message, 'formula');
        const refs = formula.refs(ast).map(resolve);
        const scaleText = row.cells['scale'] ?? '';
        const deltaText = row.cells['min_delta'] ?? '';
        rec.fields.push({
          field: row.cells['field'] ?? '',
          formula: ast,
          source: src,
          refs,
          scale: scaleText ? Number(scaleText) : null,
          minDelta: deltaText ? Number(deltaText) : null,
          file: tb.file,
          line: row.line,
        });
        rec.refs = [...new Set([...rec.refs, ...refs])];
      } catch (e) {
        err(tb, row, formulaMessage(e), 'formula');
      }
    }
  }

  // ---- cross references ------------------------------------------------------------------
  const checkRefs = (table: string, line: number, actions: ActionDef[]) => {
    for (const a of actions) {
      if (a.kind === 'scene' && !scenes.has(a.scene)) errors.push({ file: table, line, message: `unknown scene "${a.scene}"` });
      if ((a.kind === 'start' || a.kind === 'cancel') && !sequences.has(a.sequence)) errors.push({ file: table, line, message: `unknown sequence "${a.sequence}"` });
      if (a.kind === 'script' && !existsSync(join(dir, 'scripts', a.file))) errors.push({ file: table, line, message: `script file tables/scripts/${a.file} not found` });
    }
  };
  for (const r of rules) checkRefs(r.file, r.line, r.actions);
  for (const seq of sequences.values()) for (const st of seq.steps) if (st.action) checkRefs(st.file, st.line, [st.action]);

  // ---- since targets ----------------------------------------------------------------------
  const sinceTargets: Config['sinceTargets'] = [];
  const addSince = (ast: Ast) => {
    for (const s of formula.sinceTargets(ast)) sinceTargets.push({ ref: resolve(s.ref), value: s.value });
  };
  for (const d of derived.values()) addSince(d.formula);
  for (const r of rules) if (r.condition) addSince(r.condition);
  for (const seq of sequences.values()) {
    if (seq.cancelIf) addSince(seq.cancelIf);
    for (const st of seq.steps) if (st.cancelIf) addSince(st.cancelIf);
  }

  if (errors.length) return { ok: false, errors, warnings };
  return {
    ok: true,
    warnings,
    config: { dir, settings, rooms, devices, vars, derived, scenes, rules, sequences, history, cells, aliases, sinceTargets, timezone, latitude, longitude },
  };
}

function formulaMessage(e: unknown): string {
  if (e instanceof FormulaError) return `${e.message} (at character ${e.span.start + 1})`;
  return (e as Error).message;
}

export function parseDays(text: string): Set<number> | null {
  const t = text.trim().toLowerCase();
  if (t === 'daily' || t === 'all' || t === 'every' || t === 'everyday') return new Set([1, 2, 3, 4, 5, 6, 7]);
  const days = new Set<number>();
  for (const part of t.split(',')) {
    const range = part.trim().match(/^([a-z]{3})(?:-([a-z]{3}))?$/);
    if (!range) return null;
    const a = DAY_NAMES[range[1]!];
    const b = range[2] ? DAY_NAMES[range[2]] : a;
    if (a === undefined || b === undefined) return null;
    if (a <= b) for (let d = a; d <= b; d++) days.add(d);
    else {
      for (let d = a; d <= 7; d++) days.add(d);
      for (let d = 1; d <= b; d++) days.add(d);
    }
  }
  return days.size ? days : null;
}

export function parseScheduleTime(text: string): ScheduleTime | null {
  const t = text.trim().toLowerCase();
  const tod = parseTimeOfDay(t);
  if (tod) return { kind: 'clock', msSinceMidnight: tod.ms };
  const m = t.match(/^(sunrise|sunset)(?:([+-])(.+))?$/);
  if (!m) return null;
  let offsetMs = 0;
  if (m[2]) {
    const d = parseDuration(m[3] ?? '');
    if (!d) return null;
    offsetMs = m[2] === '-' ? -d.ms : d.ms;
  }
  return { kind: 'sun', event: m[1] as 'sunrise' | 'sunset', offsetMs };
}

export function parseTrigger(text: string): RuleTrigger | null {
  const t = text.trim();
  if (t === '') return { kind: 'edge' };
  let m = t.match(/^on\s+(\S+)$/i);
  if (m) {
    if (m[1]!.toLowerCase() === 'event') return { kind: 'event' };
    return ID_RE.test(m[1]!) ? { kind: 'change', cell: m[1]! } : null;
  }
  m = t.match(/^at\s+(\S+)(?:\s+(.+))?$/i);
  if (m) {
    const time = parseScheduleTime(m[1]!);
    if (!time) return null;
    const days = m[2] ? parseDays(m[2]) : new Set([1, 2, 3, 4, 5, 6, 7]);
    if (!days) return null;
    return { kind: 'at', time, text: `${m[1]}${m[2] ? ' ' + m[2] : ''}`.toLowerCase(), days };
  }
  return null;
}

/** Value for a settings key, typed. */
export function settingNumber(config: Config, key: string, fallback: number): number {
  const v = config.settings.get(key)?.value;
  return typeof v === 'number' ? v : fallback;
}

export function settingDurationMs(config: Config, key: string, fallbackMs: number): number {
  const v = config.settings.get(key)?.value;
  return v && typeof v === 'object' && 'ms' in v ? (v as { ms: number }).ms : fallbackMs;
}

export function settingString(config: Config, key: string, fallback: string): string {
  const v = config.settings.get(key)?.value;
  return typeof v === 'string' ? v : fallback;
}

export type { Value };
