/**
 * Watches the tables directory and hot-reloads the engine. A broken table keeps the old
 * configuration running and surfaces the errors (log + engine.configError for the UI).
 */
import chokidar from 'chokidar';
import type { Logger } from 'pino';
import { formatConfigError } from '../config/errors.js';
import { loadConfig } from '../config/loader.js';
import type { Engine } from '../core/engine.js';

/** Loads the tables and swaps them into the engine. Returns the error text, or null when the reload succeeded. */
export function reloadTables(dir: string, engine: Engine, log: Logger, onReload: (error: string | null) => void): string | null {
  {
    const res = loadConfig(dir);
    for (const w of res.warnings) log.warn(formatConfigError(w));
    if (!res.ok) {
      const text = res.errors.map(formatConfigError).join('\n');
      log.error(`tables not reloaded:\n${text}`);
      engine.configError = text;
      onReload(text);
      return text;
    }
    try {
      engine.reload(res.config);
      log.info({ rules: res.config.rules.length, derived: res.config.derived.size, devices: res.config.devices.size }, 'tables reloaded');
      onReload(null);
      return null;
    } catch (e) {
      const text = `reload failed: ${(e as Error).message}`;
      log.error(text);
      engine.configError = text;
      onReload(text);
      return text;
    }
  }
}

export function watchTables(dir: string, engine: Engine, log: Logger, onReload: (error: string | null) => void): () => Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  const reload = () => {
    timer = null;
    reloadTables(dir, engine, log, onReload);
  };
  const watcher = chokidar.watch(dir, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 } });
  watcher.on('all', (event, path) => {
    if (!path.endsWith('.tsv') && !path.includes('/scripts/')) return;
    log.debug({ event, path }, 'tables changed');
    if (timer) clearTimeout(timer);
    timer = setTimeout(reload, 500);
  });
  watcher.on('error', (e) => log.error({ err: e }, 'watcher error'));
  return () => watcher.close();
}
