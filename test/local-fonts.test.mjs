// Google Fonts (decision of 6 November, 18:40): a page may load a Google font if a CSS of the page or public/app.css
// really names the family in a font-family. A family loaded and never named is refused (IBM Plex, loaded and unused).
// The app's own type stays the system stack of public/app.css (--font, --mono).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PUBLIC = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public');
const FONT_HOSTS = /fonts\.(googleapis|gstatic)\.com/;

// Families asked from Google in a text: `family=IBM+Plex+Sans:wght@400` (links, @import) -> "IBM Plex Sans".
export function googleFamilies(text) {
  const out = new Set();
  for (const m of text.matchAll(/https?:\/\/fonts\.googleapis\.com\/[^"')\s>]*/g)) {
    for (const f of m[0].matchAll(/[?&;]family=([^:&;@"')\s]+)/g)) out.add(decodeURIComponent(f[1].replace(/\+/g, ' ')).trim());
  }
  return [...out];
}
// Every font-family declaration (and `font:` shorthand) of a text, lowercased, quotes dropped.
function namedFonts(text) {
  return [...text.matchAll(/font(?:-family)?\s*:[^;}]*/gi)].map((m) => m[0].toLowerCase().replace(/["']/g, '')).join('\n');
}

test('a Google font loaded by a page is used by a CSS of the page or app.css', () => {
  const files = readdirSync(PUBLIC).filter((f) => /\.(html|css|js)$/.test(f));
  assert.ok(files.filter((f) => f.endsWith('.html')).length >= 10, `pages read: ${files.length} (the scan broke, not the pages)`);
  const read = (f) => readFileSync(path.join(PUBLIC, f), 'utf8');
  const appCss = namedFonts(read('app.css'));
  const unused = [];
  for (const f of files) {
    const text = read(f);
    if (!FONT_HOSTS.test(text)) continue;
    // the page's own CSS: inline <style>, the file itself if a stylesheet, and the local stylesheets it links
    let css = f.endsWith('.css') ? text : '';
    for (const s of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) css += s[1];
    for (const l of text.matchAll(/href="(?!https?:)([^"?#]+\.css)/g)) {
      try { css += readFileSync(path.join(PUBLIC, l[1]), 'utf8'); } catch {}
    }
    const used = namedFonts(css) + '\n' + appCss;
    const families = googleFamilies(text);
    if (!families.length) unused.push(`${f}: Google host without a readable family`);
    for (const fam of families) if (!used.includes(fam.toLowerCase())) unused.push(`${f}: ${fam}`);
  }
  assert.deepEqual(unused, [], 'Google fonts loaded and never named in a font-family');
});

test('googleFamilies reads the family names of a Google Fonts link', () => {
  const link = '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500&family=IBM+Plex+Mono&display=swap" rel="stylesheet">';
  assert.deepEqual(googleFamilies(link), ['IBM Plex Sans', 'IBM Plex Mono']);
});

test('the app keeps a system font stack (no web font needed)', () => {
  const css = readFileSync(path.join(PUBLIC, 'app.css'), 'utf8');
  assert.match(css, /--font:\s*-apple-system,[^;]*sans-serif;/); assert.match(css, /--mono:\s*ui-monospace,[^;]*monospace;/);
});
