// lib/capture.mjs (docs/capture.md): the targets refused, the CAPTURE: lines, the missing browser, the cleanup
// with a fake driver, and one real capture only when Playwright's chrome-headless-shell is there and can start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { checkTarget, parseCaptures, folderName, captureNote, captureTarget, findHeadlessShell, createCaptureQueue, captureBatch, pool, concurrencyOf, CONCURRENCY, MAX_PER_TURN, WIDTHS } from '../lib/capture.mjs';
// A LAN address is assembled at run time: scripts/trace-scan.mjs would take a written one for a real one.
const ip = (net, host) => `${net}.${host}`;

const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const wt = tmp('capture-wt-'); const outside = tmp('capture-out-');
writeFileSync(path.join(wt, 'page.html'), '<h1>ok</h1>');
mkdirSync(path.join(wt, 'sub')); writeFileSync(path.join(wt, 'sub', 'b.html'), '<h1>b</h1>');
writeFileSync(path.join(outside, 'secret.html'), '<h1>dehors</h1>');
symlinkSync(path.join(outside, 'secret.html'), path.join(wt, 'lien.html'));
symlinkSync(outside, path.join(wt, 'dossier'));
symlinkSync(path.join(wt, 'sub', 'b.html'), path.join(wt, 'interne.html'));
process.on('exit', () => { rmSync(wt, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

test('local http targets pass, everything else is refused with one line', () => {
  assert.equal(checkTarget('http://localhost:3078/flow', wt).url, 'http://localhost:3078/flow');
  assert.ok(checkTarget('http://127.0.0.1:5173', wt).ok);
  for (const [t, why] of [['http://example.com:80/', /hôte example\.com/], [`http://${ip('192.168.1', 4)}:3078`, /hors de la machine/], ['https://localhost:3000', /seul http/],
    ['http://localhost', /port manquant/], ['ftp://localhost:21', /seul http/], ['javascript:alert(1)', /seul http/], ['http://user:pw@localhost:3078', /identifiants/], ['', /vide/]]) {
    const r = checkTarget(t, wt);
    assert.equal(r.ok, false, t); assert.match(r.error, why); assert.ok(!r.error.includes('\n'));
  }
});

test('a .html file must resolve inside the worktree, links followed', () => {
  assert.equal(checkTarget('page.html', wt).file, path.join(wt, 'page.html'));
  assert.equal(checkTarget('interne.html', wt).file, path.join(wt, 'sub', 'b.html'));
  assert.match(checkTarget(path.join(outside, 'secret.html'), wt).error, /sort du worktree/);
  assert.match(checkTarget('../' + path.basename(outside) + '/secret.html', wt).error, /sort du worktree/);
  assert.match(checkTarget('lien.html', wt).error, /sort du worktree/);
  assert.match(checkTarget('dossier/secret.html', wt).error, /sort du worktree/);
  assert.match(checkTarget('absent.html', wt).error, /introuvable/);
  assert.match(checkTarget('notes.md', wt).error, /\.html/);
  assert.match(checkTarget('page.html', null).error, /worktree/);
});

test('CAPTURE: lines, alone on their line, unique, at most thirty per turn, state fields included', () => {
  const text = 'Voilà.\nCAPTURE: page.html\n- CAPTURE: http://localhost:3078/flow\nIl faut écrire CAPTURE: x.html en début de ligne.\nCAPTURE: page.html\nCAPTURE: page.html ; rm -rf /\n';
  assert.deepEqual(parseCaptures(text), ['page.html', 'http://localhost:3078/flow']);
  assert.deepEqual(parseCaptures('', { claude: 'CAPTURE: sub/b.html', stops: [0], summary: 'Fait\nCAPTURE: page.html' }), ['sub/b.html', 'page.html']);
  const forty = Array.from({ length: 40 }, (_, i) => `CAPTURE: p${i}.html`).join('\n');
  assert.equal(MAX_PER_TURN, 30); assert.equal(parseCaptures(forty).length, 30); assert.equal(parseCaptures(forty.split('\n').slice(0, 20).join('\n')).length, 20);
  assert.deepEqual(parseCaptures(null, null), []);
  assert.equal(folderName(1, 'http://localhost:3078/flow'), '1-localhost-3078-flow');
  assert.equal(folderName(null, 'sub/b.html'), 'tour-sub-b-html');
});

test('no chrome-headless-shell: one line, no throw', async () => {
  const empty = tmp('capture-pw-');
  assert.equal(findHeadlessShell({ env: { PLAYWRIGHT_BROWSERS_PATH: empty }, platform: 'darwin' }), null);
  assert.equal(findHeadlessShell({ env: { CHROME_PATH: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } }), null);
  const r = await captureTarget({ target: 'page.html', worktree: wt, env: { PLAYWRIGHT_BROWSERS_PATH: empty } });
  assert.equal(r.ok, false); assert.equal(r.missing, true); assert.match(r.error, /chrome-headless-shell introuvable/);
  assert.match(captureNote(r, 'page.html'), /^CAPTURE page\.html : capture impossible/);
  rmSync(empty, { recursive: true });
});

test('the newest revision of the cache is chosen', () => {
  const cache = tmp('capture-pw-');
  for (const rev of ['1100', '1248', '999']) { const d = path.join(cache, `chromium_headless_shell-${rev}`, 'chrome-headless-shell-mac-arm64'); mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, 'chrome-headless-shell'), ''); }
  assert.match(findHeadlessShell({ env: { PLAYWRIGHT_BROWSERS_PATH: cache }, platform: 'darwin' }), /chromium_headless_shell-1248/);
  rmSync(cache, { recursive: true });
});

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

test('a fake driver: two PNG, console.json, the profile removed', async () => {
  let seen;
  const driver = async ({ url, widths, profile }) => { seen = { url, widths, profile }; assert.ok(existsSync(profile)); return { shots: widths.map((w) => [w, PNG]), errors: ['boom'], warnings: ['hm'], blocked: 2, blockedHosts: ['example.com'] }; };
  const r = await captureTarget({ target: 'page.html', worktree: wt, name: '0-page-html', chromePath: '/fake/shell', driver });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.dir, path.join(wt, '.calmdev', 'captures', '0-page-html'));
  assert.deepEqual(WIDTHS, [1440, 390]); assert.deepEqual(seen.widths, [1440, 390]); assert.match(seen.url, /^file:\/\/.*page\.html$/);
  for (const f of ['1440.png', '390.png']) assert.ok(existsSync(path.join(r.dir, f)), f);
  assert.equal(existsSync(path.join(r.dir, '1024.png')), false);
  const report = JSON.parse(readFileSync(path.join(r.dir, 'console.json'), 'utf8'));
  assert.deepEqual([report.url, report.errors, report.warnings, report.blocked], [seen.url, ['boom'], ['hm'], 2]); assert.ok(report.at);
  assert.equal(existsSync(seen.profile), false);
  assert.equal(captureNote(r, 'page.html'), `CAPTURE page.html : ${r.dir} (1 erreur de console, 2 requêtes hors machine bloquées)`);
});

test('a timeout kills the browser process and removes the profile', async () => {
  let seen;
  const driver = ({ profile, track }) => { track.proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); seen = { profile, proc: track.proc }; return new Promise(() => {}); };
  const r = await captureTarget({ target: 'page.html', worktree: wt, chromePath: '/fake/shell', driver, timeoutMs: 300 });
  assert.equal(r.ok, false); assert.match(r.error, /délai/);
  assert.equal(existsSync(seen.profile), false);
  assert.ok(seen.proc.signalCode === 'SIGKILL' || seen.proc.exitCode !== null);
});

test('a driver that fails: one line, profile removed, nothing written', async () => {
  let profile;
  const r = await captureTarget({ target: 'page.html', worktree: wt, name: 'x-fail', chromePath: '/fake/shell', driver: (o) => { profile = o.profile; throw new Error('le navigateur s’est arrêté'); } });
  assert.equal(r.ok, false); assert.match(r.error, /^capture impossible : le navigateur/);
  assert.equal(existsSync(profile), false); assert.equal(existsSync(path.join(wt, '.calmdev', 'captures', 'x-fail')), false);
});

test('a refused target never reaches the driver', async () => {
  let called = false;
  const r = await captureTarget({ target: 'lien.html', worktree: wt, chromePath: '/fake/shell', driver: () => { called = true; } });
  assert.equal(r.ok, false); assert.equal(called, false);
});

test('a real capture with chrome-headless-shell', async (t) => {
  if (!findHeadlessShell()) return t.skip('chrome-headless-shell absent : npx playwright install chromium-headless-shell');
  writeFileSync(path.join(wt, 'reel.html'), '<!doctype html><title>t</title><h1 style="height:1800px">réel</h1><img src="https://example.com/x.png"><script>console.error("erreur de test")</script>');
  const r = await captureTarget({ target: 'reel.html', worktree: wt, name: 'reel' });
  if (!r.ok && /capture impossible/.test(r.error)) return t.skip('le navigateur ne démarre pas dans ce bac à sable : ' + r.error.slice(0, 120));
  assert.equal(r.ok, true, r.error);
  for (const w of [1440, 390]) assert.equal(readFileSync(path.join(r.dir, `${w}.png`)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(r.errors.some((e) => /erreur de test/.test(e)));
  assert.ok(r.blocked >= 1);
});

test('twenty captures of one stop: all taken, four at a time, notes in order, then one idle call with the twenty lines', async () => {
  const targets = parseCaptures(Array.from({ length: 20 }, (_, i) => `CAPTURE: p${i}.html`).join('\n'));
  assert.equal(targets.length, 20);
  for (const t of targets) writeFileSync(path.join(wt, t), '<h1>x</h1>');
  let active = 0; let maxActive = 0; const widthsSeen = new Set();
  const driver = async ({ widths, url }) => { active++; maxActive = Math.max(maxActive, active); widths.forEach((w) => widthsSeen.add(w)); await new Promise((r) => setTimeout(r, 5 + (Number(/p(\d+)/.exec(url)[1]) * 7) % 13)); active--; return { shots: widths.map((w) => [w, PNG]), errors: [], warnings: [], blocked: 0, blockedHosts: [] }; };
  const notes = []; const idle = [];
  const q = createCaptureQueue({ capture: (job) => captureTarget({ ...job, chromePath: '/fake/shell', driver }), onNote: (k, job, line) => notes.push(line), onIdle: (k, lines) => idle.push([k, lines]) });
  q.enqueue('plan/A', targets.map((target) => ({ target, worktree: wt, name: folderName(0, target) })));
  assert.equal(q.busy('plan/A'), true);
  while (q.busy('plan/A')) await new Promise((r) => setTimeout(r, 10));
  assert.equal(notes.length, 20); assert.equal(maxActive, CONCURRENCY);
  assert.deepEqual(notes.map((l) => l.split(' ')[1]), targets); // same order as asked, whatever finished first assert.deepEqual([...widthsSeen].sort((a, b) => b - a), [1440, 390]);
  assert.equal(idle.length, 1); assert.equal(idle[0][0], 'plan/A'); assert.equal(idle[0][1].length, 20);
  for (const t of targets) assert.ok(existsSync(path.join(wt, '.calmdev', 'captures', folderName(0, t), '390.png')), t);
});

test('a failing capture says it in one line and the queue goes on', async () => {
  writeFileSync(path.join(wt, 'ok1.html'), '<h1>1</h1>'); writeFileSync(path.join(wt, 'ok2.html'), '<h1>2</h1>');
  const driver = async ({ url, widths }) => { if (/ok1/.test(url)) throw new Error('page cassée'); return { shots: widths.map((w) => [w, PNG]), errors: [], warnings: [], blocked: 0, blockedHosts: [] }; };
  const idle = [];
  const q = createCaptureQueue({ capture: (job) => captureTarget({ ...job, chromePath: '/fake/shell', driver }), onIdle: (k, lines) => idle.push(lines) });
  q.enqueue('p/B', ['ok1.html', 'refuse.html', 'ok2.html'].map((target) => ({ target, worktree: wt, name: 'f-' + target })));
  q.enqueue('p/B', []); // nothing: no effect
  while (q.busy('p/B')) await new Promise((r) => setTimeout(r, 10));
  assert.equal(idle.length, 1); const [a, b, c] = idle[0];
  assert.match(a, /^CAPTURE ok1\.html : capture impossible : page cassée$/); assert.match(b, /^CAPTURE refuse\.html : capture refusée : fichier introuvable/); assert.match(c, /^CAPTURE ok2\.html : .*f-ok2\.html/);
  const throwing = createCaptureQueue({ capture: () => { throw new Error('boum'); }, onIdle: (k, lines) => idle.push(lines) });
  throwing.enqueue('x/y', [{ target: 'a.html' }]); while (throwing.busy('x/y')) await new Promise((r) => setTimeout(r, 10));
  assert.match(idle[1][0], /boum/);
});

test('concurrency: 4 by default, set by ESCADRILLE_CAPTURE_CONCURRENCY, 1 is the old one-at-a-time', async () => {
  assert.equal(concurrencyOf({}), 4); assert.equal(concurrencyOf({ ESCADRILLE_CAPTURE_CONCURRENCY: '2' }), 2);
  assert.equal(concurrencyOf({ ESCADRILLE_CAPTURE_CONCURRENCY: '0' }), 4); assert.equal(concurrencyOf({ ESCADRILLE_CAPTURE_CONCURRENCY: 'x' }), 4);
  for (const n of [1, 3]) {
    let active = 0; let max = 0; const order = [];
    const out = await pool([50, 10, 30, 0, 20], n, async (ms, i) => { active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, ms)); active--; if (i === 3) throw new Error('trois'); return i; }, (item, r, i) => order.push(i));
    assert.equal(max, n); assert.deepEqual(order, [0, 1, 2, 3, 4]);
    assert.deepEqual(out.map((r) => (typeof r === 'number' ? r : r.error)), [0, 1, 2, 'capture impossible : trois', 4]);
  }
});

test('a batch: one browser for all its pages, closed once, results in order, a refused target never opens it', async () => {
  for (let i = 0; i < 6; i++) writeFileSync(path.join(wt, `b${i}.html`), '<h1>b</h1>');
  let opened = 0; let closed = 0; let active = 0; let max = 0;
  const openBrowser = () => { opened++; return { shoot: async (url, widths) => { active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, url.endsWith('b0.html') ? 40 : 5)); active--; return { shots: widths.map((w) => [w, PNG]), errors: [url], warnings: [], blocked: 0, blockedHosts: [] }; }, close: async () => { closed++; } }; };
  const jobs = [...Array.from({ length: 6 }, (_, i) => ({ target: `b${i}.html`, worktree: wt, name: `batch-b${i}` })), { target: 'absent.html', worktree: wt }];
  const seen = [];
  const out = await captureBatch(jobs, { chromePath: '/fake/shell', openBrowser, onEach: (job) => seen.push(job.target) });
  assert.equal(opened, 1); assert.equal(closed, 1); assert.equal(max, 4);
  assert.deepEqual(seen, jobs.map((j) => j.target));
  assert.ok(out[0].errors[0].endsWith('b0.html')); assert.match(out[6].error, /fichier introuvable/);
  assert.ok(existsSync(path.join(wt, '.calmdev', 'captures', 'batch-b5', '390.png')));
  const slow = await captureBatch([{ target: 'b1.html', worktree: wt, name: 'slow' }], { chromePath: '/fake/shell', timeoutMs: 50, openBrowser: () => ({ shoot: () => new Promise(() => {}), close: async () => { closed++; } }) });
  assert.match(slow[0].error, /délai de/); assert.equal(closed, 2);
});
