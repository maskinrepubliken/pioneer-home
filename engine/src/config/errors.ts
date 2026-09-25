/** A problem found while loading the tables. Always points at a file and line so an agent can go fix it. */
export interface ConfigError {
  file: string;
  line: number;
  column?: string;
  message: string;
}

export class ConfigLoadError extends Error {
  constructor(readonly errors: ConfigError[]) {
    super(`${errors.length} configuration error(s):\n${errors.map(formatConfigError).join('\n')}`);
    this.name = 'ConfigLoadError';
  }
}

export function formatConfigError(e: ConfigError): string {
  const col = e.column ? ` [${e.column}]` : '';
  return `${e.file}:${e.line}${col}: ${e.message}`;
}
