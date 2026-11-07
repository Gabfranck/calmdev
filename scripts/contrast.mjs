#!/usr/bin/env node
// The contrast table of the design system (docs/design-system/README.md §3), measured from public/app.css for both
// themes, WCAG 2 (L = 0.2126 R + 0.7152 G + 0.0722 B on linearised channels; ratio = (L1 + 0.05) / (L2 + 0.05)).
//   node scripts/contrast.mjs            prints the table, light and dark, with the AA verdict (4.5 text, 3 large or border)
//   node scripts/contrast.mjs --check    exits 1 when a text pair is under its floor (test/tokens.test.mjs does the same)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extract, SRC } from './tokens.mjs';

const lum = (hex) => { const c = hex.replace('#', ''); const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)]; return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100; };

// [foreground, background, floor, what it is]; 4.5 for running text, 3 for large text and for a border that is the one cue
export const PAIRS = [
  ['--text', '--surface', 4.5, 'body on the sheet'], ['--text', '--ground', 4.5, 'body on the ground'], ['--text', '--raised', 4.5, 'body in a well'], ['--text', '--active', 4.5, 'the current row'],
  ['--muted', '--surface', 4.5, 'secondary on the sheet'], ['--muted', '--ground', 4.5, 'secondary on the ground'], ['--muted', '--raised', 4.5, 'secondary in a well'],
  ['--faint', '--surface', 4.5, '13 px labels on the sheet'], ['--faint', '--ground', 4.5, '13 px labels of the bar'], ['--faint', '--raised', 4.5, '13 px labels in a well'],
  ['--accent', '--surface', 4.5, 'a link, a running state'], ['--accent', '--ground', 4.5, 'the mark, the dot'], ['--accent', '--active', 3, 'the quota bar on its track'],
  ['--accent-ink', '--accent', 4.5, 'text on the accent'], ['--accent', '--accent-tint', 4.5, 'the Claude badge'], ['--primary-ink', '--primary', 4.5, 'the primary button'],
  ['--positive', '--surface', 4.5, 'a positive state'], ['--negative', '--surface', 4.5, 'a negative state'], ['--warning', '--surface', 4.5, 'a warning'],
  ['--pill-wait-ink', '--pill-wait-bg', 4.5, 'the wait pill'], ['--pill-positive-ink', '--pill-positive-bg', 4.5, 'the positive pill'], ['--pill-negative-ink', '--pill-negative-bg', 4.5, 'the negative pill'],
  ['--pill-warning-ink', '--pill-warning-bg', 4.5, 'the warning pill'], ['--pill-neutral-ink', '--pill-neutral-bg', 4.5, 'the neutral pill'], ['--pill-wait-ink', '--ground', 4.5, 'the count of the bar'],
  // the two borders are tone steps, not the only cue (a field has its ground and its accent focus, the sheet its inset): no AA floor, listed to be seen
  ['--control', '--surface', 1.5, 'the border of a field or a button (1.5: a step, the cue is the ground and the focus)'], ['--border', '--ground', 1, 'the edge of the sheet (a tone step)'],
];

export const table = (css = readFileSync(SRC, 'utf8')) => {
  const t = extract(css); const light = Object.fromEntries(t.light); const dark = { ...light, ...Object.fromEntries(t.dark) };
  return PAIRS.map(([fg, bg, floor, what]) => { const l = ratio(light[fg], light[bg]), d = ratio(dark[fg], dark[bg]); return { fg, bg, floor, what, light: l, dark: d, ok: l >= floor && d >= floor }; });
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rows = table(); const check = process.argv.includes('--check'); let bad = 0;
  console.log('| Paire | Clair | Sombre | Plancher | AA |\n| --- | --- | --- | --- | --- |');
  for (const r of rows) { if (!r.ok) bad++; console.log(`| \`${r.fg}\` / \`${r.bg}\` (${r.what}) | ${r.light.toFixed(2)} | ${r.dark.toFixed(2)} | ${r.floor} | ${r.ok ? 'oui' : '**non**'} |`); }
  if (check) { console.log(bad ? `${bad} pair(s) under the floor` : 'every pair is AA'); process.exit(bad ? 1 : 0); }
}
