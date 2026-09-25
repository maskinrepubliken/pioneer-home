/** Hash routes: `#/live`, `#/tables`, `#/tables/<file>.tsv`, `#/trace`, `#/history`. */
export type View = 'live' | 'tables' | 'trace' | 'history';
export const VIEWS: View[] = ['live', 'tables', 'trace', 'history'];

export interface Route {
  view: View;
  /** `#/tables/rules.tsv` -> 'rules.tsv'; null on the tables overview and every other view. */
  file: string | null;
}

export function parseRoute(hash: string = location.hash): Route {
  const parts = hash.replace(/^#\/?/, '').split('?')[0]!.split('/');
  const view = (VIEWS as string[]).includes(parts[0] ?? '') ? (parts[0] as View) : 'live';
  const file = view === 'tables' && parts[1] ? decodeURIComponent(parts[1]) : null;
  return { view, file };
}

export function tableHash(file: string | null): string {
  return file ? `#/tables/${encodeURIComponent(file)}` : '#/tables';
}

export function sameRoute(a: Route, b: Route): boolean {
  return a.view === b.view && a.file === b.file;
}
