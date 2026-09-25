/**
 * PocketBase history sink: buffers rows and writes them in batches, retrying on failure so a
 * PocketBase restart never loses more than the in-memory buffer (capped). Also answers history
 * queries for the web UI so PocketBase itself never has to be exposed with open rules.
 */
import PocketBase from 'pocketbase';
import type { Logger } from 'pino';
import type { HistoryRow, HistorySink } from '../core/history.js';

export interface PocketBaseOptions {
  url: string;
  email: string;
  password: string;
  /** flush interval in ms */
  flushMs: number;
  /** max rows kept in memory while PocketBase is unreachable */
  maxBuffer: number;
  /** log rows instead of writing them */
  dryRun: boolean;
}

export interface HistoryQuery {
  query(collection: string, sinceIso: string, untilIso: string, limit?: number): Promise<Record<string, unknown>[]>;
}

export class PocketBaseSink implements HistorySink, HistoryQuery {
  private pb: PocketBase;
  private buffer: HistoryRow[] = [];
  private timer: NodeJS.Timeout;
  private flushing = false;
  private authedAt = 0;
  private useBatch = true;

  constructor(
    private opts: PocketBaseOptions,
    private log: Logger,
  ) {
    this.pb = new PocketBase(opts.url);
    this.pb.autoCancellation(false);
    this.timer = setInterval(() => void this.flush(), opts.flushMs);
    this.timer.unref();
  }

  write(row: HistoryRow): void {
    if (this.opts.dryRun) {
      this.log.info({ collection: row.collection, fields: row.fields }, 'history (dry run)');
      return;
    }
    this.buffer.push(row);
    if (this.buffer.length > this.opts.maxBuffer) {
      this.buffer.splice(0, this.buffer.length - this.opts.maxBuffer);
      this.log.warn('history buffer full, dropping oldest rows');
    }
    if (this.buffer.length >= 200) void this.flush();
  }

  private async auth(): Promise<void> {
    if (this.pb.authStore.isValid && Date.now() - this.authedAt < 50 * 60_000) return;
    try {
      await this.pb.collection('_superusers').authWithPassword(this.opts.email, this.opts.password);
    } catch {
      await this.pb.collection('users').authWithPassword(this.opts.email, this.opts.password);
    }
    this.authedAt = Date.now();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const rows = this.buffer.splice(0, 200);
    try {
      await this.auth();
      if (this.useBatch) {
        try {
          const batch = this.pb.createBatch();
          for (const r of rows) batch.collection(r.collection).create(r.fields);
          await batch.send();
          this.log.debug({ rows: rows.length }, 'history written (batch)');
          return;
        } catch (e) {
          if (!/batch requests are not allowed/i.test((e as Error).message)) throw e;
          // PocketBase ships with the batch API disabled; fall back to one request per row.
          this.useBatch = false;
          this.log.info('pocketbase batch api disabled, writing rows one by one');
        }
      }
      const failed: HistoryRow[] = [];
      for (const r of rows) {
        try {
          await this.pb.collection(r.collection).create(r.fields);
        } catch (e) {
          failed.push(r);
          this.log.warn({ err: (e as Error).message, collection: r.collection }, 'history row rejected');
        }
      }
      if (failed.length) this.buffer.unshift(...failed);
      this.log.debug({ rows: rows.length - failed.length }, 'history written');
    } catch (e) {
      // put them back, oldest first, and try again next interval
      this.buffer.unshift(...rows);
      this.log.warn({ err: (e as Error).message, buffered: this.buffer.length }, 'history write failed, will retry');
    } finally {
      this.flushing = false;
    }
  }

  async query(collection: string, sinceIso: string, untilIso: string, limit = 5000): Promise<Record<string, unknown>[]> {
    await this.auth();
    // PocketBase stores dates as "YYYY-MM-DD HH:MM:SS.sssZ" text and compares strings, so the bounds must use that shape.
    const filter = this.pb.filter('when >= {:since} && when <= {:until}', { since: pbDate(sinceIso), until: pbDate(untilIso) });
    const items: Record<string, unknown>[] = [];
    let page = 1;
    for (;;) {
      const res = await this.pb.collection(collection).getList(page, 500, { filter, sort: 'when', skipTotal: true });
      items.push(...(res.items as unknown as Record<string, unknown>[]));
      if (res.items.length < 500 || items.length >= limit) break;
      page++;
    }
    return items;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  get pending(): number {
    return this.buffer.length;
  }
}

/** Sink used when no PocketBase credentials are configured: keeps the last rows for the API and logs. */
export class MemorySink implements HistorySink, HistoryQuery {
  private rows: HistoryRow[] = [];
  constructor(
    private log: Logger,
    private max = 2000,
  ) {}
  write(row: HistoryRow): void {
    this.rows.push(row);
    if (this.rows.length > this.max) this.rows.shift();
    this.log.debug({ collection: row.collection, fields: row.fields }, 'history (memory)');
  }
  async query(collection: string, sinceIso: string, untilIso: string): Promise<Record<string, unknown>[]> {
    const since = Date.parse(sinceIso);
    const until = Date.parse(untilIso);
    return this.rows.filter((r) => r.collection === collection && r.at >= since && r.at <= until).map((r) => r.fields);
  }
}

/** ISO 8601 -> PocketBase date text ("2026-09-23 13:07:00.000Z"). */
export function pbDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toISOString().replace('T', ' ');
}
