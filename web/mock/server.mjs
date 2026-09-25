// Tiny fake engine for developing the UI without the Pi: `pnpm --filter web mock` then `pnpm --filter web dev`.
// Serves /api/* on :8000 with random cell changes over SSE. Not used in production.
import { createServer } from 'node:http';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 8000);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TABLES = existsSync(join(ROOT, 'tables')) ? join(ROOT, 'tables') : join(ROOT, 'example', 'tables');
const started = Date.now();
const ts = (ms) => ({ $timestamp: ms });

// Rooms and devices come from the real tables/rooms.tsv and tables/devices.tsv so the mock follows the config.
// Device ids are the device's own name (lamp1, motion1, climate1), the room is a column and the cells <id>.room / <id>.room_name.
/** Rows of a TSV text, header-keyed; comments and blank lines skipped. */
function parseRows(text) {
  const rows = [];
  let header = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cells = raw.split('\t').map((c) => c.trim());
    if (!header) header = cells;
    else rows.push(Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
  }
  return rows;
}
const readTsv = (file) => parseRows(readFileSync(join(TABLES, file), 'utf8'));
let rooms = readTsv('rooms.tsv').map((r) => ({ id: r.id, name: r.name || r.id }));
const roomNameOf = (id) => rooms.find((r) => r.id === id)?.name ?? (id || null);
const devices = readTsv('devices.tsv').map((r) => ({ id: r.id, room: r.room, kind: r.kind, name: r.name || r.id }));
const OFFLINE = new Set(['floor2']); // not seen since January: shows the offline state

const props = {
  light: { state: ['boolean', true], brightness: ['number', 60], color_temp: ['number', 2700], color: ['string', null], linkquality: ['number', 120] },
  plug: { state: ['boolean', false], power: ['number', null], linkquality: ['number', 90] },
  motion: { occupancy: ['boolean', false], illuminance: ['number', 120], temperature: ['number', 20.5], battery: ['number', 88], linkquality: ['number', 110] },
  thermostat: { temperature: ['number', 21.2], setpoint: ['number', 21], demand: ['number', 35], mode: ['string', 'heat'], running: ['string', 'heat'], linkquality: ['number', 60] },
  remote: { action: ['string', null], battery: ['number', 100], linkquality: ['number', 130] },
  climate: { temperature: ['number', 18.7], humidity: ['number', 54], linkquality: ['number', null] },
  pwm: { level: ['number', 40] },
  contact: { contact: ['boolean', true], battery: ['number', 95], linkquality: ['number', 100] },
};
const settable = new Set(['state', 'brightness', 'color_temp', 'color', 'setpoint', 'mode', 'level']);

const cells = new Map();
const put = (c) => cells.set(c.id, { changedAt: Date.now() - Math.random() * 3.6e6, seenAt: Date.now(), ...c });
for (const d of devices) {
  const dead = OFFLINE.has(d.id);
  for (const [prop, [type, value]] of Object.entries(props[d.kind] ?? {})) {
    put({ id: `${d.id}.${prop}`, value: dead ? null : value, type, kind: 'input', settable: settable.has(prop), device: d.id, prop, room: d.room, name: d.name });
  }
  put({ id: `${d.id}.available`, value: !dead, type: 'boolean', kind: 'input', settable: false, device: d.id, prop: 'available', room: d.room, name: d.name });
  put({ id: `${d.id}.last_seen`, value: ts(Date.now() - 120000), type: 'timestamp', kind: 'input', settable: false, device: d.id, prop: 'last_seen', room: d.room, name: d.name });
  put({ id: `${d.id}.room`, value: d.room || null, type: 'string', kind: 'input', settable: false, device: d.id, prop: 'room', room: d.room, name: d.name });
  put({ id: `${d.id}.room_name`, value: roomNameOf(d.room), type: 'string', kind: 'input', settable: false, device: d.id, prop: 'room_name', room: d.room, name: d.name });
}
const sys = (id, value, type, kind = 'input') => put({ id, value, type, kind, settable: kind === 'var', device: null, prop: null, room: null, name: null });
sys('fan_auto', true, 'boolean', 'var');
sys('sun.elevation', 23.4, 'number');
sys('sun.azimuth', 190, 'number');
sys('sun.up', true, 'boolean');
sys('dark', false, 'boolean', 'derived');
sys('night_window', false, 'boolean', 'derived');
sys('late_night', false, 'boolean', 'derived');
sys('fan_target', 48, 'number', 'derived');
sys('fan_wanted', 0, 'number', 'derived');
sys('too_dry', false, 'boolean', 'derived');
sys('too_humid', false, 'boolean', 'derived');
sys('floor1_heating', true, 'boolean', 'derived');
sys('floor2_heating', null, 'boolean', 'derived');
// thresholds are cells.tsv rows with a number as formula
for (const [id, v] of [['dark_elevation', -3], ['fan_off_temp', 17], ['fan_min_temp', 17.5], ['fan_max_temp', 20], ['humidifier_on_below', 50], ['humidifier_off_above', 60]]) sys(id, v, 'number', 'derived');
sys('history_flush', { $duration: 10000 }, 'duration', 'setting');
sys('weather_interval', { $duration: 1200000 }, 'duration', 'setting');
sys('timezone', 'Europe/Stockholm', 'string', 'setting');

/**
 * Hot reload as the engine does it: after devices.tsv or rooms.tsv is saved, rooms and the <id>.room / <id>.room_name
 * cells follow the new text and a fresh `state` snapshot goes out over SSE, so the Live view regroups.
 */
function reloadRooms() {
  const roomRows = parseSaved('rooms.tsv');
  rooms = roomRows.map((r) => ({ id: r.id, name: r.name || r.id }));
  for (const r of parseSaved('devices.tsv')) {
    const d = devices.find((d) => d.id === r.id);
    if (!d) continue;
    d.room = r.room;
    d.name = r.name || d.name;
    for (const c of cells.values()) if (c.device === d.id) c.room = d.room;
    const rc = cells.get(`${d.id}.room`);
    const nc = cells.get(`${d.id}.room_name`);
    if (rc && rc.value !== (d.room || null)) change(`${d.id}.room`, d.room || null);
    if (nc && nc.value !== roomNameOf(d.room)) change(`${d.id}.room_name`, roomNameOf(d.room));
  }
  broadcast('state', snapshot());
}

let configError = null;
const traces = [];
const clients = new Set();
const snapshot = () => ({ at: Date.now(), configError, cells: [...cells.values()] });
const broadcast = (event, data) => {
  for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};
function change(id, to) {
  const c = cells.get(id);
  if (!c) return null;
  const from = c.value;
  c.value = to;
  c.changedAt = c.seenAt = Date.now();
  return { cell: id, from, to };
}
function pushTrace(t) {
  traces.push(t);
  if (traces.length > 200) traces.shift();
  broadcast('trace', t);
  return t;
}
function pass(cause, changes, extra = {}) {
  broadcast('changes', changes);
  return pushTrace({
    cause,
    at: Date.now(),
    changed: changes,
    derived: [],
    rules: [
      { id: 'fan_follow', fired: false, cond: false, reason: 'condition FALSE' },
      { id: 'humid_on', fired: false, cond: null, reason: 'condition NULL' },
    ],
    actions: [],
    sequences: [],
    errors: [],
    ...extra,
  });
}

// Random activity
setInterval(() => {
  const r = Math.random();
  if (r < 0.4) {
    const t = Math.round((18 + Math.random() * 3) * 10) / 10;
    const ch = [change('climate1.temperature', t), change('fan_target', Math.round(Math.random() * 100))];
    pass('mqtt home/gpio/climate1', ch, {
      derived: [{ cell: 'too_dry', from: false, to: false }],
    });
  } else if (r < 0.7) {
    const occ = !cells.get('motion1.occupancy').value;
    const fired = occ && Math.random() > 0.5;
    pass('mqtt zigbee2mqtt/MOTION1', [change('motion1.occupancy', occ), change('motion1.illuminance', Math.round(Math.random() * 400))], {
      rules: [{ id: 'remote_on', fired, cond: fired, reason: fired ? 'rising edge' : 'condition FALSE' }],
      actions: fired ? [{ source: 'rule remote_on', detail: 'set lamp1 on 2000K', topic: 'zigbee2mqtt/LAMP1/set', payload: '{"state":"ON","color_temp":500}', dryRun: true }] : [],
    });
  } else if (r < 0.8) {
    pass('tick', [], { rules: [] });
  } else if (r < 0.9) {
    pass('mqtt zigbee2mqtt/REMOTE1', [change('remote1.action', 'on_press_release')], {
      errors: ['rate guard: lamp1 received 11 commands in 10s, dropped'],
    });
  } else {
    pass('mqtt zigbee2mqtt/FLOOR1', [change('floor1.demand', Math.round(Math.random() * 100))]);
  }
}, 4000);

// Tables saved from the UI are kept in memory only (never written to tables/).
const savedTables = new Map();
const tableText = (f) => savedTables.get(f) ?? readFileSync(join(TABLES, f), 'utf8');
/** Rows of a table as saved in the UI (or on disk). */
const parseSaved = (file) => parseRows(tableText(file));

function tables() {
  const files = {};
  for (const f of readdirSync(TABLES)) if (f.endsWith('.tsv')) files[f] = tableText(f);
  return {
    files,
    rooms,
    rules: parseSaved('rules.tsv').map((r, i) => ({ id: r.id, enabled: r.enabled !== 'no', condition: r.if ?? '', file: 'rules.tsv', line: 6 + i })),
    devices,
    scenes: ['off', 'evening', 'night', 'red'],
    sequences: ['goodnight'],
  };
}

function history(collection, since, until) {
  const items = [];
  const step = Math.max(5 * 60_000, (until - since) / 600);
  for (let t = since; t <= until; t += step) {
    const when = new Date(t).toISOString();
    const day = Math.sin((t / 86_400_000) * Math.PI * 2);
    if (collection === 'climate') {
      items.push({ sensor: 'climate1', location: 'bedroom', temperature: 18 + day * 1.5 + Math.random() * 0.3, humidity: 0.5 + Math.random() * 0.05, when });
      items.push({ sensor: 'climate2', location: 'workshop', temperature: 12 + day * 3 + Math.random() * 0.4, humidity: 0.7 + Math.random() * 0.05, when });
      items.push({ sensor: 'motion1', location: 'living room', temperature: 20.5 + day + Math.random() * 0.2, illuminance: Math.max(0, day * 300 + Math.random() * 20), when });
    } else if (collection === 'heating') {
      items.push({ sensor: 'FLOOR1', pi: Math.round(40 + day * 30), heating: true, current: 21 + day * 0.4, target: 21, when });
    } else if (collection === 'power') {
      if (Math.random() < 0.2) items.push({ name: 'fan', powerlevel: Math.round(Math.random() * 100), when });
      if (Math.random() < 0.1) items.push({ name: 'humidifier', powerlevel: Math.random() > 0.5 ? 100 : 0, when });
      if (Math.random() < 0.02) items.push({ name: 'automatic_control', powerlevel: Math.random() > 0.3 ? 100 : 0, when });
    } else if (collection === 'weather') {
      items.push({ temperature: 9 + day * 5 + Math.random(), humidity: 80, windspeed: 3, precipitation: 0, detail: 'clouds', icon: '04d', when });
    }
  }
  return { items };
}

/** Same normalisation as the engine: trimmed cells, tabs only, LF, comments kept at the top, blank lines dropped. */
function normaliseTsv(text) {
  const comments = [];
  const body = [];
  let seenHeader = false;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.trim() === '') continue;
    if (raw.trimStart().startsWith('#') && !seenHeader) {
      comments.push(raw.trim());
      continue;
    }
    seenHeader = true;
    body.push(raw);
  }
  const rows = body.map((l) => l.split('\t').map((f) => f.trim()));
  const header = rows.shift() ?? [];
  const out = [...comments, header.join('\t')];
  for (const r of rows) {
    const cells = [...r];
    while (cells.length > 1 && cells[cells.length - 1] === '') cells.pop();
    out.push(cells.join('\t'));
  }
  return out.join('\n') + '\n';
}

/** Fake validation: any cell containing "ligth" is an error on that line, in the column the cell sits in. */
function validateTsv(file, text) {
  const errors = [];
  let header = null;
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '' || line.trimStart().startsWith('#')) return;
    const cells = line.split('\t').map((c) => c.trim());
    if (!header) {
      header = cells;
      return;
    }
    const at = cells.findIndex((c) => c.includes('ligth'));
    if (at >= 0) errors.push({ file, line: i + 1, column: header[at] ?? 'if', message: 'unknown cell "ligth" (did you mean "light"?)' });
  });
  return { errors, messages: errors.map((e) => `${e.file}:${e.line} [${e.column}] ${e.message}`) };
}

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(s || '{}'));
      } catch {
        resolve({});
      }
    });
  });

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/api/health') return json(res, 200, { ok: true, dryRun: true, configError, uptimeSeconds: Math.round((Date.now() - started) / 1000), now: Date.now(), timezone: 'Europe/Stockholm', sequences: [] });
  if (p === '/api/state') return json(res, 200, snapshot());
  if (p === '/api/tables') return json(res, 200, tables());
  if (p.startsWith('/api/tables/') && req.method === 'PUT') {
    const file = decodeURIComponent(p.slice('/api/tables/'.length));
    if (!(file in tables().files)) return json(res, 404, { error: `unknown table ${file}` });
    const { text, validateOnly } = await readBody(req);
    if (typeof text !== 'string') return json(res, 400, { error: 'body must be { "text": "<tsv>" }' });
    await new Promise((r) => setTimeout(r, 250)); // a little latency so "Kontrollerar…" can be seen
    const { errors, messages } = validateTsv(file, text);
    if (validateOnly) return json(res, 200, { ok: errors.length === 0, errors, messages });
    if (errors.length) return json(res, 422, { ok: false, errors, messages });
    const normalised = normaliseTsv(text);
    savedTables.set(file, normalised);
    console.log(`saved ${file} (${normalised.split('\n').length - 1} lines, in memory)`);
    if (file === 'devices.tsv' || file === 'rooms.tsv') reloadRooms();
    broadcast('config', { error: null, at: Date.now() });
    return json(res, 200, { ok: true, text: normalised, reloadError: null });
  }
  if (p === '/api/trace') return json(res, 200, traces);
  if (p.startsWith('/api/history/')) {
    if (process.env.NO_HISTORY) return json(res, 404, { error: 'not found' });
    const since = Date.parse(url.searchParams.get('since') ?? '') || Date.now() - 86_400_000;
    const until = Date.parse(url.searchParams.get('until') ?? '') || Date.now();
    return json(res, 200, history(p.slice('/api/history/'.length), since, until));
  }
  if (p === '/api/action' && req.method === 'POST') {
    const { action } = await readBody(req);
    if (!action) return json(res, 400, { error: 'body must be { "action": "..." }' });
    const m = action.match(/^set\s+(\S+)\s+(.+)$/);
    const changes = [];
    if (m) {
      const [, target, rest] = m;
      const tokens = rest.split(/\s+/);
      const dev = devices.find((d) => d.id === target);
      if (dev) {
        for (const tok of tokens) {
          if (tok === 'on' || tok === 'off') changes.push(change(`${target}.state`, tok === 'on'));
          else if (/^\d+%$/.test(tok)) changes.push(change(`${target}.brightness`, Number(tok.slice(0, -1))));
          else if (/^\d+K$/.test(tok)) changes.push(change(`${target}.color_temp`, Number(tok.slice(0, -1))));
          else if (/^setpoint=/.test(tok)) changes.push(change(`${target}.setpoint`, Number(tok.slice(9))));
          else if (/^\d+$/.test(tok) && dev.kind === 'pwm') changes.push(change(`${target}.level`, Number(tok)));
        }
      } else if (cells.get(target)?.kind === 'var') {
        const v = rest === 'TRUE' ? true : rest === 'FALSE' ? false : /^-?\d+(\.\d+)?$/.test(rest) ? Number(rest) : rest;
        changes.push(change(target, v));
      }
    }
    const t = pass(`api ${action}`, changes.filter(Boolean), {
      actions: [{ source: 'api', detail: action, topic: `zigbee2mqtt/${m?.[1] ?? '?'}/set`, payload: '{}', dryRun: true }],
      errors: m ? [] : [`unknown action "${action}"`],
    });
    return json(res, 200, { ok: t.errors.length === 0, traces: [t] });
  }
  if (p === '/api/event' && req.method === 'POST') {
    const { event } = await readBody(req);
    const t = pass(`api event ${event}`, [change('event', event)], {});
    return json(res, 200, { ok: true, traces: [t] });
  }
  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }
  json(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log(`mock engine on http://localhost:${PORT}  (NO_HISTORY=1 to simulate missing history)`));

// Flip a config error on and off now and then so the banner can be seen.
setInterval(() => {
  configError = configError ? null : 'rules.tsv:7 [if] unknown cell "climate1.humid"';
  broadcast('config', { error: configError, at: Date.now() });
}, 45000);
