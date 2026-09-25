/**
 * HTTP API + Server-Sent Events, and static hosting for the web UI.
 *
 *   GET  /api/health          { ok, dryRun, configError, uptime }
 *   GET  /api/state           every cell: { id, value, type, kind, room, device, changedAt }
 *   GET  /api/events          SSE stream: `state` (full snapshot on connect), `changes`, `trace`, `config`
 *   GET  /api/tables          the raw TSV text of every table plus rule metadata
 *   GET  /api/trace           last N traces
 *   POST /api/action          { action: "set living_room.lamp on" }
 *   POST /api/event           { event: "sleep" }
 *   GET  /                    web/dist (if present)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Logger } from 'pino';
import type { Engine, Trace } from '../core/engine.js';
import type { CellChange } from '../core/store.js';
import { encodeValue } from '../formula/values.js';
import type { HistoryQuery } from './pocketbase.js';
import type { DryRunReport } from './dryrun.js';
import { isEditableTable, saveTable, validateTable } from './tables-edit.js';
import { formatConfigError } from '../config/errors.js';

export interface HttpOptions {
  port: number;
  host: string;
  webDir: string | null;
  tablesDir: string;
  dryRun: boolean;
  traceBuffer: number;
  history?: HistoryQuery;
  dryRunReport?: DryRunReport;
  /** called after a table was saved through the API; should reload the engine and return the error text or null */
  onTableSaved?: (file: string) => string | null;
}

export class HttpServer {
  private app: FastifyInstance;
  private clients = new Set<FastifyReply>();
  private traces: Trace[] = [];
  private startedAt = Date.now();

  constructor(
    private engine: Engine,
    private opts: HttpOptions,
    private log: Logger,
  ) {
    this.app = Fastify({ logger: false });
    engine.onTrace((t) => this.onTrace(t));
    engine.onChanges((c) => this.broadcast('changes', c.map(encodeChange)));
    this.routes();
  }

  private onTrace(t: Trace): void {
    this.traces.push(t);
    if (this.traces.length > this.opts.traceBuffer) this.traces.splice(0, this.traces.length - this.opts.traceBuffer);
    this.broadcast('trace', encodeTrace(t));
  }

  /** Called by the watcher after a reload attempt so the UI can show a banner. */
  configChanged(error: string | null): void {
    this.broadcast('config', { error, at: Date.now() });
    this.broadcast('state', this.stateSnapshot());
  }

  private stateSnapshot() {
    const engine = this.engine;
    return engine.store.entries().map(([id, st]) => {
      const def = engine.config.cells.get(id);
      const dev = def?.device ? engine.config.devices.get(def.device) : undefined;
      return {
        id,
        value: encodeValue(st.value),
        type: def?.type ?? 'any',
        kind: def?.kind ?? 'input',
        settable: def?.settable ?? false,
        device: def?.device ?? null,
        prop: def?.prop ?? null,
        room: dev?.room ?? def?.room ?? null,
        name: dev?.name ?? null,
        changedAt: st.changedAt,
        seenAt: st.seenAt,
      };
    });
  }

  private routes(): void {
    const { app, engine } = this;

    app.get('/api/health', async () => ({
      ok: true,
      dryRun: this.opts.dryRun,
      configError: engine.configError,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      now: engine.now(),
      timezone: engine.config.timezone,
      sequences: engine.runningSequences(),
    }));

    app.get('/api/state', async () => ({ at: engine.now(), configError: engine.configError, cells: this.stateSnapshot() }));

    app.get('/api/trace', async () => this.traces.map(encodeTrace));

    app.get('/api/tables', async () => {
      const files: Record<string, string> = {};
      for (const f of readdirSync(this.opts.tablesDir)) {
        if (f.endsWith('.tsv')) files[f] = readFileSync(join(this.opts.tablesDir, f), 'utf8');
      }
      return {
        files,
        rules: engine.config.rules.map((r) => ({ id: r.id, enabled: r.enabled, condition: r.conditionSource, file: r.file, line: r.line })),
        rooms: [...engine.config.rooms.values()].map((r) => ({ id: r.id, name: r.name })),
        devices: [...engine.config.devices.values()].map((d) => ({ id: d.id, room: d.room, kind: d.kind.name, name: d.name })),
        scenes: [...engine.config.scenes.keys()],
        sequences: [...engine.config.sequences.keys()],
      };
    });

    app.get<{ Params: { collection: string }; Querystring: { since?: string; until?: string } }>('/api/history/:collection', async (req, reply) => {
      if (!this.opts.history) return reply.code(404).send({ error: 'history not configured' });
      if (!/^[a-z_]+$/.test(req.params.collection)) return reply.code(400).send({ error: 'bad collection' });
      const until = req.query.until ?? new Date().toISOString();
      const since = req.query.since ?? new Date(Date.parse(until) - 24 * 3_600_000).toISOString();
      try {
        const items = await this.opts.history.query(req.params.collection, since, until);
        return { collection: req.params.collection, since, until, items };
      } catch (e) {
        this.log.warn({ err: (e as Error).message }, 'history query failed');
        return reply.code(502).send({ error: `history query failed: ${(e as Error).message}` });
      }
    });

    app.put<{ Params: { file: string }; Body: { text?: string; validateOnly?: boolean; message?: string } }>('/api/tables/:file', async (req, reply) => {
      const file = req.params.file;
      if (!isEditableTable(file)) return reply.code(404).send({ error: `unknown table ${file}` });
      const text = req.body?.text;
      if (typeof text !== 'string') return reply.code(400).send({ error: 'body must be { "text": "<tsv>" }' });
      if (req.body?.validateOnly) {
        const errors = validateTable(this.opts.tablesDir, file, text);
        return { ok: errors.length === 0, errors, messages: errors.map(formatConfigError) };
      }
      const saveOpts: { message?: string } = {};
      if (req.body?.message) saveOpts.message = req.body.message;
      const res = saveTable(this.opts.tablesDir, file, text, saveOpts);
      if (!res.ok) return reply.code(422).send({ ok: false, errors: res.errors, messages: res.errors.map(formatConfigError) });
      const reloadError = this.opts.onTableSaved ? this.opts.onTableSaved(file) : null;
      this.log.info({ file }, 'table saved from ui');
      void res.git.then((problem) => {
        if (problem) this.log.warn({ file, problem }, 'table not committed to git');
        else this.log.info({ file }, 'table committed to git');
      });
      return { ok: reloadError === null, text: res.text, reloadError };
    });

    app.get<{ Querystring: { format?: string } }>('/api/dryrun', async (req, reply) => {
      const r = this.opts.dryRunReport;
      if (!r) return reply.code(404).send({ error: 'engine is not in dry run' });
      if (req.query.format === 'text') return reply.type('text/plain').send(r.format(engine.config.timezone));
      return { summary: r.summary(), entries: r.entries.map((e) => ({ ...e, expected: mapValues(e.expected), observed: e.observed ? mapValues(e.observed) : null })) };
    });

    app.post<{ Body: { action?: string } }>('/api/action', async (req, reply) => {
      const action = req.body?.action;
      if (!action || typeof action !== 'string') return reply.code(400).send({ error: 'body must be { "action": "set device ..." }' });
      const before = this.traces.length;
      engine.runAction(action, `api ${action}`);
      const produced = this.traces.slice(before).map(encodeTrace);
      const errors = produced.flatMap((t) => t.errors);
      return { ok: errors.length === 0, traces: produced };
    });

    app.post<{ Body: { event?: string } }>('/api/event', async (req, reply) => {
      const event = req.body?.event;
      if (!event || typeof event !== 'string') return reply.code(400).send({ error: 'body must be { "event": "sleep" }' });
      const before = this.traces.length;
      engine.dispatchEvent(event, `api event ${event}`);
      return { ok: true, traces: this.traces.slice(before).map(encodeTrace) };
    });

    app.get('/api/events', (req, reply) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      reply.raw.write(`event: state\ndata: ${JSON.stringify({ at: engine.now(), configError: engine.configError, cells: this.stateSnapshot() })}\n\n`);
      this.clients.add(reply);
      const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
      req.raw.on('close', () => {
        clearInterval(ping);
        this.clients.delete(reply);
      });
    });

    if (this.opts.webDir && existsSync(join(this.opts.webDir, 'index.html'))) {
      app.register(fastifyStatic, { root: this.opts.webDir, prefix: '/' });
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
        return reply.sendFile('index.html');
      });
    } else {
      app.get('/', async () => ({ name: 'pioneer-home engine', api: ['/api/health', '/api/state', '/api/events', '/api/tables', '/api/trace', '/api/history/:collection', '/api/dryrun', 'PUT /api/tables/:file', 'POST /api/action', 'POST /api/event'] }));
    }
  }

  private broadcast(event: string, data: unknown): void {
    if (!this.clients.size) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) {
      try {
        c.raw.write(frame);
      } catch (e) {
        this.log.warn({ err: e }, 'sse write failed');
        this.clients.delete(c);
      }
    }
  }

  async start(): Promise<void> {
    await this.app.listen({ port: this.opts.port, host: this.opts.host });
    this.log.info({ port: this.opts.port, host: this.opts.host }, 'http listening');
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.raw.end();
    await this.app.close();
  }
}

function mapValues(o: Record<string, import('../formula/values.js').Value>) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, encodeValue(v)]));
}

function encodeChange(c: CellChange) {
  return { cell: c.cell, from: encodeValue(c.from), to: encodeValue(c.to) };
}

export function encodeTrace(t: Trace) {
  return {
    cause: t.cause,
    at: t.at,
    changed: t.changed.map(encodeChange),
    derived: t.derived.map(encodeChange),
    rules: t.rules.map((r) => ({ id: r.id, fired: r.fired, cond: encodeValue(r.cond), reason: r.reason })),
    actions: t.actions,
    sequences: t.sequences,
    errors: t.errors,
  };
}
