// The local rule's proposal reaches pending (docs/policy.md): a server on a spare port, the fake claude asking
// three commands, one the rule allows, one it refuses, one it has nothing to say about; nothing is answered for us.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeClaude } from './fake-claude.mjs';
import { fakeNpm } from './fake-npm.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const until = async (fn, ms = 40000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };

const root = tmp('escadrille-policy-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']);
writeFileSync(path.join(root, 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']);
const TURNS = [
  { command: 'curl -s localhost:3094/api/plans -o out.json', rule: 'curl:*', stops: [0], claude: 'un' },
  { command: 'curl -s https://example.com/x', rule: 'curl:*', stops: [0], claude: 'deux' },
  { command: 'rm -f out.json', rule: 'rm:*', stops: [0, 1], claude: 'trois', done: true },
];
const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const fake = fakeClaude();
const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('escadrille-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-plans-'), ESCADRILLE_TRANSCRIPTS: mkdtempSync(path.join(tmpdir(), 'escadrille-none-')), ESCADRILLE_SESSIONS: mkdtempSync(path.join(tmpdir(), 'escadrille-none-')), ESCADRILLE_CLAUDE: fake.file, ESCADRILLE_NPM: fakeNpm(), FAKE_CLAUDE_TURNS: JSON.stringify(TURNS) }, stdio: ['ignore', 'pipe', 'pipe'] });
let err = ''; server.stderr.on('data', (d) => { err += d; }); server.stdout.on('data', (d) => { err += d; });
after(() => server.kill('SIGINT'));
const get = async (p) => (await fetch(BASE + p)).json();
const post = async (p, body) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
const session = async () => (await get('/api/plan/regle')).state.find((s) => s.id === 'A');
const nextAsk = () => until(async () => (await session()).pending.find((p) => p.kind === 'permission') || null).catch(async (e) => { throw new Error(`no permission came: ${JSON.stringify(await session())}\n${err.slice(-1500)}`); });
const waiting = () => until(async () => { const s = await session(); return s.status === 'waiting' || s.status === 'done' ? s : null; });

test('pending carries the rule’s proposal, and the request still waits for the developer', async () => {
  await until(async () => { try { await get('/api/plans'); return true; } catch { return false; } });
  assert.equal((await post('/api/plan', { id: 'regle', title: 'Règle', sessions: [{ id: 'A', name: 'Une', path: root, model: 'claude-sonnet-5-5', stops: ['Un', 'Deux'], prompt: 'Essaie.' }] })).status, 200);
  assert.deepEqual((await post('/api/launch', { plan: 'regle' })).body, { ok: true, launched: ['A'], queued: [] });

  let a = await nextAsk();
  assert.deepEqual(a.suggest, { allow: true, reason: 'Vers la machine locale : localhost:3094', rule: 'local-host' });
  assert.equal(a.network, false, 'a curl aimed only at loopback is not network, even with -o out.json');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok((await session()).pending.some((p) => p.id === a.id), 'nobody answers on the developer’s behalf');
  assert.deepEqual((await post('/api/plan/regle/session/A/answer', { id: a.id, allow: true })).body, { ok: true });
  await waiting();

  await post('/api/plan/regle/session/A/message', { text: 'Encore' });
  a = await nextAsk();
  assert.deepEqual(a.suggest, { allow: false, reason: 'Hôte hors du plan : example.com', rule: 'real-host' });
  assert.deepEqual((await post('/api/plan/regle/session/A/answer', { id: a.id, allow: false })).body, { ok: true });
  await waiting();

  await post('/api/plan/regle/session/A/message', { text: 'Fin' });
  a = await nextAsk();
  assert.equal(a.suggest, null, 'rm: the rule has nothing to say');
  await post('/api/plan/regle/session/A/answer', { id: a.id, allow: true });
});
