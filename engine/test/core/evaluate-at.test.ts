import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Simulator } from '../../src/sim/simulator.js';

// The example's heating modes: Hemma 18 °C in the living room, Sova and Borta cold (12 °C); Borta Wed-Thu 09-15, Sova 19-06.
const example = resolve(__dirname, '../../../example/tables');

describe('Engine.evaluateAt', () => {
  it('evaluates a cell at another moment, with held values replaced', () => {
    const sim = Simulator.fromDir(example, { at: Date.parse('2026-11-02T11:00:00Z') }); // Monday 12:00
    const at = (iso: string, overrides = {}) => sim.engine.evaluateAt('living_room_now', Date.parse(iso), overrides);
    expect(at('2026-11-02T11:00:00Z')).toBe(18); // Monday noon: Hemma
    expect(at('2026-11-04T09:00:00Z')).toBe(12); // Wednesday 10:00: Borta
    expect(at('2026-11-02T21:00:00Z')).toBe(12); // Monday 22:00: Sova
    // with Hemma chosen by hand the schedule no longer counts; overridden back to auto it does again
    sim.engine.applyInputs([{ cell: 'heat_mode', value: 'home' }], 'test');
    expect(at('2026-11-04T09:00:00Z')).toBe(18);
    expect(at('2026-11-04T09:00:00Z', { heat_mode: 'auto' })).toBe(12);
    // the store itself is untouched
    expect(sim.engine.store.get('heat_mode')).toBe('home');
  });
});
