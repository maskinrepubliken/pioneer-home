/**
 * Open/closed state of the Live view's disclosures (device details, room Detaljer, System), remembered in localStorage.
 * Keys look like `room:bedroom`, `device:lamp1`, `system`. Everything is closed by default.
 */
const STORAGE_KEY = 'live.open';

function load(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

const open: Record<string, boolean> = $state(load());

export function isOpen(key: string): boolean {
  return open[key] === true;
}

export function toggleOpen(key: string): void {
  if (open[key]) delete open[key];
  else open[key] = true;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(open));
  } catch {
    /* private mode: remembered for this page load only */
  }
}

/** A DOM id derived from a key, for aria-controls. */
export function disclosureId(key: string): string {
  return 'dl-' + key.replace(/[^a-zA-Z0-9_-]/g, '-');
}
