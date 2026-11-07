// A model's weekly limit acts on that model only (2026-11-02 13:16, backlog l. 69): Fable's hard threshold cut an Opus
// planning after 6 s and « Tout reprendre » was needed. Fable above its hard threshold pauses the Fable session; the
// Opus session and the Opus planner keep running.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, realpathSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeClaude } from './fake-claude.mjs';
import { freePort } from './free-port.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const repo = () => { const root = tmp('escadrille-limmod-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); mkdirSync(path.join(root, 'app')); writeFileSync(path.join(root, 'app', 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root; };
const until = async (fn, ms = 10000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };

const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const fake = fakeClaude();
const fableFile = path.join(fake.dir, 'fable'); writeFileSync(fableFile, '0.5');
const turns = Array.from({ length: 6 }, (_, i) => ({ stops: [0], claude: 'Tour ' + (i + 1) }));
const none = tmp('escadrille-limmod-none-');
const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('escadrille-limmod-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-limmod-plans-'), ESCADRILLE_TRANSCRIPTS: none, ESCADRILLE_SESSIONS: none, ESCADRILLE_CLAUDE: fake.file, FAKE_CLAUDE_TURNS: JSON.stringify(turns), FAKE_CLAUDE_FABLE_FILE: fableFile, ESCADRILLE_PAUSE_TICK_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'] });
after(() => server.kill('SIGINT'));
const get = async (p) => (await fetch(BASE + p)).json();
const post = async (p, body) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': 'fr' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
const stateOf = async (plan, id) => (await get(`/api/plan/${plan}`)).state.find((s) => s.id === id);

test('Fable above its hard threshold pauses the Fable session only; Opus sessions and planners keep going', async () => {
  await until(async () => { try { return (await fetch(BASE + '/api/plans')).status === 200; } catch { return false; } });
  const root = repo();
  // the Mac's settings of 2 November (docs/decisions.md)
  assert.equal((await post('/api/limits', { scope: 'mac', limits: { weekly: { soft: 100, hard: 100 }, model: { soft: 94, hard: 97 } } })).status, 200);
  const session = (id, model) => ({ id, name: id, path: root, model, stops: ['La fin'], prompt: 'Travaille.', budget: 5 });
  assert.equal((await post('/api/plan', { id: 'mod-un', title: 'Un', sessions: [session('F', 'claude-fable-5-1'), session('O', 'claude-opus-5-5')] })).status, 200);
  assert.deepEqual((await post('/api/launch', { plan: 'mod-un' })).body, { ok: true, launched: ['F', 'O'], queued: [] });
  await until(async () => (await stateOf('mod-un', 'F'))?.status === 'waiting' && (await stateOf('mod-un', 'O'))?.status === 'waiting');
  const e = await post('/api/escadrille', { project: root, idea: 'La suite', model: 'claude-opus-5-5' });
  assert.equal(e.status, 200);
  await until(() => { try { return readFileSync(path.join(fake.dir, 'args.jsonl'), 'utf8').includes('--append-system-prompt'); } catch { return false; } });
  // Fable crosses its hard threshold on the Fable session's next turn
  writeFileSync(fableFile, '0.98');
  await post('/api/plan/mod-un/session/F/message', { text: 'Continue.' });
  const f = await until(async () => { const s = await stateOf('mod-un', 'F'); return s.status === 'paused' ? s : null; });
  assert.equal(f.pause.limit, 'model:fable');
  await new Promise((r) => setTimeout(r, 600)); // a few ticks: nothing else may follow
  const o = await stateOf('mod-un', 'O');
  assert.notEqual(o.status, 'paused', 'the Opus session must not pause on Fable\'s limit');
  assert.equal(o.health === 'error' && /Fable/.test(o.why || ''), false, 'nor stop');
  const esc = (await get('/api/escadrilles?project=' + encodeURIComponent(root))).find((x) => x.id === e.body.id);
  assert.notEqual(esc.status, 'stopped', 'the Opus planner must not stop on Fable\'s limit');
});
