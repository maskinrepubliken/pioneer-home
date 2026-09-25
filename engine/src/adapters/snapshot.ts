/**
 * Persists the engine snapshot (cell values, SINCE history, running sequences) to disk so a
 * restart does not forget that the hall went quiet four minutes ago.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import type { Engine, EngineSnapshot } from '../core/engine.js';

export function loadSnapshot(path: string, log: Logger): EngineSnapshot | null {
  try {
    const snap = JSON.parse(readFileSync(path, 'utf8')) as EngineSnapshot;
    if (!snap || typeof snap !== 'object' || !snap.store) return null;
    log.info({ path, savedAt: new Date(snap.store.savedAt).toISOString() }, 'snapshot loaded');
    return snap;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn({ err: e, path }, 'snapshot unreadable, starting fresh');
    return null;
  }
}

export function saveSnapshot(path: string, engine: Engine, log: Logger): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(engine.snapshot()));
    renameSync(tmp, path);
  } catch (e) {
    log.error({ err: e, path }, 'snapshot save failed');
  }
}

export function startSnapshotting(path: string, engine: Engine, log: Logger, intervalMs = 30_000): () => void {
  const timer = setInterval(() => saveSnapshot(path, engine, log), intervalMs);
  return () => {
    clearInterval(timer);
    saveSnapshot(path, engine, log);
  };
}
