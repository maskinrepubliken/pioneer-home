/**
 * Weather forecast from SMHI's open data (snow1g point forecast: free, no key, about ten days, hourly for the first
 * two). Outdoor temperature and cloud cover for the program planner. Fetched at most once an hour and cached in
 * STATE_DIR/forecast.json, so a restart or a network outage keeps the last forecast.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Logger } from 'pino';

/** One forecast point: epoch ms, °C, cloud cover in octas (0 clear .. 8 overcast). */
export interface ForecastPoint {
  t: number;
  temperature: number;
  octas: number;
}

export interface Forecast {
  /** when SMHI made it (epoch ms), when it was fetched */
  created: number;
  fetched: number;
  points: ForecastPoint[];
}

interface ApiResponse {
  createdTime?: string;
  timeSeries?: { time: string; data: { air_temperature?: number; cloud_area_fraction?: number } }[];
}

export class ForecastService {
  private current: Forecast | null = null;
  private pending: Promise<Forecast | null> | null = null;

  constructor(
    private latitude: number,
    private longitude: number,
    private cacheFile: string,
    private log: Logger,
  ) {
    if (existsSync(cacheFile)) {
      try {
        this.current = JSON.parse(readFileSync(cacheFile, 'utf8')) as Forecast;
      } catch {
        this.current = null;
      }
    }
  }

  /** The latest forecast, refetched when older than an hour; the cached one when SMHI cannot be reached. */
  async get(): Promise<Forecast | null> {
    if (this.current && Date.now() - this.current.fetched < 3_600_000) return this.current;
    this.pending ??= this.fetch().finally(() => (this.pending = null));
    return this.pending;
  }

  private async fetch(): Promise<Forecast | null> {
    const lon = this.longitude.toFixed(4);
    const lat = this.latitude.toFixed(4);
    const url = `https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/lon/${lon}/lat/${lat}/data.json`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = (await res.json()) as ApiResponse;
      const points = (raw.timeSeries ?? [])
        .map((p) => ({ t: Date.parse(p.time), temperature: p.data.air_temperature, octas: p.data.cloud_area_fraction }))
        .filter((p): p is ForecastPoint => typeof p.temperature === 'number' && typeof p.octas === 'number' && Number.isFinite(p.t));
      if (!points.length) throw new Error('no forecast points');
      this.current = { created: raw.createdTime ? Date.parse(raw.createdTime) : Date.now(), fetched: Date.now(), points };
      writeFileSync(this.cacheFile, JSON.stringify(this.current));
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'SMHI forecast fetch failed');
    }
    return this.current;
  }
}

/** Linear interpolation of a forecast field at an instant; the nearest end outside the forecast. */
export function forecastAt(points: ForecastPoint[], t: number, field: 'temperature' | 'octas'): number | null {
  if (!points.length) return null;
  if (t <= points[0]!.t) return points[0]![field];
  for (let i = 1; i < points.length; i++) {
    const b = points[i]!;
    if (t <= b.t) {
      const a = points[i - 1]!;
      const f = (t - a.t) / (b.t - a.t);
      return a[field] + (b[field] - a[field]) * f;
    }
  }
  return points[points.length - 1]![field];
}
