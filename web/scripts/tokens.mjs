#!/usr/bin/env node
/**
 * Generates web/src/tokens.css from web/design/tokens.json (the Maskinrepubliken design tokens).
 * No dependencies. Run with `pnpm --filter web tokens`; `dev` and `build` run it first.
 *
 *   :root                                   paper theme: the one default, whatever the OS prefers
 *   :root[data-theme="paper"]               paper theme, explicit
 *   :root[data-theme="ink"]                 ink theme, only when <html data-theme="ink"> is set
 *   :root[data-theme="eink"]                e-ink (Kaleido) theme, only when <html data-theme="eink"> is set
 * The page never follows prefers-color-scheme: paper is always the background unless a theme is set.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../design/tokens.json');
const out = resolve(here, '../src/tokens.css');

const tokens = JSON.parse(readFileSync(src, 'utf8'));

/** `--name: value;` lines for one colour theme. */
function colours(theme) {
  return tokens.color.tokens.map((t) => {
    const v = t.value[theme];
    if (!v) throw new Error(`tokens.json: colour "${t.name}" has no value for theme "${theme}"`);
    return `  --${t.name}: ${v};`;
  });
}

const fonts = Object.entries(tokens.type.families).map(([k, v]) => `  --font-${k}: ${v};`);
const spacing = tokens.spacing.tokens.map((t) => `  --${t.name}: ${t.value};`);
const radius = tokens.radius.tokens.map((t) => `  --${t.name}: ${t.value};`);

const block = (selector, lines, indent = '') =>
  [`${indent}${selector} {`, ...lines.map((l) => indent + l), `${indent}}`].join('\n');

const css = [
  `/* GENERATED from web/design/tokens.json by web/scripts/tokens.mjs. Do not edit by hand. */`,
  `/* ${tokens.name} design tokens, v${tokens.version}. Themes: ${tokens.color.themes.map((t) => `${t.id} (${t.name})`).join(', ')}. */`,
  `/* Paper is the only default; ink and eink apply only with an explicit data-theme attribute on <html>. */`,
  ``,
  block(':root', [...colours('paper'), '  color-scheme: light;', '', ...fonts, '', ...spacing, '', ...radius]),
  ``,
  block(':root[data-theme="paper"]', [...colours('paper'), '  color-scheme: light;']),
  ``,
  block(':root[data-theme="ink"]', [...colours('ink'), '  color-scheme: dark;']),
  ``,
  block(':root[data-theme="eink"]', [...colours('eink'), '  color-scheme: light;']),
  ``,
].join('\n');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, css);
console.log(`tokens: wrote ${out} (${tokens.color.tokens.length} colours x ${tokens.color.themes.length} themes)`);
