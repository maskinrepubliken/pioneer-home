/** State of the help panel in the Tabeller view (side panel on wide screens, bottom sheet on phones). */
import type { HelpTab } from './docs.sv';

export const help = $state<{ open: boolean; tab: HelpTab; section: string | null }>({ open: false, tab: 'formulas', section: null });

/** Opens the panel on `tab`, optionally scrolled to a section id from docs.sv.ts. */
export function openHelp(tab?: HelpTab, section: string | null = null): void {
  if (tab) help.tab = tab;
  help.section = section;
  help.open = true;
}

export function closeHelp(): void {
  help.open = false;
}

export function toggleHelp(): void {
  help.open = !help.open;
}
