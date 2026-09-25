import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/loader.js';
import type { Config } from '../../src/config/model.js';
import { HistoryTracker, type HistoryRow } from '../../src/core/history.js';
import { Simulator, parseWhen } from '../../src/sim/simulator.js';

const TZ = 'Europe/Stockholm';
const at = (s: string) => parseWhen(s, TZ);

function makeConfig(history: string): Config {
  const dir = mkdtempSync(join(tmpdir(), 'pioneer-history-'));
  writeFileSync(join(dir, 'settings.tsv'), 'key\tvalue\ntimezone\tEurope/Stockholm\nlatitude\t59.3\nlongitude\t18.1\n');
  writeFileSync(join(dir, 'devices.tsv'), 'id\troom\tkind\tsource\nbedroom.climate\tbedroom\tclimate\tmqtt:home/gpio/climate1\nfan\tbedroom\tpwm\tmqtt:home/gpio/fan\n');
  writeFileSync(join(dir, 'vars.tsv'), 'id\ttype\tinitial\nauto\tboolean\tTRUE\n');
  writeFileSync(join(dir, 'history.tsv'), history);
  const res = loadConfig(dir);
  if (!res.ok) throw new Error(res.errors.map((e) => `${e.file}:${e.line}: ${e.message}`).join('\n'));
  return res.config;
}

function setup(history: string, start = '2026-09-23T12:00') {
  const config = makeConfig(history);
  const sim = new Simulator(config, { at: at(start) });
  const rows: HistoryRow[] = [];
  new HistoryTracker(sim.engine, { write: (r) => rows.push(r) });
  return { sim, rows };
}

describe('HistoryTracker', () => {
  it('writes one record with all fields when a numeric field moves enough, applying scale', () => {
    const { sim, rows } = setup(
      'record\tcollection\tfield\tformula\tscale\tmin_interval\tmin_delta\n' +
        'climate_1\tclimate\tsensor\t"climate1"\t\t\t\n' +
        'climate_1\tclimate\tlocation\t"bedroom"\t\t\t\n' +
        'climate_1\tclimate\ttemperature\tbedroom.climate.temperature\t\t\t0.2\n' +
        'climate_1\tclimate\thumidity\tbedroom.climate.humidity\t0.01\t\t1\n',
    );
    sim.mqtt('home/gpio/climate1', '{"temperature":21.4,"humidity":48}');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.collection).toBe('climate');
    expect(rows[0]!.fields).toMatchObject({ sensor: 'climate1', location: 'bedroom', temperature: 21.4, humidity: 0.48 });
    expect(typeof rows[0]!.fields['when']).toBe('string');
    // small wiggle: below both deltas, nothing written
    sim.mqtt('home/gpio/climate1', '{"temperature":21.5,"humidity":48.5}');
    expect(rows).toHaveLength(1);
    // humidity moves by 1 point: written, with the current temperature too
    sim.mqtt('home/gpio/climate1', '{"temperature":21.5,"humidity":49.5}');
    expect(rows).toHaveLength(2);
    expect(rows[1]!.fields).toMatchObject({ temperature: 21.5, humidity: 0.495 });
  });

  it('respects min_interval by deferring, and skips records whose inputs are all NULL', () => {
    const { sim, rows } = setup(
      'record\tcollection\tfield\tformula\tscale\tmin_interval\tmin_delta\n' +
        'climate_1\tclimate\tsensor\t"climate1"\t\t5m\t\n' +
        'climate_1\tclimate\ttemperature\tbedroom.climate.temperature\t\t\t0.2\n',
    );
    // A change to an unrelated cell does not write, and the constant-only fields never write on their own.
    sim.set('auto', 'FALSE');
    expect(rows).toHaveLength(0);
    sim.mqtt('home/gpio/climate1', '{"temperature":20}');
    expect(rows).toHaveLength(1);
    sim.mqtt('home/gpio/climate1', '{"temperature":22}');
    expect(rows).toHaveLength(1); // inside the 5 minute interval
  });

  it('writes power-style records on every change with a zero interval', () => {
    const { sim, rows } = setup(
      'record\tcollection\tfield\tformula\tscale\tmin_interval\tmin_delta\n' +
        'power_fan\tpower\tname\t"fan"\t\t0s\t\n' +
        'power_fan\tpower\tpowerlevel\tfan.level\t\t\t1\n' +
        'power_auto\tpower\tname\t"automatic_control"\t\t0s\t\n' +
        'power_auto\tpower\tpowerlevel\tIF(auto, 100, 0)\t\t\t1\n',
    );
    sim.mqtt('home/gpio/fan', '{"level":40}');
    sim.mqtt('home/gpio/fan', '{"level":40}');
    sim.mqtt('home/gpio/fan', '{"level":60}');
    sim.set('auto', 'FALSE');
    expect(rows.map((r) => [r.record, r.fields['powerlevel']])).toEqual([
      ['power_fan', 40],
      ['power_fan', 60],
      ['power_auto', 0],
    ]);
  });

  it('loads the real history table and evaluates every record without errors', () => {
    const res = loadConfig(resolve(__dirname, '../../../example/tables'));
    if (!res.ok) throw new Error('tables invalid');
    const sim = new Simulator(res.config, { at: at('2026-09-23T12:00') });
    const rows: HistoryRow[] = [];
    new HistoryTracker(sim.engine, { write: (r) => rows.push(r) });
    sim.mqtt('zigbee2mqtt/FLOOR1', '{"local_temperature":19.2,"occupied_heating_setpoint":18,"pi_heating_demand":0,"system_mode":"heat"}');
    const heating = rows.find((r) => r.record === 'heating_floor1');
    expect(heating?.fields).toMatchObject({ sensor: 'FLOOR1', powercycle: 10, pi: 0, heating: true, current: 19.2, target: 18 });
    expect(rows.find((r) => r.record === 'climate_floor1')?.fields).toMatchObject({ sensor: 'FLOOR1', location: 'study', temperature: 19.2 });
  });
});

describe('HistoryTracker heartbeat', () => {
  it('re-writes a record after max_interval even when nothing changed', () => {
    const config = makeConfig(
      'record\tcollection\tfield\tformula\tscale\tmin_interval\tmax_interval\tmin_delta\n' +
        'climate_1\tclimate\tsensor\t"climate1"\t\t1m\t10m\t\n' +
        'climate_1\tclimate\ttemperature\tbedroom.climate.temperature\t\t\t\t0.2\n',
    );
    const sim = new Simulator(config, { at: at('2026-09-23T12:00') });
    const rows: HistoryRow[] = [];
    // drive the tracker's timers from the simulated clock
    new HistoryTracker(sim.engine, { write: (r) => rows.push(r) }, (ms, cb) => {
      sim.clock.setTimer(sim.now() + ms, cb);
      return { unref() {} } as unknown as NodeJS.Timeout;
    });
    sim.mqtt('home/gpio/climate1', '{"temperature":20}');
    expect(rows).toHaveLength(1);
    sim.advance(9 * 60_000);
    expect(rows).toHaveLength(1);
    sim.advance(2 * 60_000);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.fields['temperature']).toBe(20);
    sim.advance(10 * 60_000);
    expect(rows).toHaveLength(3);
  });
});
