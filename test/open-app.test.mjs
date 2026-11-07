// The app window (scripts/open-app.sh): ESCADRILLE_OPEN_DRY=1 prints the command instead of running it; the
// browsers are fakes (folders named X.app, executables in a throwaway PATH). The window itself is never opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const URL_ = 'http://localhost:3078';
const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-open-')));
const bin = (...names) => { const d = tmp(); for (const n of names) { writeFileSync(path.join(d, n), '#!/bin/sh\n'); chmodSync(path.join(d, n), 0o755); } return d; };
const apps = (...names) => { const d = tmp(); for (const n of names) mkdirSync(path.join(d, n + '.app')); return d; };
const run = (env, args = [URL_], setup = () => {}) => {
  const home = tmp(); setup(home);
  return { home, out: execFileSync('/bin/sh', [path.join(ROOT, 'scripts/open-app.sh'), ...args],
    { env: { HOME: home, ESCADRILLE_OPEN_DRY: '1', ...env }, encoding: 'utf8' }).trim() };
};
const flags = (home, dir = '.calmdev') => `--app=${URL_} --user-data-dir=${home}/${dir}/app-profile --window-size=1440,900 --no-first-run --no-default-browser-check`;

test('macOS: Google Chrome first, through open -na, with a separate profile and 1440x900', () => {
  const { home, out } = run({ ESCADRILLE_OS: 'Darwin', ESCADRILLE_APPS_DIRS: apps('Google Chrome', 'Microsoft Edge', 'Brave Browser'), PATH: bin('open') });
  assert.equal(out, `open -na Google Chrome --args ${flags(home)}`);
  assert.ok(!existsSync(path.join(home, '.calmdev')), 'dry run creates nothing');
});

test('the profile stays in ~/.escadrille when only it exists; CALMDEV_OS is read before ESCADRILLE_OS', () => {
  const { home, out } = run({ CALMDEV_OS: 'Darwin', ESCADRILLE_OS: 'Linux', ESCADRILLE_APPS_DIRS: apps('Google Chrome'), PATH: bin('open') }, undefined, (h) => mkdirSync(path.join(h, '.escadrille'), { recursive: true }));
  assert.equal(out, `open -na Google Chrome --args ${flags(home, '.escadrille')}`);
});

test('macOS: Edge, Brave, Chromium in that order; Arc is ignored', () => {
  const pick = (...names) => run({ ESCADRILLE_OS: 'Darwin', ESCADRILLE_APPS_DIRS: apps(...names), PATH: bin('open') }).out;
  assert.match(pick('Brave Browser', 'Microsoft Edge'), /^open -na Microsoft Edge --args /);
  assert.match(pick('Chromium', 'Brave Browser'), /^open -na Brave Browser --args /);
  assert.match(pick('Chromium'), /^open -na Chromium --args /);
  const arc = pick('Arc');
  assert.match(arc, /^No Chromium browser found/);
  assert.match(arc, /\nopen http:\/\/localhost:3078$/);
});

test('macOS: ~/Applications counts, the folders are searched in order', () => {
  const a = apps(), b = apps('Chromium');
  assert.match(run({ ESCADRILLE_OS: 'Darwin', ESCADRILLE_APPS_DIRS: `${a}:${b}`, PATH: bin('open') }).out, /^open -na Chromium /);
});

test('Linux: each browser is found by its name, in the documented order', () => {
  const order = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];
  order.forEach((name, i) => {
    const { home, out } = run({ ESCADRILLE_OS: 'Linux', PATH: bin(...order.slice(i), 'xdg-open') });
    assert.equal(out, `${name} ${flags(home)}`);
  });
});

test('Linux and macOS without a Chromium browser: the usual open, and a line that says so', () => {
  const linux = run({ ESCADRILLE_OS: 'Linux', PATH: bin('xdg-open', 'firefox') }).out;
  assert.equal(linux, `No Chromium browser found (Chrome, Edge, Brave, Chromium): opening ${URL_} in a tab of the default browser.\nxdg-open ${URL_}`);
  assert.match(run({ ESCADRILLE_OS: 'Darwin', ESCADRILLE_APPS_DIRS: apps(), PATH: bin('open') }).out, /\nopen http:\/\/localhost:3078$/);
  assert.match(run({ ESCADRILLE_OS: 'Linux', PATH: bin() }).out, /^No Chromium browser found and no xdg-open: open http:\/\/localhost:3078 in your browser\.$/);
});

test('the URL defaults to the PORT of the environment', () => {
  const { out } = run({ ESCADRILLE_OS: 'Linux', PORT: '3111', PATH: bin('chromium') }, []);
  assert.match(out, /^chromium --app=http:\/\/localhost:3111 /);
});

test('install.sh and run.sh know the window: --tab keeps the tab, run.sh --open reopens', () => {
  const out = execFileSync('/bin/sh', [path.join(ROOT, 'install.sh'), '--help'], { encoding: 'utf8' });
  assert.match(out, /--tab/);
  execFileSync('/bin/sh', ['-n', path.join(ROOT, 'run.sh')]);
  execFileSync('/bin/sh', ['-n', path.join(ROOT, 'install.sh')]);
  const opened = execFileSync('/bin/sh', [path.join(ROOT, 'run.sh'), '--open'],
    { env: { HOME: tmp(), ESCADRILLE_OPEN_DRY: '1', ESCADRILLE_OS: 'Linux', PATH: bin('google-chrome', 'dirname') + ':/usr/bin:/bin' }, encoding: 'utf8' });
  assert.match(opened, /^google-chrome --app=http:\/\/localhost:3078 /);
});

test('an installed app opens by its id, in the profile that holds it; otherwise the --app window', () => {
  const id = 'ekbpnfecnhdpinbjejalhpkmliekildc'; // Chrome's id for the manifest id http://localhost:3078/
  const data = tmp(); const env = { ESCADRILLE_OS: 'Darwin', ESCADRILLE_APPS_DIRS: apps('Google Chrome'), ESCADRILLE_BROWSER_DATA: data, PATH: bin('open') + ':/usr/bin:/bin' };
  assert.match(run(env).out, /--app=http:\/\/localhost:3078 /, 'not installed: the --app window');
  mkdirSync(path.join(data, 'Google/Chrome/Profile 1/Web Applications/Manifest Resources', id), { recursive: true });
  assert.equal(run(env).out, `open -na Google Chrome --args --profile-directory=Profile 1 --app-id=${id}`);
  assert.match(run(env, ['http://localhost:3999']).out, /--app=http:\/\/localhost:3999 /, 'another port is another app');
  const linux = tmp(); mkdirSync(path.join(linux, 'chromium/Default/Web Applications/Manifest Resources', id), { recursive: true });
  assert.equal(run({ ESCADRILLE_OS: 'Linux', ESCADRILLE_BROWSER_DATA: linux, PATH: bin('chromium', 'xdg-open') + ':/usr/bin:/bin' }).out, `chromium --profile-directory=Default --app-id=${id}`);
});
