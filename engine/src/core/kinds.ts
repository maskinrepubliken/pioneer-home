/**
 * Device kinds: which cells a device exposes, how incoming JSON payloads map onto them,
 * and how target tokens from actions (`on`, `60%`, `2700K`, `brightness+=20%`, `key=value`)
 * turn into a /set payload. This is the single place to extend when a new device type arrives.
 *
 * Cell conventions: brightness is 0-100 %, colour temperature is Kelvin, booleans are booleans.
 * zigbee2mqtt speaks 0-254 and mireds; the conversion happens here and nowhere else.
 */
import type { Value, ValueType } from '../formula/values.js';

export interface CellSpec {
  prop: string;
  type: ValueType;
  /** Can be written with `set <device> ...` */
  settable?: boolean;
  /** Every incoming report counts as a change even if the value is identical (button actions). */
  transient?: boolean;
}

export type RawState = Record<string, unknown>;

export interface KindSpec {
  name: string;
  /** The prop the bare device id refers to (`hall.light` = `hall.light.state`). */
  primary: string;
  cells: CellSpec[];
  /** Maps a JSON payload from the device to cell values. Only keys present in the payload are returned. */
  fromPayload(payload: RawState): Record<string, Value>;
  /** Builds the /set payload for a list of targets. `current` gives current cell values for relative changes. */
  toPayload(targets: Target[], current: (prop: string) => Value): RawState;
  /** Predicts the raw state a well-behaved device would report after applying `set`. Used by the simulator. */
  applySet(state: RawState, set: RawState): RawState;
}

export interface Target {
  key: string;
  value: string;
  op: '=' | '+=' | '-=';
}

const KIND_ERR = (msg: string) => new Error(msg);

/**
 * Parses target tokens. Examples:
 *   on | off | 60% | 2700K | brightness+=20% | color=#ff0000 | transition=2s | setpoint=21.5 | mode=heat
 */
export function parseTargets(tokens: string[]): Target[] {
  const out: Target[] = [];
  for (const raw of tokens) {
    const tok = raw.trim();
    if (!tok) continue;
    const lower = tok.toLowerCase();
    if (lower === 'on' || lower === 'off') {
      out.push({ key: 'state', value: lower, op: '=' });
      continue;
    }
    let m = tok.match(/^(\d+(?:\.\d+)?)%$/);
    if (m) {
      out.push({ key: 'brightness', value: m[1]!, op: '=' });
      continue;
    }
    m = tok.match(/^(\d+)k$/i);
    if (m) {
      out.push({ key: 'color_temp', value: m[1]!, op: '=' });
      continue;
    }
    m = tok.match(/^([a-z_]+)(\+=|-=|=)(.+)$/i);
    if (m) {
      out.push({ key: m[1]!.toLowerCase(), value: m[3]!.replace(/%$/, ''), op: m[2] as Target['op'] });
      continue;
    }
    if (/^\d+(\.\d+)?$/.test(tok)) {
      // bare number: level for pwm, setpoint for thermostat; kinds interpret 'level'
      out.push({ key: 'level', value: tok, op: '=' });
      continue;
    }
    throw KIND_ERR(`cannot understand target "${tok}"`);
  }
  return out;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function onOff(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.toUpperCase();
    if (s === 'ON' || s === 'TRUE') return true;
    if (s === 'OFF' || s === 'FALSE') return false;
  }
  return null;
}

const pctFrom254 = (v: number) => Math.round((v / 254) * 100);
const pctTo254 = (pct: number) => Math.round((Math.max(0, Math.min(100, pct)) / 100) * 254);
const kelvinFromMireds = (m: number) => (m > 0 ? Math.round(1_000_000 / m) : 0);
const miredsFromKelvin = (k: number) => (k > 0 ? Math.round(1_000_000 / k) : 0);

function transitionSeconds(value: string): number {
  const m = value.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/);
  if (!m) throw KIND_ERR(`bad transition "${value}"`);
  const n = Number(m[1]);
  return m[2] === 'ms' ? n / 1000 : m[2] === 'm' ? n * 60 : n;
}

const light: KindSpec = {
  name: 'light',
  primary: 'state',
  cells: [
    { prop: 'state', type: 'boolean', settable: true },
    { prop: 'brightness', type: 'number', settable: true },
    { prop: 'color_temp', type: 'number', settable: true },
    { prop: 'color', type: 'string', settable: true },
    { prop: 'linkquality', type: 'number' },
  ],
  fromPayload(p) {
    const out: Record<string, Value> = {};
    if ('state' in p) out['state'] = onOff(p['state']);
    const b = num(p['brightness']);
    if (b !== null) out['brightness'] = pctFrom254(b);
    const ct = num(p['color_temp']);
    if (ct !== null) out['color_temp'] = kelvinFromMireds(ct);
    const c = p['color'];
    if (c && typeof c === 'object') {
      const o = c as Record<string, unknown>;
      if (typeof o['hex'] === 'string') out['color'] = o['hex'].toLowerCase();
      else if (typeof o['x'] === 'number' && typeof o['y'] === 'number') out['color'] = `xy(${o['x']},${o['y']})`;
    }
    const lq = num(p['linkquality']);
    if (lq !== null) out['linkquality'] = lq;
    return out;
  },
  toPayload(targets) {
    const set: RawState = {};
    for (const t of targets) {
      switch (t.key) {
        case 'state':
          set['state'] = t.value === 'on' ? 'ON' : 'OFF';
          break;
        case 'brightness': {
          const v = Number(t.value);
          if (Number.isNaN(v)) throw KIND_ERR(`bad brightness "${t.value}"`);
          if (t.op === '=') {
            set['brightness'] = pctTo254(v);
            if (v > 0 && !('state' in set)) set['state'] = 'ON';
          } else {
            // Relative change: let the device do the maths (works even when we do not know the current level).
            const step = Math.round((v / 100) * 254);
            if (t.op === '+=') set['brightness_step_onoff'] = step;
            else set['brightness_step'] = -step;
          }
          break;
        }
        case 'color_temp':
          set['color_temp'] = miredsFromKelvin(Number(t.value));
          break;
        case 'color':
          set['color'] = { hex: t.value };
          break;
        case 'transition':
          set['transition'] = transitionSeconds(t.value);
          break;
        default:
          set[t.key] = t.value;
      }
    }
    return set;
  },
  applySet(state, set) {
    const next: RawState = { ...state };
    for (const [k, v] of Object.entries(set)) {
      if (k === 'transition') continue;
      if (k === 'brightness_step' || k === 'brightness_step_onoff') {
        const level = Math.max(0, Math.min(254, (num(state['brightness']) ?? 0) + (num(v) ?? 0)));
        next['brightness'] = level;
        if (k === 'brightness_step_onoff' && level > 0) next['state'] = 'ON';
        if (level === 0 && k === 'brightness_step') next['state'] = 'OFF';
        continue;
      }
      next[k] = v;
    }
    if (set['brightness'] !== undefined && set['state'] === undefined && (num(set['brightness']) ?? 0) > 0) next['state'] = 'ON';
    return next;
  },
};

const plug: KindSpec = {
  name: 'plug',
  primary: 'state',
  cells: [
    { prop: 'state', type: 'boolean', settable: true },
    { prop: 'power', type: 'number' },
    { prop: 'energy', type: 'number' },
    { prop: 'linkquality', type: 'number' },
  ],
  fromPayload(p) {
    const out: Record<string, Value> = {};
    if ('state' in p) out['state'] = onOff(p['state']);
    for (const k of ['power', 'energy', 'linkquality'] as const) {
      const v = num(p[k]);
      if (v !== null) out[k] = v;
    }
    return out;
  },
  toPayload(targets) {
    const set: RawState = {};
    for (const t of targets) {
      if (t.key === 'state') set['state'] = t.value === 'on' ? 'ON' : 'OFF';
      else throw KIND_ERR(`plug cannot set "${t.key}"`);
    }
    return set;
  },
  applySet(state, set) {
    return { ...state, ...set };
  },
};

const motion: KindSpec = {
  name: 'motion',
  primary: 'occupancy',
  cells: [
    { prop: 'occupancy', type: 'boolean' },
    { prop: 'illuminance', type: 'number' },
    { prop: 'temperature', type: 'number' },
    { prop: 'battery', type: 'number' },
    { prop: 'linkquality', type: 'number' },
  ],
  fromPayload(p) {
    const out: Record<string, Value> = {};
    if ('occupancy' in p) out['occupancy'] = onOff(p['occupancy']);
    for (const k of ['illuminance', 'temperature', 'battery', 'linkquality'] as const) {
      const v = num(p[k]);
      if (v !== null) out[k] = v;
    }
    return out;
  },
  toPayload() {
    throw KIND_ERR('motion sensors are read-only');
  },
  applySet(state) {
    return state;
  },
};

const contact: KindSpec = {
  name: 'contact',
  primary: 'open',
  cells: [
    { prop: 'open', type: 'boolean' },
    { prop: 'battery', type: 'number' },
    { prop: 'linkquality', type: 'number' },
  ],
  fromPayload(p) {
    const out: Record<string, Value> = {};
    if ('contact' in p) {
      const c = onOff(p['contact']);
      out['open'] = c === null ? null : !c;
    }
    for (const k of ['battery', 'linkquality'] as const) {
      const v = num(p[k]);
      if (v !== null) out[k] = v;
    }
    return out;
  },
  toPayload() {
    throw KIND_ERR('contact sensors are read-only');
  },
  applySet(state) {
    return state;
  },
};

/** Schneider WDE0xxxx floor thermostats and the Namron panel heater share this shape. */
const thermostat: KindSpec = {
  name: 'thermostat',
  primary: 'temperature',
  cells: [
    { prop: 'temperature', type: 'number' },
    { prop: 'setpoint', type: 'number', settable: true },
    { prop: 'demand', type: 'number' },
    { prop: 'mode', type: 'string', settable: true },
    { prop: 'running', type: 'string' },
    { prop: 'linkquality', type: 'number' },
  ],
  fromPayload(p) {
    const out: Record<string, Value> = {};
    const t = num(p['local_temperature']);
    if (t !== null) out['temperature'] = t;
    const sp = num(p['occupied_heating_setpoint']);
    if (sp !== null) out['setpoint'] = sp;
    const d = num(p['pi_heating_demand']);
    if (d !== null) out['demand'] = d;
    if (typeof p['system_mode'] === 'string') out['mode'] = p['system_mode'];
    if (typeof p['running_state'] === 'string') out['running'] = p['running_state'];
    const lq = num(p['linkquality']);
    if (lq !== null) out['linkquality'] = lq;
    return out;
  },
  toPayload(targets) {
    const set: RawState = {};
    for (const t of targets) {
      if (t.key === 'setpoint' || t.key === 'level') set['occupied_heating_setpoint'] = Number(t.value);
      else if (t.key === 'mode') set['system_mode'] = t.value;
      else throw KIND_ERR(`thermostat cannot set "${t.key}"`);
    }
    return set;
  },
  applySet(state, set) {
    return { ...state, ...set };
  },
};

/** Hue dimmer and similar: every press is reported as an `action` string. */
const remote: KindSpec = {
  name: 'remote',
  primary: 'action',
  cells: [
    { prop: 'action', type: 'string', transient: true },
    { prop: 'battery', type: 'number' },
    { prop: 'linkquality', type: 'number' },
  ],
  fromPayload(p) {
    const out: Record<string, Value> = {};
    if (typeof p['action'] === 'string' && p['action'] !== '') out['action'] = p['action'];
    for (const k of ['battery', 'linkquality'] as const) {
      const v = num(p[k]);
      if (v !== null) out[k] = v;
    }
    return out;
  },
  toPayload() {
    throw KIND_ERR('remotes are read-only');
  },
  applySet(state) {
    return state;
  },
};

/** Temperature / humidity sensor publishing JSON {temperature, humidity} (GPIO service or Zigbee T&H). */
const climate: KindSpec = {
  name: 'climate',
  primary: 'temperature',
  cells: [
    { prop: 'temperature', type: 'number' },
    { prop: 'humidity', type: 'number' },
    { prop: 'pressure', type: 'number' },
    { prop: 'battery', type: 'number' },
    { prop: 'linkquality', type: 'number' },
  ],
  fromPayload(p) {
    const out: Record<string, Value> = {};
    for (const k of ['temperature', 'humidity', 'pressure', 'battery', 'linkquality'] as const) {
      const v = num(p[k]);
      if (v !== null) out[k] = v;
    }
    return out;
  },
  toPayload() {
    throw KIND_ERR('climate sensors are read-only');
  },
  applySet(state) {
    return state;
  },
};

/** A PWM output driven by the GPIO service: {level: 0-100}. */
const pwm: KindSpec = {
  name: 'pwm',
  primary: 'level',
  cells: [{ prop: 'level', type: 'number', settable: true }],
  fromPayload(p) {
    const out: Record<string, Value> = {};
    const v = num(p['level']);
    if (v !== null) out['level'] = v;
    return out;
  },
  toPayload(targets) {
    const set: RawState = {};
    for (const t of targets) {
      if (t.key === 'level' || t.key === 'brightness') set['level'] = Math.max(0, Math.min(100, Math.round(Number(t.value))));
      else if (t.key === 'state') set['level'] = t.value === 'on' ? 100 : 0;
      else throw KIND_ERR(`pwm cannot set "${t.key}"`);
    }
    return set;
  },
  applySet(state, set) {
    return { ...state, ...set };
  },
};

export const KINDS: Record<string, KindSpec> = { light, plug, motion, contact, thermostat, remote, climate, pwm };

export function getKind(name: string): KindSpec | undefined {
  return KINDS[name];
}
