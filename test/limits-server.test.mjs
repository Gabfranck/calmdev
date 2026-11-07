// The thresholds held by the server (docs/limits.md): a fake claude whose rate_limit_event rises turn after turn.
// The Mac's thresholds set as Dev did by hand on 1 November (soft 20 %, hard 25 % of the weekly quota): at 22 % a new
// session waits in the queue with the line of the limit, at 30 % the running one pauses and says which limit did it;
// the status panel shows the rows, and the planner's prompt carries the margins.
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
const repo = () => { const root = tmp('escadrille-lim-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); mkdirSync(path.join(root, 'app')); writeFileSync(path.join(root, 'app', 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root; };
const until = async (fn, ms = 10000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };

const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const fake = fakeClaude();
const turns = [{ stops: [0], claude: 'Tour 1' }, { stops: [0], claude: 'Tour 2' }, { stops: [0], claude: 'Tour 3' }];
const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('escadrille-lim-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-lim-plans-'), ESCADRILLE_TRANSCRIPTS: tmp('escadrille-lim-none-'), ESCADRILLE_SESSIONS: tmp('escadrille-lim-none-'), ESCADRILLE_CLAUDE: fake.file, FAKE_CLAUDE_TURNS: JSON.stringify(turns), FAKE_CLAUDE_WEEKLY: '0.22,0.30', ESCADRILLE_BURST_TICK_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'] });
let err = ''; server.stderr.on('data', (d) => { err += d; });
after(() => server.kill('SIGINT'));
const get = async (p) => (await fetch(BASE + p)).json();
const post = async (p, body) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': 'fr' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
const stateOf = async (plan, id) => (await get(`/api/plan/${plan}`)).state.find((s) => s.id === id);

test('the Mac thresholds: saved, validated, a project only stricter', async () => {
  await until(async () => { try { return (await fetch(BASE + '/api/plans')).status === 200; } catch { return false; } });
  const root = repo();
  let r = await post('/api/limits', { scope: 'mac', limits: { weekly: { soft: 20, hard: 25 } } });
  assert.equal(r.status, 200); assert.deepEqual(r.body.mac, { weekly: { soft: 20, hard: 25 } });
  assert.equal((await post('/api/limits', { scope: 'mac', limits: { weekly: { soft: 30, hard: 25 } } })).status, 400);
  r = await post('/api/limits', { scope: 'project', project: root, limits: { weekly: { soft: 50, hard: 60 }, fiveHour: { soft: 70, hard: 80 } } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.effective.weekly, { soft: 20, hard: 25 }, 'the project cannot loosen the Mac');
  assert.deepEqual(r.body.effective.fiveHour, { soft: 70, hard: 80 });
  const g = await get('/api/limits?project=' + encodeURIComponent(root));
  assert.deepEqual(g.defaults.weekly, { soft: 80, hard: 95 });
  assert.deepEqual(g.rows.map((x) => [x.id, x.pct]).slice(0, 3), [['fiveHour', null], ['weekly', null], ['model:fable', null]], 'nothing measured: said, no figure');
});

test('a rising stream: above the soft threshold nothing new starts, above the hard one the session pauses and says why', async () => {
  const root = repo();
  const session = (id) => ({ id, name: id, path: root, model: 'claude-sonnet-5-5', stops: ['La fin'], prompt: 'Travaille.', budget: 5 });
  assert.equal((await post('/api/plan', { id: 'lim-un', title: 'Un', sessions: [session('A')] })).status, 200);
  assert.deepEqual((await post('/api/launch', { plan: 'lim-un' })).body, { ok: true, launched: ['A'], queued: [] });
  await until(async () => (await stateOf('lim-un', 'A'))?.status === 'waiting'); // turn 1 said 22 %
  const st = await until(async () => { const s = await get('/api/status?project=' + encodeURIComponent(root)); return s.limits.verdict.level === 'soft' ? s : null; });
  assert.equal(st.limits.rows[0].id, 'weekly'); assert.equal(st.limits.rows[0].pct, 22); assert.equal(st.limits.rows[0].lead, true);
  assert.match(st.limits.verdict.line, /Quota hebdo à 22 %, seuil doux 20 %/);
  // soft: a new plan's session waits, the line of the limit on it
  assert.equal((await post('/api/plan', { id: 'lim-deux', title: 'Deux', sessions: [session('B')] })).status, 200);
  assert.deepEqual((await post('/api/launch', { plan: 'lim-deux' })).body, { ok: true, launched: [], queued: ['B'] });
  assert.match((await stateOf('lim-deux', 'B')).claude, /seuil doux 20 %/);
  // the planner reads the margins
  const e = await post('/api/escadrille', { project: root, idea: 'La suite' });
  assert.equal(e.status, 200);
  const args = await until(() => { try { return readFileSync(path.join(fake.dir, 'args.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.includes('--append-system-prompt')) || null; } catch { return null; } });
  const sys = args[args.indexOf('--append-system-prompt') + 1];
  assert.match(sys, /## Les marges/); assert.match(sys, /Quota hebdo : 22 % utilisés, seuil doux 20 % → franchi/);
  // hard: the next turn says 30 %, everything launched for the project stops, the line says which limit
  await post('/api/plan/lim-un/session/A/message', { text: 'Continue.' });
  // (phase 10 P) a window that resets pauses the session instead of stopping it: test/pause.test.mjs
  const a = await until(async () => { const s = await stateOf('lim-un', 'A'); return s.status === 'paused' ? s : null; });
  assert.equal(a.pause.limit, 'weekly'); assert.match(a.claude, /seuil dur 25 %/);
  const msgs = await get('/api/plan/lim-un/session/A/messages');
  assert.ok(msgs.messages.some((m) => m.role === 'system' && /En pause : Quota hebdo à 30 %, seuil dur 25 %/.test(m.text)));
  // the burst: none starts above a threshold, the line says which
  mkdirSync(path.join(root, 'docs'), { recursive: true }); writeFileSync(path.join(root, 'docs', 'backlog.md'), '# Backlog\n\n- [ ] Une tâche\n');
  const b = await post('/api/burst', { project: root, capUsd: 5 });
  assert.equal(b.status, 400); assert.match(b.body.error, /seuil dur 25 %/);
  assert.equal(err.includes('limits Error'), false, err);
});
