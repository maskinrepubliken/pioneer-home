/**
 * Runs the engine for real: real clock, MQTT broker, HTTP API, table watcher, snapshots.
 *
 * Environment (see deploy/engine.env.example):
 *   TABLES_DIR   default ../tables (relative to the repo root that contains engine/)
 *   STATE_DIR    default ../state
 *   WEB_DIR      default ../web/dist
 *   MQTT_URL     default from settings.tsv mqtt_url, else mqtt://localhost:1883
 *   MQTT_USERNAME / MQTT_PASSWORD  optional
 *   DRY_RUN      true = log actions, publish nothing (default false)
 *   PORT         default 8000, HOST default 0.0.0.0
 *   LOG_LEVEL    pino level, default info
 *   PB_URL / PB_EMAIL / PB_PASSWORD   PocketBase history writer (omitted = in-memory history only)
 *   OWM_API_KEY  OpenWeatherMap key for the weather.* cells (omitted = no weather)
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { HttpServer } from './adapters/http.js';
import { MqttTransport } from './adapters/mqtt.js';
import { loadSnapshot, startSnapshotting } from './adapters/snapshot.js';
import { reloadTables, watchTables } from './adapters/watcher.js';
import { MemorySink, PocketBaseSink } from './adapters/pocketbase.js';
import { startWeather } from './adapters/weather.js';
import { DryRunReport } from './adapters/dryrun.js';
import { HistoryTracker } from './core/history.js';
import { formatConfigError } from './config/errors.js';
import { loadConfig, settingDurationMs, settingString } from './config/loader.js';
import { RealClock } from './core/clock.js';
import { Engine } from './core/engine.js';
import { createSunProvider } from './core/sun.js';
import { formatTrace } from './sim/trace.js';

const here = dirname(fileURLToPath(import.meta.url));
// dist/main.js -> engine/ -> repo root ; src/main.ts -> engine/ -> repo root
const repoRoot = resolve(here, '..', '..');

const env = (k: string, d: string) => process.env[k] ?? d;
const defaultTables = existsSync(resolve(repoRoot, 'tables')) ? resolve(repoRoot, 'tables') : resolve(repoRoot, 'example', 'tables');
const tablesDir = resolve(env('TABLES_DIR', defaultTables));
const stateDir = resolve(env('STATE_DIR', resolve(repoRoot, 'state')));
const webDir = resolve(env('WEB_DIR', resolve(repoRoot, 'web', 'dist')));
const dryRun = /^(1|true|yes)$/i.test(env('DRY_RUN', 'false'));
const port = Number(env('PORT', '8000'));
const host = env('HOST', '0.0.0.0');

// LOG_FORMAT=text (default) prints readable lines for journald; LOG_FORMAT=json emits raw pino JSON.
const textStream = {
  write(line: string) {
    try {
      const o = JSON.parse(line) as { level: number; time: string; msg?: string; [k: string]: unknown };
      const { level, time, msg, ...rest } = o;
      const label = pino.levels.labels[level]?.toUpperCase().padEnd(5) ?? String(level);
      const extra = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
      const body = (msg ?? '').replace(/^\n/, '');
      process.stdout.write(`${time.slice(11, 19)} ${label} ${body}${extra}\n`);
    } catch {
      process.stdout.write(line);
    }
  },
};
const log = pino(
  { level: env('LOG_LEVEL', 'info'), base: null, timestamp: pino.stdTimeFunctions.isoTime },
  env('LOG_FORMAT', 'text') === 'json' ? pino.destination(1) : textStream,
);

async function main(): Promise<void> {
  const res = loadConfig(tablesDir);
  for (const w of res.warnings) log.warn(formatConfigError(w));
  if (!res.ok) {
    for (const e of res.errors) log.error(formatConfigError(e));
    log.fatal(`${res.errors.length} error(s) in ${tablesDir}, refusing to start`);
    process.exit(1);
  }
  const config = res.config;

  // A Pi without an RTC may boot with a bogus clock. Schedules would then fire nonsense, so wait for NTP.
  await waitForPlausibleClock();

  const mqttUrl = env('MQTT_URL', settingString(config, 'mqtt_url', 'mqtt://localhost:1883'));
  const transportOpts: { username?: string; password?: string } = {};
  if (process.env['MQTT_USERNAME']) transportOpts.username = process.env['MQTT_USERNAME'];
  if (process.env['MQTT_PASSWORD']) transportOpts.password = process.env['MQTT_PASSWORD'];
  const transport = new MqttTransport(mqttUrl, log, transportOpts);
  const engine = new Engine(config, {
    clock: new RealClock(),
    transport,
    sun: createSunProvider(config.latitude, config.longitude),
    dryRun,
  });
  log.info({ tablesDir, stateDir, mqttUrl, dryRun, devices: config.devices.size, rules: config.rules.length }, 'engine started');

  const snapshotPath = resolve(stateDir, 'snapshot.json');
  const snap = loadSnapshot(snapshotPath, log);
  if (snap) engine.restore(snap);

  engine.onTrace((t) => {
    const text = formatTrace(t, config.timezone);
    if (t.errors.length || t.actions.some((a) => a.error)) log.warn(`\n${text}`);
    else if (t.rules.some((r) => r.fired) || t.actions.length || t.sequences.length) log.info(`\n${text}`);
    else log.debug(`\n${text}`);
  });

  // History: PocketBase when configured, otherwise an in-memory sink so the UI still has recent rows.
  const pbUrl = process.env['PB_URL'];
  const pbEmail = process.env['PB_EMAIL'];
  const pbPassword = process.env['PB_PASSWORD'];
  const sink =
    pbUrl && pbEmail && pbPassword
      ? new PocketBaseSink({ url: pbUrl, email: pbEmail, password: pbPassword, flushMs: settingDurationMs(config, 'history_flush', 10_000), maxBuffer: 10_000, dryRun }, log)
      : new MemorySink(log);
  log.info({ pocketbase: pbUrl ?? '(memory only)', historyDryRun: dryRun }, 'history sink');
  const history = new HistoryTracker(engine, sink);
  history.prime();
  const dryRunReport = dryRun ? new DryRunReport(engine) : undefined;

  const owmKey = process.env['OWM_API_KEY'];
  const stopWeather = owmKey
    ? startWeather(engine, { apiKey: owmKey, latitude: config.latitude, longitude: config.longitude, intervalMs: settingDurationMs(config, 'weather_interval', 20 * 60_000) }, log)
    : () => undefined;
  if (!owmKey) log.info('OWM_API_KEY not set, weather.* cells stay NULL');

  const httpOpts: import('./adapters/http.js').HttpOptions = { port, host, webDir: existsSync(webDir) ? webDir : null, tablesDir, dryRun, traceBuffer: 300, history: sink };
  if (dryRunReport) httpOpts.dryRunReport = dryRunReport;
  httpOpts.onTableSaved = () => reloadTables(tablesDir, engine, log, (error) => http.configChanged(error));
  const http: HttpServer = new HttpServer(engine, httpOpts, log);
  await http.start();

  const stopWatching = watchTables(tablesDir, engine, log, (error) => http.configChanged(error));
  const stopSnapshots = startSnapshotting(snapshotPath, engine, log);

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    stopSnapshots();
    stopWeather();
    engine.dispose();
    history.dispose();
    await stopWatching();
    await http.stop();
    if (sink instanceof PocketBaseSink) await sink.close();
    await transport.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

async function waitForPlausibleClock(): Promise<void> {
  // Anything before this file was written is a clock that has not synced yet.
  const buildFloor = Date.parse('2026-09-01T00:00:00Z');
  let warned = false;
  while (Date.now() < buildFloor) {
    if (!warned) {
      log.warn('system clock looks unsynced, waiting for NTP before starting');
      warned = true;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

main().catch((e: unknown) => {
  log.fatal({ err: e }, 'engine crashed');
  process.exit(1);
});
