/**
 * Saving a table from the UI: validate the whole configuration with the edited file swapped in,
 * and only then write it (atomically). Optionally records the change in git when tables/ is a repo.
 */
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ConfigError } from '../config/errors.js';
import { loadConfig, TABLE_FILES } from '../config/loader.js';
import { normaliseTsvText } from '../config/tsv.js';

export type SaveResult = { ok: true; text: string; git: Promise<string | null> } | { ok: false; errors: ConfigError[] };

export function isEditableTable(file: string): boolean {
  return TABLE_FILES.some((t) => `${t}.tsv` === file);
}

/** Validates `text` as the new content of `file` inside `dir`. Never touches `dir`. */
export function validateTable(dir: string, file: string, text: string): ConfigError[] {
  const tmp = mkdtempSync(join(tmpdir(), 'pioneer-validate-'));
  try {
    for (const f of readdirSync(dir)) if (f.endsWith('.tsv')) copyFileSync(join(dir, f), join(tmp, f));
    const scripts = join(dir, 'scripts');
    if (existsSync(scripts)) {
      // scripts are referenced by name only; mirror the directory listing
      const dst = join(tmp, 'scripts');
      rmSync(dst, { recursive: true, force: true });
      copyDir(scripts, dst);
    }
    writeFileSync(join(tmp, file), text);
    const res = loadConfig(tmp);
    return res.ok ? [] : res.errors;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Validates, normalises and writes the table. Returns the normalised text on success. */
export function saveTable(dir: string, file: string, text: string, opts: { git?: boolean; message?: string } = {}): SaveResult {
  if (!isEditableTable(basename(file))) return { ok: false, errors: [{ file, line: 1, message: `not an editable table (${TABLE_FILES.map((t) => `${t}.tsv`).join(', ')})` }] };
  const normalised = normaliseTsvText(text.replace(/\r\n?/g, '\n'));
  const errors = validateTable(dir, file, normalised);
  if (errors.length) return { ok: false, errors };
  const target = join(dir, file);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, normalised);
  renameSync(tmp, target);
  const git = opts.git === false ? Promise.resolve(null) : gitCommit(dir, file, opts.message ?? `ui: edit ${file}`);
  return { ok: true, text: normalised, git };
}

/**
 * Best effort: commit the file if `dir` is a git work tree. Resolves to null on success, to a reason
 * when nothing was committed (not a repo, nothing changed, git error). Never throws.
 */
export function gitCommit(dir: string, file: string, message: string): Promise<string | null> {
  const run = (args: string[]) =>
    new Promise<{ ok: boolean; out: string }>((resolve) => {
      execFile('git', ['-C', dir, ...args], { env: { ...process.env, HOME: process.env['HOME'] ?? '/tmp' } }, (e, stdout, stderr) =>
        resolve({ ok: !e, out: `${stdout}${stderr}`.trim() }),
      );
    });
  return (async () => {
    const inside = await run(['rev-parse', '--is-inside-work-tree']);
    if (!inside.ok || inside.out !== 'true') return `not a git repo: ${inside.out || 'no .git'}`;
    const add = await run(['add', '--', file]);
    if (!add.ok) return `git add failed: ${add.out}`;
    const commit = await run(['-c', 'user.name=pioneer-ui', '-c', 'user.email=ui@pioneer-home', 'commit', '-q', '-m', message, '--', file]);
    if (!commit.ok) return `git commit failed: ${commit.out}`;
    return null;
  })();
}

function copyDir(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(src)) {
    const s = join(src, f);
    const d = join(dst, f);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}
