// Opening calmdev (scripts/open-app.sh): the Mac app when installed and on the same port, else the default browser.
// CALMDEV_OPEN_DRY=1 prints the command instead of running it; the apps are fake folders, open/xdg-open fake files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const URL_ = 'http://localhost:3078';
const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-open-')));
const bin = (...names) => { const d = tmp(); for (const n of names) { writeFileSync(path.join(d, n), '#!/bin/sh\n'); chmodSync(path.join(d, n), 0o755); } return d; };
const apps = (...names) => { const d = tmp(); for (const n of names) mkdirSync(path.join(d, n + '.app')); return d; };
const run = (env, args = [URL_], setup = () => {}) => {
  const home = tmp(); setup(home);
  return execFileSync('/bin/sh', [path.join(ROOT, 'scripts/open-app.sh'), ...args], { env: { HOME: home, CALMDEV_OPEN_DRY: '1', ...env }, encoding: 'utf8' }).trim();
};

test('macOS: the installed calmdev.app opens, without the URL (it reads the guard link itself)', () => {
  const dir = apps('calmdev');
  assert.equal(run({ CALMDEV_OS: 'Darwin', CALMDEV_APPS_DIRS: dir, PATH: bin('open') }), `open ${dir}/calmdev.app`);
  assert.equal(run({ CALMDEV_OS: 'Darwin', CALMDEV_APPS_DIRS: dir, PATH: bin('open') }, [`${URL_}/guard?k=abc`]), `open ${dir}/calmdev.app`);
  const a = apps(); const b = apps('calmdev');
  assert.equal(run({ ESCADRILLE_OS: 'Darwin', ESCADRILLE_APPS_DIRS: `${a}:${b}`, PATH: bin('open') }), `open ${b}/calmdev.app`, 'folders in order, old variable names read');
});

test('macOS: another port than the app\'s, or no app: a tab of the default browser', () => {
  const dir = apps('calmdev');
  assert.equal(run({ CALMDEV_OS: 'Darwin', CALMDEV_APPS_DIRS: dir, PATH: bin('open') }, ['http://localhost:3999/guard?k=x']), 'open http://localhost:3999/guard?k=x');
  assert.equal(run({ CALMDEV_OS: 'Darwin', CALMDEV_APPS_DIRS: apps('Google Chrome'), PATH: bin('open') }), `open ${URL_}`);
  // the app's own config.json moves its port
  const conf = (h) => { const d = path.join(h, 'Library/Application Support/ai.calmdev.desktop'); mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, 'config.json'), '{"repo": "/x", "port": 3090, "waitSeconds": 60}'); };
  assert.equal(run({ CALMDEV_OS: 'Darwin', CALMDEV_APPS_DIRS: dir, PATH: bin('open') }, ['http://localhost:3090'], conf), `open ${dir}/calmdev.app`);
  assert.equal(run({ CALMDEV_OS: 'Darwin', CALMDEV_APPS_DIRS: dir, PATH: bin('open') }, [URL_], conf), `open ${URL_}`);
});

test('Linux: xdg-open, or a line that says where to go', () => {
  assert.equal(run({ CALMDEV_OS: 'Linux', PATH: bin('xdg-open', 'google-chrome') }), `xdg-open ${URL_}`);
  assert.equal(run({ CALMDEV_OS: 'Linux', PATH: bin() }), `Open ${URL_} in your browser.`);
  assert.equal(run({ CALMDEV_OS: 'Linux', PORT: '3111', PATH: bin('xdg-open') }, []), 'xdg-open http://localhost:3111', 'the URL defaults to PORT');
});

test('install.sh and run.sh: --tab keeps the tab, run.sh --open reopens', () => {
  const out = execFileSync('/bin/sh', [path.join(ROOT, 'install.sh'), '--help'], { encoding: 'utf8' });
  assert.match(out, /--tab/);
  execFileSync('/bin/sh', ['-n', path.join(ROOT, 'run.sh')]);
  execFileSync('/bin/sh', ['-n', path.join(ROOT, 'install.sh')]);
  const opened = execFileSync('/bin/sh', [path.join(ROOT, 'run.sh'), '--open'],
    { env: { HOME: tmp(), CALMDEV_OPEN_DRY: '1', CALMDEV_OS: 'Linux', PATH: bin('xdg-open', 'dirname') + ':/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(opened.trim(), `xdg-open ${URL_}`);
});
