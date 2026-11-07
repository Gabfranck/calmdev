// The desktop app's configuration (desktop/, docs/desktop.md): the name calmdev, the identifier, the window on
// localhost:3078 at 1440×900, a CSP that opens nothing but localhost, the icons of the brand, the npm scripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = (...p) => path.join(root, 'desktop', ...p);
const json = (...p) => JSON.parse(readFileSync(desktop(...p), 'utf8'));
const conf = json('src-tauri', 'tauri.conf.json');
const main = readFileSync(desktop('src-tauri', 'src', 'main.rs'), 'utf8');

test('the app is named calmdev with the identifier ai.calmdev.desktop', () => {
  assert.equal(conf.productName, 'calmdev');
  assert.equal(conf.identifier, 'ai.calmdev.desktop');
  assert.match(readFileSync(desktop('src-tauri', 'Cargo.toml'), 'utf8'), /^name = "calmdev"$/m);
});

test('one window, 1440×900, titled calmdev, built by the app on the splash', () => {
  assert.equal(conf.app.windows.length, 1);
  const [w] = conf.app.windows;
  assert.equal(w.label, 'main');
  assert.equal(w.title, 'calmdev');
  assert.equal(w.width, 1440);
  assert.equal(w.height, 900);
  assert.equal(w.url, 'index.html');
  assert.ok(existsSync(path.join(desktop('src-tauri'), conf.build.frontendDist, 'index.html')));
});

test('the window opens http://localhost:3078, or the port of PORT', () => {
  assert.equal(json('src-tauri', 'calmdev.json').port, 3078);
  assert.match(main, /format!\("http:\/\/localhost:\{port\}"\)/);
  assert.match(main, /std::env::var\("PORT"\)/);
});

test('the CSP opens nothing but localhost', () => {
  const csp = conf.app.security.csp;
  assert.ok(csp, 'a CSP is set');
  const sources = csp.split(';').flatMap((d) => d.trim().split(/\s+/).slice(1));
  const remote = sources.filter((s) => /^[a-z]+:\/\//.test(s) && !/^(https?|wss?):\/\/localhost(:\*|:\d+)?$/.test(s));
  assert.deepEqual(remote, []);
  assert.ok(!sources.includes('*'), 'no wildcard source');
  assert.match(csp, /object-src 'none'/);
});

test('the splash says calmdev démarre and has the failure hook', () => {
  assert.match(readFileSync(desktop('splash', 'index.html'), 'utf8'), /calmdev démarre/);
  assert.match(readFileSync(desktop('splash', 'splash.js'), 'utf8'), /window\.calmdevFail =/);
  assert.match(main, /calmdevFail/);
});

test('icons of the brand, the npm scripts and the CLI', () => {
  for (const icon of conf.bundle.icon) assert.ok(existsSync(desktop('src-tauri', icon)), icon);
  const pkg = json('package.json');
  assert.equal(pkg.scripts.dev, 'tauri dev');
  assert.match(pkg.scripts['build:debug'], /^tauri build --debug/);
  assert.ok(pkg.devDependencies['@tauri-apps/cli'].includes('2'));
  assert.ok(pkg.private);
});
