// The live software demo (docs/demo.md) against the server on a spare port, a throwaway repository as the demo's root
// and a fake claude that writes in public/ and outside it: the overlay serves the branch's public/ file, the page
// reloads on the « demo » event, Remove gives back main's page byte for byte, the hour runs out alone, a file outside
// public/ (or public/events.js) is never served and is reported.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, chmodSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classify } from '../lib/demo.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 80)); } };

// The demo's root: a repository whose public/ is the server's own (index.html, events.js), plus a lib/ and a server.mjs
const repo = () => {
  const root = tmp('escadrille-demo-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']);
  mkdirSync(path.join(root, 'public')); mkdirSync(path.join(root, 'lib'));
  for (const f of ['index.html', 'events.js']) copyFileSync(path.join(HERE, '..', 'public', f), path.join(root, 'public', f));
  writeFileSync(path.join(root, 'lib', 'a.mjs'), 'export const a = 1;\n'); writeFileSync(path.join(root, 'server.mjs'), '// server\n');
  sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root;
};

// A fake claude for the demo: at the first message it writes the page, a new stylesheet, then outside public/, then
// public/events.js, and ends its turn; it lives until its stdin closes (as the real one under -p stream-json)
const fakeDemoClaude = () => {
  const dir = tmp('escadrille-fake-'); const file = path.join(dir, 'claude');
  writeFileSync(file, `#!${process.execPath}
const fs = require('node:fs'); const rl = require('node:readline').createInterface({ input: process.stdin });
fs.writeFileSync(${JSON.stringify(path.join(dir, 'args.json'))}, JSON.stringify(process.argv.slice(2)));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 'demo-1' });
rl.on('line', (line) => {
  const m = JSON.parse(line); if (m.type !== 'user') return;
  fs.appendFileSync('public/index.html', '<!-- arc-en-ciel -->\\n');
  fs.writeFileSync('public/rainbow.css', 'button { background: linear-gradient(90deg, red, orange, yellow, green, blue, violet); }\\n');
  fs.writeFileSync('lib/a.mjs', 'export const a = 2;\\n'); fs.writeFileSync('server.mjs', '// hacked\\n');
  fs.writeFileSync('public/events.js', '// broken\\n');
  setTimeout(() => out({ type: 'result', subtype: 'success', is_error: false, result: 'fait', total_cost_usd: 0.01, usage: {}, num_turns: 1 }), 100);
});
rl.on('close', () => process.exit(0));
`);
  chmodSync(file, 0o755); return { file, dir };
};

const servers = [];
after(() => { for (const s of servers) s.kill(); });
const boot = (env = {}) => {
  const PORT = freePort(); const base = `http://127.0.0.1:${PORT}`; const root = repo(); const fake = fakeDemoClaude();
  const S = { base, root, fake, events: [], err: '' };
  const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('escadrille-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-plans-'), ESCADRILLE_TRANSCRIPTS: tmp('escadrille-none-'), ESCADRILLE_SESSIONS: tmp('escadrille-none-'), ESCADRILLE_CLAUDE: fake.file, ESCADRILLE_DEMO_ROOT: root, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => { S.err += d; }); servers.push(server);
  S.ready = until(async () => { try { return (await fetch(base + '/api/demo')).ok; } catch { return false; } });
  // the shared stream of a page (public/events.js), its « demo » events kept
  S.listen = async () => { const r = await fetch(base + '/api/events?all=1'); const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    (async () => { for (;;) { const { value, done } = await rd.read(); if (done) return; buf += dec.decode(value); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const data = /data: (.*)/.exec(chunk)?.[1]; try { const j = JSON.parse(data); if (j.key === 'demo') S.events.push(j); } catch {} } } })().catch(() => {}); };
  S.get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: Buffer.from(await r.arrayBuffer()) }; };
  S.post = async (p, b = {}) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, json: await r.json() }; };
  S.demo = async () => (await fetch(base + '/api/demo')).json();
  S.branches = () => sh(root, ['branch', '--list', '--format=%(refname:short)', 'calmdev/demo/*', 'escadrille/demo/*']);
  return S;
};

test('classify: public/ served, the rest refused, events.js never taken', () => {
  const wt = tmp('escadrille-cls-'); mkdirSync(path.join(wt, 'public')); mkdirSync(path.join(wt, 'lib'));
  for (const f of ['public/a.css', 'public/events.js', 'lib/x.mjs']) writeFileSync(path.join(wt, f), 'x');
  assert.deepEqual(classify(wt, ['public/a.css', 'lib/x.mjs', 'public/events.js', 'public/gone.html']), { files: ['public/a.css'], refused: ['lib/x.mjs', 'public/events.js'] });
});

test('a demo changes the served page live, refuses what is outside public/, Remove gives main back byte for byte', async () => {
  const S = boot(); await S.ready; await S.listen();
  sh(S.root, ['branch', 'escadrille/demo/20261101t000000z']); // the remains of a demo of before the rename: swept at the start
  const before = await S.get('/'); const beforeJs = await S.get('/events.js');
  assert.equal(before.status, 200);
  assert.deepEqual(await S.demo(), { on: false });
  assert.equal((await S.post('/api/demo', {})).status, 400);
  const r = await S.post('/api/demo', { prompt: 'mets tous les boutons en arc-en-ciel' });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.status, 'preparing'); assert.match(r.json.id, /^\d{8}t\d{6}z$/);
  assert.equal((await S.post('/api/demo', { prompt: 'un autre' })).status, 409, 'one demo at a time');
  const live = await until(async () => { const d = await S.demo(); return d.status === 'live' && d.files.includes('rainbow.css') && d.refused.length >= 3 ? d : null; });
  assert.equal(live.prompt, 'mets tous les boutons en arc-en-ciel'); assert.equal(live.model, 'claude-sonnet-5-5');
  assert.deepEqual(live.files, ['index.html', 'rainbow.css']);
  assert.deepEqual(live.refused, ['lib/a.mjs', 'public/events.js', 'server.mjs']);
  assert.equal(S.branches(), 'calmdev/demo/' + r.json.id, 'the old demo branch is gone, the new one is calmdev/…');
  // the session: tools of files only, no Bash, the instruction to touch public/ only
  const args = JSON.parse(readFileSync(path.join(S.fake.dir, 'args.json'), 'utf8'));
  const at = args.indexOf('--allowedTools') + 1; assert.deepEqual(args.slice(at, args.findIndex((a, i) => i >= at && a.startsWith('--'))), ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit']); assert.match(args[args.indexOf('--append-system-prompt') + 1], /public\//);
  // the overlay: the branch's page, its new file; never events.js, never lib/ or server.mjs
  const during = await S.get('/'); assert.match(during.body.toString(), /arc-en-ciel/);
  assert.match((await S.get('/rainbow.css')).body.toString(), /linear-gradient/);
  assert.ok((await S.get('/events.js')).body.equals(beforeJs.body));
  assert.equal((await S.get('/lib/a.mjs')).status, 404); assert.equal((await S.get('/server.mjs')).status, 404);
  await until(() => S.events.length > 0); // the page was told to reload
  // Remove: main's page again, byte for byte; the worktree and the branch gone
  const n = S.events.length;
  const rm = await S.post('/api/demo/remove'); assert.equal(rm.json.removed, true);
  assert.ok((await S.get('/')).body.equals(before.body), 'the page is back, byte for byte');
  assert.equal((await S.get('/rainbow.css')).status, 404);
  assert.deepEqual(await S.demo(), { on: false });
  await until(() => S.events.length > n);
  assert.equal(S.branches(), ''); assert.ok(!existsSync(path.join(S.root, '.claude', 'worktrees', 'demo-' + r.json.id)));
  assert.equal(sh(S.root, ['status', '--porcelain']), '', 'main untouched');
  assert.equal(sh(S.root, ['log', '--oneline']).split('\n').length, 1, 'nothing merged');
  assert.doesNotMatch(JSON.stringify(await (await fetch(S.base + '/api/plans')).json()), /demo/, 'no plan');
});

test('the demo removes itself when its time is out', async () => {
  // the time counts from the request (lib/demo.mjs startedAt): under the load of the whole suite, worktree + fake claude
  // took more than 2.5 s and the demo ended before it was ever live (2026-11-06); 8 s leaves room
  const S = boot({ ESCADRILLE_DEMO_TTL_MS: '8000' }); await S.ready;
  const before = await S.get('/');
  const r = await S.post('/api/demo', { prompt: 'ajoute un compteur de cafés sur l’accueil', model: 'haiku' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const d = await until(async () => { const x = await S.demo(); return x.status === 'live' ? x : null; });
  assert.equal(Date.parse(d.endsAt) - Date.parse(d.startedAt), 8000); assert.match(d.model, /haiku/);
  await until(async () => !(await S.demo()).on, 20000);
  assert.ok((await S.get('/')).body.equals(before.body));
  await until(() => S.branches() === '', 5000);
});
