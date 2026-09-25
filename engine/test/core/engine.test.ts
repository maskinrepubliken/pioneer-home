import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/loader.js';
import type { Config } from '../../src/config/model.js';
import { Simulator, parseWhen } from '../../src/sim/simulator.js';
import { SimClock } from '../../src/core/clock.js';
import { FakeTransport, topicMatches } from '../../src/core/transport.js';

const TZ = 'Europe/Stockholm';

function makeConfig(files: Record<string, string>): Config {
  const dir = mkdtempSync(join(tmpdir(), 'pioneer-engine-'));
  const base: Record<string, string> = {
    'settings.tsv': 'key\tvalue\ntimezone\tEurope/Stockholm\nlatitude\t59.3\nlongitude\t18.1\n',
    'devices.tsv': 'id\troom\tkind\tsource\nhall.light\thall\tlight\tz2m:Hall\nhall.motion\thall\tmotion\tz2m:Motion\nhall.remote\thall\tremote\tz2m:Remote\nfan\thall\tpwm\tmqtt:home/gpio/fan\n',
    'vars.tsv': 'id\ttype\tinitial\nphase\tstring\tday\n',
  };
  for (const [name, text] of Object.entries({ ...base, ...files })) writeFileSync(join(dir, name), text);
  const res = loadConfig(dir);
  if (!res.ok) throw new Error(res.errors.map((e) => `${e.file}:${e.line}: ${e.message}`).join('\n'));
  return res.config;
}

const at = (s: string) => parseWhen(s, TZ);
const sets = (sim: Simulator, from = 0) => sim.published(from).filter((m) => m.topic.endsWith('/set'));

describe('SimClock', () => {
  it('fires timers and intervals in chronological order while advancing', () => {
    const c = new SimClock(0);
    const log: string[] = [];
    c.setTimer(500, () => log.push('t500'));
    c.setInterval(200, () => log.push(`i${c.now()}`));
    c.setTimer(100, () => log.push('t100'));
    c.advance(700);
    expect(log).toEqual(['t100', 'i200', 'i400', 't500', 'i600']);
    expect(c.now()).toBe(700);
  });
});

describe('topic filters', () => {
  it('matches + and #', () => {
    expect(topicMatches('zigbee2mqtt/+', 'zigbee2mqtt/Hall')).toBe(true);
    expect(topicMatches('zigbee2mqtt/+', 'zigbee2mqtt/Hall/availability')).toBe(false);
    expect(topicMatches('home/#', 'home/gpio/fan')).toBe(true);
    expect(topicMatches('home/gpio/fan', 'home/gpio/fan')).toBe(true);
  });
});

describe('engine passes', () => {
  it('recomputes derived cells and fires edge rules once, re-arming after the condition drops', () => {
    const config = makeConfig({
      'derived.tsv': 'id\tformula\ndark\tsun.elevation < -3\n',
      'rules.tsv': 'id\twhen\tif\tthen\nlight_on\t\tAND(hall.motion, dark)\tset hall.light 80%\n',
    });
    const sim = new Simulator(config, { at: at('2026-09-23T21:00') });
    sim.set('sun.elevation', '-5');
    expect(sim.get('dark')).toBe(true);
    sim.set('hall.motion', 'TRUE');
    expect(sets(sim)).toHaveLength(1);
    expect(JSON.parse(sets(sim)[0]!.payload)).toEqual({ state: 'ON', brightness: 203 });
    // echo turned the light on in the store
    expect(sim.get('hall.light')).toBe(true);
    expect(sim.get('hall.light.brightness')).toBe(80);
    // condition stays true: no second firing
    sim.set('sun.elevation', '-10');
    expect(sets(sim)).toHaveLength(1);
    // drop and rise again
    sim.set('hall.motion', 'FALSE');
    sim.set('hall.motion', 'TRUE');
    expect(sets(sim)).toHaveLength(2);
  });

  it('treats remote actions as transient: identical presses each fire', () => {
    const config = makeConfig({
      'rules.tsv': 'id\twhen\tif\tthen\ntoggle\ton hall.remote\thall.remote = "on_press_release"\tset hall.light on\n',
    });
    const sim = new Simulator(config, { at: at('2026-09-23T21:00') });
    sim.mqtt('zigbee2mqtt/Remote', '{"action":"on_press_release"}');
    sim.mqtt('zigbee2mqtt/Remote', '{"action":"on_press_release"}');
    expect(sets(sim)).toHaveLength(2);
    expect(sim.get('hall.remote')).toBeNull();
  });

  it('uses SINCE on a tick to turn a light off after a quiet period', () => {
    const config = makeConfig({
      'derived.tsv': 'id\tformula\nidle\tAND(NOT(hall.motion), SINCE(hall.motion, TRUE) > 5m)\n',
      'rules.tsv': 'id\twhen\tif\tthen\noff\t\tidle\tset hall.light off\n',
    });
    const sim = new Simulator(config, { at: at('2026-09-23T21:00') });
    sim.set('hall.motion', 'TRUE');
    sim.advance(60_000);
    sim.set('hall.motion', 'FALSE');
    sim.advance(4 * 60_000);
    expect(sets(sim)).toHaveLength(0);
    sim.advance(61_000);
    expect(sets(sim)).toHaveLength(1);
    expect(JSON.parse(sets(sim)[0]!.payload)).toEqual({ state: 'OFF' });
    // motion again resets the timer
    sim.set('hall.motion', 'TRUE');
    sim.set('hall.motion', 'FALSE');
    sim.advance(4 * 60_000);
    expect(sets(sim)).toHaveLength(1);
    sim.advance(2 * 60_000);
    expect(sets(sim)).toHaveLength(2);
  });

  it('fires on-event rules and applies scenes', () => {
    const config = makeConfig({
      'scenes.tsv': 'device\tnight\nhall.light\t10% 2000K\n',
      'rules.tsv': 'id\twhen\tif\tthen\nnight\ton event\tevent = "sleep"\tscene night; set phase night\n',
    });
    const sim = new Simulator(config, { at: at('2026-09-23T21:00') });
    sim.event('wake');
    expect(sets(sim)).toHaveLength(0);
    sim.event('sleep');
    expect(sim.get('phase')).toBe('night');
    expect(JSON.parse(sets(sim)[0]!.payload)).toEqual({ state: 'ON', brightness: 25, color_temp: 500 });
  });

  it('runs and cancels sequences', () => {
    const config = makeConfig({
      'sequences.tsv': 'sequence\tstep\tafter\taction\tcancel_if\nwake\t1\t0s\tset hall.light 1%\t\nwake\t2\t5s\tfade hall.light 70% 4000K over 20m\tNOT(hall.light)\nwake\t3\t20m\tset hall.light 100%\tNOT(hall.light)\nwake\t4\t0s\tevent wake\t\n',
      'rules.tsv': 'id\twhen\tif\tthen\nstart\ton event\tevent = "go"\tstart wake\n',
    });
    const sim = new Simulator(config, { at: at('2026-09-21T06:29:59') });
    sim.event('go');
    expect(sim.engine.isRunning('wake')).toBe(true);
    expect(sets(sim)).toHaveLength(1);
    sim.advance(5_000);
    expect(sets(sim)).toHaveLength(2);
    expect(JSON.parse(sets(sim)[1]!.payload)).toEqual({ state: 'ON', brightness: 178, color_temp: 250, transition: 1200 });
    sim.advance(20 * 60_000);
    expect(sets(sim)).toHaveLength(3);
    expect(sim.engine.isRunning('wake')).toBe(false);
    expect(sim.get('event')).toBeNull();

    // Second run: switching the light off cancels the sequence.
    sim.event('go');
    sim.advance(5_000);
    sim.set('hall.light.state', 'FALSE');
    expect(sim.engine.isRunning('wake')).toBe(false);
    expect(sim.traces.at(-1)?.sequences.some((s) => s.event === 'cancelled')).toBe(true);
  });

  it('fires at-rules on the right days, including sun-relative times', () => {
    const config = makeConfig({
      'rules.tsv': 'id\twhen\tif\tthen\nwd\tat 08:00 mon-fri\t\tset fan 0\nwe\tat 08:00 sat-sun\t\tset fan 50\nnoon\tat 12:00\t\tset hall.light on\n',
    });
    // 2026-09-25 is a Friday
    const sim = new Simulator(config, { at: at('2026-09-25T07:59:00') });
    sim.advance(2 * 60_000);
    expect(sets(sim).map((m) => m.payload)).toEqual(['{"level":0}']);
    sim.advanceTo(at('2026-09-25T12:00:30'));
    expect(sets(sim)).toHaveLength(2);
    sim.advanceTo(at('2026-09-26T08:00:30')); // Saturday
    expect(sets(sim).at(-1)?.payload).toBe('{"level":50}');

    // sunset in the fixed sun is 18:00 local; "at sunset-30m" fires at 17:30
    const config2 = makeConfig({ 'rules.tsv': 'id\twhen\tif\tthen\ndusk\tat sunset-30m daily\t\tset hall.light 40%\n' });
    const sim2 = new Simulator(config2, { at: at('2026-09-25T17:00') });
    sim2.advanceTo(at('2026-09-25T17:29'));
    expect(sets(sim2)).toHaveLength(0);
    sim2.advanceTo(at('2026-09-25T17:31'));
    expect(sets(sim2)).toHaveLength(1);
  });

  it('handles the DST change without skipping or doubling a schedule row', () => {
    const config = makeConfig({ 'rules.tsv': 'id\twhen\tif\tthen\nnight\tat 03:30 daily\t\tset fan 10\n' });
    // Spring forward 2026-03-29: 02:00 -> 03:00 local. 03:30 exists once.
    const sim = new Simulator(config, { at: at('2026-03-28T20:00') });
    sim.advanceTo(at('2026-03-30T20:00'));
    expect(sets(sim)).toHaveLength(2);
    // Fall back 2026-10-25: 03:00 -> 02:00 local. 03:30 happens on the first pass only.
    const sim2 = new Simulator(config, { at: at('2026-10-24T20:00') });
    sim2.advanceTo(at('2026-10-26T20:00'));
    expect(sets(sim2)).toHaveLength(2);
  });

  it('applies the rate guard and the pass chain guard', () => {
    const config = makeConfig({
      'derived.tsv': 'id\tformula\nping\tphase = "a"\npong\tphase = "b"\n',
      'rules.tsv': 'id\twhen\tif\tthen\nto_b\t\tping\tset phase b\nto_a\t\tpong\tset phase a\n',
    });
    const sim = new Simulator(config, { at: at('2026-09-23T21:00') });
    sim.set('phase', 'a');
    const errors = sim.traces.flatMap((t) => t.errors);
    expect(errors.some((e) => /chain of 20 passes exceeded/.test(e))).toBe(true);

    const config2 = makeConfig({ 'rules.tsv': 'id\twhen\tif\tthen\nspam\ton hall.motion\thall.motion\tset hall.light on\n' });
    const sim2 = new Simulator(config2, { at: at('2026-09-23T21:00') });
    for (let i = 0; i < 15; i++) {
      sim2.set('hall.motion', 'TRUE');
      sim2.set('hall.motion', 'FALSE');
    }
    expect(sets(sim2)).toHaveLength(10);
    expect(sim2.traces.some((t) => t.actions.some((a) => /rate guard/.test(a.error ?? '')))).toBe(true);
  });

  it('reloads configuration without firing and keeps values, and round-trips a snapshot', () => {
    const config = makeConfig({
      'derived.tsv': 'id\tformula\nidle\tAND(NOT(hall.motion), SINCE(hall.motion, TRUE) > 5m)\n',
      'rules.tsv': 'id\twhen\tif\tthen\noff\t\tidle\tset hall.light off\n',
    });
    const sim = new Simulator(config, { at: at('2026-09-23T21:00') });
    sim.set('hall.motion', 'TRUE');
    sim.set('hall.motion', 'FALSE');
    sim.advance(6 * 60_000);
    expect(sets(sim)).toHaveLength(1);
    // A reload while idle is already true must not fire the edge again.
    const config2 = makeConfig({
      'derived.tsv': 'id\tformula\nidle\tAND(NOT(hall.motion), SINCE(hall.motion, TRUE) > 5m)\nextra\t1 + 1\n',
      'rules.tsv': 'id\twhen\tif\tthen\noff\t\tidle\tset hall.light off\n',
    });
    sim.engine.reload(config2);
    sim.advance(60_000);
    expect(sets(sim)).toHaveLength(1);
    expect(sim.get('extra')).toBe(2);
    expect(sim.get('idle')).toBe(true);

    // Snapshot into a fresh engine: SINCE history survives.
    const snap = sim.engine.snapshot();
    const sim2 = new Simulator(config2, { at: sim.now() });
    sim2.engine.restore(snap);
    expect(sim2.get('hall.motion')).toBe(false);
    expect(sim2.get('idle')).toBe(true);
    sim2.advance(1000);
    expect(sets(sim2)).toHaveLength(0);
  });

  it('maps zigbee2mqtt payloads through device kinds, including availability', () => {
    const config = makeConfig({});
    const sim = new Simulator(config, { at: at('2026-09-23T21:00') });
    sim.mqtt('zigbee2mqtt/Hall', '{"state":"ON","brightness":127,"color_temp":370,"linkquality":80}');
    expect(sim.get('hall.light')).toBe(true);
    expect(sim.get('hall.light.brightness')).toBe(50);
    expect(sim.get('hall.light.color_temp')).toBe(2703);
    sim.mqtt('zigbee2mqtt/Hall/availability', '{"state":"offline"}');
    expect(sim.get('hall.light.available')).toBe(false);
    sim.mqtt('home/gpio/fan', '{"level":40}');
    expect(sim.get('fan')).toBe(40);
  });

  it('interpolates {formulas} in actions and supports relative brightness', () => {
    const config = makeConfig({
      'vars.tsv': 'id\ttype\tinitial\nwanted\tnumber\t35\n',
      'rules.tsv': 'id\twhen\tif\tthen\nfollow\ton wanted\t\tset fan {wanted}\nup\ton hall.remote\thall.remote = "up"\tset hall.light brightness+=20%\n',
    });
    const sim = new Simulator(config, { at: at('2026-09-23T21:00') });
    sim.set('wanted', '72');
    expect(sets(sim).at(-1)?.payload).toBe('{"level":72}');
    sim.set('hall.light.brightness', '50');
    sim.mqtt('zigbee2mqtt/Remote', '{"action":"up"}');
    expect(JSON.parse(sets(sim).at(-1)!.payload)).toEqual({ brightness_step_onoff: 51 });
  });

  it('fake transport delivers injected messages only to matching subscribers', () => {
    const t = new FakeTransport();
    const got: string[] = [];
    t.subscribe('a/+', (topic) => got.push(topic));
    t.inject('a/b', 'x');
    t.inject('a/b/c', 'x');
    expect(got).toEqual(['a/b']);
  });
});
