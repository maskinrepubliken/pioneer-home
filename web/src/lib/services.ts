/**
 * Other services on the Pi, linked from the footer on every page. A setting (settings.tsv) is a full URL or
 * `:port/path` on the host this page was loaded from, so the link works over the LAN and Tailscale alike.
 */
import type { Cell } from './api';

export const SERVICES: { key: string; label: string; what: string; fallback: string }[] = [
  { key: 'z2m_frontend', label: 'Zigbee2MQTT', what: 'Zigbee-enheter, parkoppling', fallback: ':8080' },
  { key: 'pocketbase_admin', label: 'PocketBase', what: 'historikdatabasen', fallback: ':8090/_/' },
];

export function serviceUrl(cells: Record<string, Cell>, key: string, fallback: string): string {
  const v = cells[key]?.value;
  const raw = typeof v === 'string' && v ? v : fallback;
  return raw.startsWith(':') ? `${location.protocol}//${location.hostname}${raw}` : raw;
}
