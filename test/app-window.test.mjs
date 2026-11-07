// The installed app (phase 11, W): the manifest, its link in every page, the overlay CSS, the install line's rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const PUB = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public');
const read = (f) => readFileSync(path.join(PUB, f), 'utf8');

test('the manifest asks for the overlay and its icons exist', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.deepEqual(m.display_override, ['window-controls-overlay']);
  assert.ok(m.name && m.start_url === '/' && m.id === '/');
  for (const i of m.icons) assert.ok(existsSync(path.join(PUB, i.src)), i.src);
  assert.ok(!existsSync(path.join(PUB, 'sw.js')), 'no service worker');
});

test('every page links the manifest, both theme colors and app-window.js', () => {
  for (const f of readdirSync(PUB).filter((x) => x.endsWith('.html'))) {
    const h = read(f);
    assert.equal((h.match(/rel="manifest"/g) || []).length, 1, f);
    assert.equal((h.match(/src="\/app-window\.js"/g) || []).length, 1, f);
    assert.match(h, /name="theme-color"[^>]*prefers-color-scheme: dark/, f);
  }
});

test('the overlay CSS drags the bar and the header, never a control', () => {
  const css = read('app.css'); const i = css.indexOf('@media (display-mode: window-controls-overlay)');
  assert.ok(i > 0); const o = css.slice(i);
  assert.match(o, /titlebar-area-x/); assert.match(o, /titlebar-area-width/); assert.match(o, /titlebar-area-height/);
  assert.match(o, /\.drag-strip[^}]*app-region: drag/); assert.match(o, /\.topbar[^}]*app-region: drag/);
  assert.match(o, /\.topbar :is\([^)]*button[^)]*input[^)]*\)[^}]*app-region: no-drag/);
  assert.match(o, /\.mark[^}]*app-region: no-drag/);
  assert.ok(!/app-region: drag/.test(css.slice(0, i).replace(/\/\*[\s\S]*?\*\//g, '')), 'outside the overlay nothing drags');
  assert.match(read('sidebar.js'), /class="drag-strip"/);
});

// Dev, 2026-11-02: in the installed app the picker sat under the window's buttons
test('the overlay: the bar starts under the title row, the picker is never a drag zone, the simulated macOS frame shares the rules', () => {
  const css = read('app.css'); const o = css.slice(css.indexOf('@media (display-mode: window-controls-overlay)'));
  assert.match(o, /@media \(display-mode: window-controls-overlay\) \{\s*:root \{ --wco: 1;/, 'the real window sets the one switch');
  assert.match(o, /@container style\(--wco: 1\) \{/, 'the rules read the switch');
  assert.match(o, /\.sidebar \{ padding-top: calc\(var\(--wco-h\) \+ 8px\); \}/, 'the bar content starts under the title row');
  assert.match(o, /\.sidebar :is\(a, button, input, summary, form\) \{[^}]*app-region: no-drag/, 'no row of the bar (the entry, a project) drags the window');
  assert.match(o, /:root\[data-wco="mac"\] \{ --wco: 1; --wco-h: 28px; --wco-x: 80px; --wco-w: calc\(100vw - 80px\); \}/, 'the simulated frame: a real macOS window\'s values');
  assert.match(o, /:root\[data-wco="mac"\] body::before \{[^}]*#ff5f57[^}]*#febc2e[^}]*#28c840/, 'the three buttons, top left');
  assert.match(read('sidebar.js'), /q\.get\('wco'\) === 'mac'\) root\.document\.documentElement\.dataset\.wco = 'mac'/, '?wco=mac sets the frame for a capture');
});

test('the install line shows once: not installed, offered, not answered', () => {
  const { wants } = (new Function('globalThis', read('app-window.js') + '; return globalThis;'))({}).escadrilleApp;
  assert.equal(wants(null, false, {}), true);
  assert.equal(wants(null, false, null), false, 'Chrome did not offer');
  assert.equal(wants(null, true, {}), false, 'already an app window');
  assert.equal(wants('done', false, {}), false); assert.equal(wants('no', false, {}), false);
});

test('the install line is worded in both languages', () => {
  for (const l of ['fr', 'en']) { const j = JSON.parse(read(`i18n/${l}.json`)); assert.ok(j['install.line'] && j['install.no'], l); }
});
