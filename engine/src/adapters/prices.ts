/**
 * Electricity spot prices from elprisetjustnu.se (free, no key): one JSON file per day and price area, in 15-minute
 * (earlier: hourly) slots, SEK per kWh excluding VAT. Days are cached in STATE_DIR/prices/ so a 30-day history view
 * does not refetch; today and tomorrow are refetched when older than an hour (tomorrow is published around 13:00).
 * Feeds the system cell `electricity.price` (the slot that is current now) and GET /api/prices.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { Engine } from '../core/engine.js';

/** One price slot: epoch seconds, SEK per kWh without VAT. */
export interface PriceSlot {
  start: number;
  end: number;
  sek: number;
}

interface ApiSlot {
  SEK_per_kWh: number;
  time_start: string;
  time_end: string;
}

export class PriceService {
  private memory = new Map<string, PriceSlot[]>();

  constructor(
    private area: string,
    private cacheDir: string,
    private timeZone: string,
    private log: Logger,
  ) {
    mkdirSync(cacheDir, { recursive: true });
  }

  /** YYYY-MM-DD of an instant in the house's time zone (the API's days are local days). */
  private day(ms: number): string {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  }

  private async fetchDay(day: string): Promise<PriceSlot[]> {
    const file = join(this.cacheDir, `${day}_${this.area}.json`);
    const today = this.day(Date.now());
    const fresh = day < today || (existsSync(file) && Date.now() - statSync(file).mtimeMs < 3_600_000);
    if (this.memory.has(day) && fresh) return this.memory.get(day)!;
    if (existsSync(file) && fresh) {
      const slots = JSON.parse(readFileSync(file, 'utf8')) as PriceSlot[];
      this.memory.set(day, slots);
      return slots;
    }
    const [y, m, d] = day.split('-');
    const url = `https://www.elprisetjustnu.se/api/v1/prices/${y}/${m}-${d}_${this.area}.json`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (res.status === 404) return []; // not published yet (tomorrow before ~13:00) or before the API's history
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = (await res.json()) as ApiSlot[];
      const slots = raw.map((s) => ({ start: Date.parse(s.time_start) / 1000, end: Date.parse(s.time_end) / 1000, sek: s.SEK_per_kWh }));
      writeFileSync(file, JSON.stringify(slots));
      this.memory.set(day, slots);
      return slots;
    } catch (e) {
      this.log.warn({ err: (e as Error).message, day }, 'spot price fetch failed');
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as PriceSlot[]) : [];
    }
  }

  /** All slots overlapping [since, until] (ms), at most 62 days. */
  async query(sinceMs: number, untilMs: number): Promise<PriceSlot[]> {
    const days: string[] = [];
    for (let t = sinceMs; t <= untilMs + 86_400_000 && days.length < 62; t += 86_400_000) {
      const d = this.day(t);
      if (!days.includes(d)) days.push(d);
    }
    const out: PriceSlot[] = [];
    for (const d of days) out.push(...(await this.fetchDay(d)));
    return out.filter((s) => s.end * 1000 > sinceMs && s.start * 1000 < untilMs).sort((a, b) => a.start - b.start);
  }

  /** Keeps `electricity.price` on the current slot. */
  start(engine: Engine): () => void {
    const tick = async () => {
      const now = Date.now();
      const slot = (await this.query(now - 3_600_000, now + 3_600_000)).find((s) => s.start * 1000 <= now && now < s.end * 1000);
      engine.applyInputs([{ cell: 'electricity.price', value: slot ? slot.sek : null }], 'spot price');
    };
    void tick();
    const timer = setInterval(() => void tick(), 60_000);
    timer.unref();
    return () => clearInterval(timer);
  }
}
