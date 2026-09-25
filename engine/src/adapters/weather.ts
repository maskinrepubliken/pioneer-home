/**
 * OpenWeatherMap "current weather" poller feeding the weather.* system cells.
 * History rows (collection `weather`) come from history.tsv like everything else.
 */
import type { Logger } from 'pino';
import type { Engine } from '../core/engine.js';
import type { Value } from '../formula/values.js';

export interface WeatherOptions {
  apiKey: string;
  latitude: number;
  longitude: number;
  intervalMs: number;
  lang?: string;
}

interface OwmResponse {
  main?: { temp?: number; humidity?: number; pressure?: number };
  wind?: { speed?: number; deg?: number };
  rain?: { '1h'?: number };
  snow?: { '1h'?: number };
  weather?: { description?: string; icon?: string }[];
  sys?: { sunrise?: number; sunset?: number };
}

export function startWeather(engine: Engine, opts: WeatherOptions, log: Logger): () => void {
  let stopped = false;
  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${opts.latitude}&lon=${opts.longitude}&units=metric&lang=${opts.lang ?? 'sv'}&appid=${encodeURIComponent(opts.apiKey)}`;

  const poll = async () => {
    if (stopped) return;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const w = (await res.json()) as OwmResponse;
      const changes: { cell: string; value: Value }[] = [];
      const put = (cell: string, v: unknown) => {
        if (typeof v === 'number' || typeof v === 'string') changes.push({ cell, value: v });
      };
      put('weather.temperature', w.main?.temp);
      put('weather.humidity', w.main?.humidity);
      put('weather.windspeed', w.wind?.speed);
      put('weather.winddirection', w.wind?.deg);
      changes.push({ cell: 'weather.precipitation', value: (w.rain?.['1h'] ?? 0) + (w.snow?.['1h'] ?? 0) });
      put('weather.detail', w.weather?.[0]?.description);
      put('weather.icon', w.weather?.[0]?.icon);
      engine.applyInputs(changes, 'weather');
      log.debug({ temp: w.main?.temp, detail: w.weather?.[0]?.description }, 'weather updated');
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'weather poll failed');
    }
  };

  void poll();
  const timer = setInterval(() => void poll(), opts.intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
