// The pause at the hard threshold (phase 10 P, lib/limits.mjs « La pause »), on a simulated stream: a fake claude whose
// rate_limit_event says 30 % of the weekly quota (hard threshold 25 %) while its turn is still running, then 10 %.
//  1. the reset in 15 s: the session turns « paused » with the limit and the hour, a session launched meanwhile waits in
//     the queue; at the reset the paused one resumes alone with --resume and the short message, the queued one starts;
//  2. the threshold raised in Access: the same reading is under the soft threshold, the session resumes;
//  3. a restart of the server keeps the pause; « Tout reprendre » forces the resume.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fakeClaude } from './fake-claude.mjs';
import { freePort } from './free-port.mjs';
import { isolatedEnv } from './isolated-env.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const repo = () => { const root = tmp('escadrille-pause-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); mkdirSync(path.join(root, 'app')); writeFileSync(path.join(root, 'app', 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root; };
const until = async (fn, ms = 60000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAUSE_TEXT = 'Pause levée, reprends là où tu en étais.';
// The first turn holds 5 s: the server must read its rate_limit_event while the turn still runs (pause.was 'running',
// the resume sends PAUSE_TEXT). At 1.5 s a loaded machine read it after the turn's end and every wait ran out (TB).
const TURNS = JSON.stringify([{ hold: 5000, stops: [0], claude: 'Tour 1' }, { hold: 300, stops: [0], claude: 'Tour 2' }, { hold: 300, stops: [0], claude: 'Tour 3' }]);

const servers = [];
after(() => { for (const s of servers) s.kill('SIGINT'); });
const start = ({ fake, db, plans, env = {} }) => {
  const port = freePort(); const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: isolatedEnv({ PORT: String(port), ESCADRILLE_DB: db, ESCADRILLE_PLANS: plans, ESCADRILLE_CLAUDE: fake.file, FAKE_CLAUDE_TURNS: TURNS, FAKE_CLAUDE_WEEKLY: '0.30,0.10', ESCADRILLE_PAUSE_TICK_MS: '200', ESCADRILLE_BURST_TICK_MS: '200', ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; proc.stderr.on('data', (d) => { err += d; }); servers.push(proc);
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': 'fr' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  const row = async (plan, id) => (await get(`/api/plan/${plan}`)).state.find((s) => s.id === id);
  const messages = async (plan, id) => (await get(`/api/plan/${plan}/session/${id}/messages`)).messages;
  const ready = () => until(async () => { try { return (await fetch(base + '/api/plans')).status === 200; } catch { return false; } }, 90000); // a loaded machine starts a server slowly
  const stop = () => new Promise((r) => { proc.once('exit', r); proc.kill('SIGINT'); });
  return { get, post, row, messages, ready, stop, err: () => err };
};
const prompts = (fake) => { try { return readFileSync(path.join(fake.dir, 'prompts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
const launches = (fake) => readFileSync(path.join(fake.dir, 'args.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const session = (root, id) => ({ id, name: id, path: root, model: 'claude-sonnet-5-5', stops: ['La fin'], prompt: 'Travaille.', budget: 5 });
const setup = async (s, root, plan) => {
  await s.ready();
  assert.equal((await s.post('/api/limits', { scope: 'mac', limits: { weekly: { soft: 20, hard: 25 } } })).status, 200);
  assert.equal((await s.post('/api/plan', { id: plan, title: plan, sessions: [session(root, 'A')] })).status, 200);
  assert.deepEqual((await s.post('/api/launch', { plan })).body, { ok: true, launched: ['A'], queued: [] });
  return until(async () => { const r = await s.row(plan, 'A'); return r.status === 'paused' ? r : null; });
};

test('at the hard threshold the session pauses, the next one queues, and both go at the reset', async () => {
  const fake = fakeClaude(); const root = repo();
  const s = start({ fake, db: path.join(tmp('escadrille-pause-db-'), 'db.sqlite'), plans: tmp('escadrille-pause-plans-'), env: { FAKE_CLAUDE_RESET_S: '15' } }); // long enough that a loaded machine sees the pause and queues B before the reset
  const t0 = Date.now();
  const a = await setup(s, root, 'p-reset');
  const t1 = Date.now();
  // paused, not stopped nor in error: the limit and the hour of its reset
  assert.equal(a.health, 'ok'); assert.equal(a.mode, null);
  assert.equal(a.pause.limit, 'weekly'); assert.equal(a.pause.was, 'running');
  // the reset the stream said: 15 s after the fake's event, which came between t0 and t1 (resetsAt is in whole seconds)
  assert.ok(Date.parse(a.pause.until) >= t0 + 15000 - 1000 && Date.parse(a.pause.until) <= t1 + 15000, a.pause.until);
  assert.match(a.claude, /En pause jusqu’à \d\d:\d\d : Quota hebdo à 30 %, seuil dur 25 %/);
  assert.ok((await s.messages('p-reset', 'A')).some((m) => m.role === 'system' && /^En pause : Quota hebdo à 30 %, seuil dur 25 %\. Reprise seule à/.test(m.text)));
  const sid = a.sessionId;
  // the Flow says it: how many, which limit, until when
  const flow = await s.get('/api/projectflow?project=' + encodeURIComponent(root));
  assert.equal(flow.pause.n, 1); assert.equal(flow.pause.limit, 'weekly'); assert.equal(flow.pause.until, a.pause.until); assert.equal(flow.pause.name, 'Quota hebdo');
  assert.equal(flow.nodes.find((n) => n.session === 'A').status, 'paused');
  // a session launched now waits in the queue
  assert.equal((await s.post('/api/plan', { id: 'p-next', title: 'Next', sessions: [session(root, 'B')] })).status, 200);
  assert.deepEqual((await s.post('/api/launch', { plan: 'p-next' })).body, { ok: true, launched: [], queued: ['B'] });
  assert.equal((await s.row('p-reset', 'A')).status, 'paused', 'before the reset nothing resumes');
  // the reset: A resumes alone with --resume on its own Claude session and the short message; B starts
  const back = await until(async () => { const r = await s.row('p-reset', 'A'); return r.status !== 'paused' ? r : null; });
  assert.ok(Date.now() >= Date.parse(a.pause.until) - 1000, 'not before the reset');
  assert.ok(['running', 'waiting'].includes(back.status)); assert.equal(back.pause, null);
  await until(() => prompts(fake).some((p) => p.session_id === sid && p.text === PAUSE_TEXT));
  assert.ok(launches(fake).some((args) => args.includes('--resume') && args[args.indexOf('--resume') + 1] === sid), 'resumed with --resume');
  assert.ok((await s.messages('p-reset', 'A')).some((m) => m.role === 'system' && m.text === 'Pause levée : reprise là où elle en était.'));
  await until(async () => ['running', 'waiting'].includes((await s.row('p-next', 'B')).status));
  // the resumed turn (10 %) ends normally
  await until(async () => { const r = await s.row('p-reset', 'A'); return r.status === 'waiting' && r.claude === 'Tour 1' ? r : null; });
  assert.equal((await s.get('/api/projectflow?project=' + encodeURIComponent(root))).pause, null);
  assert.equal(s.err().includes('limits Error'), false, s.err());
});

test('a threshold raised in Access lifts the pause at once', async () => {
  const fake = fakeClaude(); const root = repo();
  const s = start({ fake, db: path.join(tmp('escadrille-pause-db-'), 'db.sqlite'), plans: tmp('escadrille-pause-plans-') });
  const a = await setup(s, root, 'p-raise');
  assert.ok(Date.parse(a.pause.until) - Date.now() > 2 * 864e5, 'the reset is days away');
  await sleep(600); assert.equal((await s.row('p-raise', 'A')).status, 'paused');
  assert.equal((await s.post('/api/limits', { scope: 'mac', limits: { weekly: { soft: 40, hard: 50 } } })).status, 200);
  await until(() => prompts(fake).some((p) => p.session_id === a.sessionId && p.text === PAUSE_TEXT));
  assert.notEqual((await s.row('p-raise', 'A')).status, 'paused');
});

test('a pause survives a restart of the server; « Tout reprendre » forces the resume of the limit pauses only', async () => {
  const fake = fakeClaude(); const root = repo();
  const opts = { fake, db: path.join(tmp('escadrille-pause-db-'), 'db.sqlite'), plans: tmp('escadrille-pause-plans-') };
  let s = start(opts);
  await s.ready();
  assert.equal((await s.post('/api/limits', { scope: 'mac', limits: { weekly: { soft: 20, hard: 25 } } })).status, 200);
  assert.equal((await s.post('/api/plan', { id: 'p-restart', title: 'p-restart', sessions: [session(root, 'A'), session(root, 'Q')] })).status, 200);
  assert.deepEqual((await s.post('/api/launch', { plan: 'p-restart', session: 'A' })).body, { ok: true, launched: ['A'], queued: [] });
  const a = await until(async () => { const r = await s.row('p-restart', 'A'); return r.status === 'paused' ? r : null; });
  await s.stop();
  // Q « paused » without the pause of a limit (2026-11-05: « Tout reprendre » relaunched a closed QA and a later lot)
  const q = { sessionId: 'q-session' };
  { const d = new DatabaseSync(opts.db); d.prepare("update sessions set status = 'paused', pause = null, session_id = ? where plan = 'p-restart' and id = 'Q'").run(q.sessionId); d.close(); }
  s = start(opts); await s.ready(); await sleep(800); // several ticks
  const r = await s.row('p-restart', 'A');
  assert.equal(r.status, 'paused'); assert.deepEqual(r.pause, a.pause);
  assert.equal(prompts(fake).filter((p) => p.text === PAUSE_TEXT).length, 0, 'not resumed by the restart');
  const pz = (await s.get('/api/projectflow?project=' + encodeURIComponent(root))).pause;
  assert.equal(pz.n, 1); assert.deepEqual(pz.sessions, [{ plan: 'p-restart', id: 'A', name: 'A' }], 'the button names what it resumes');
  // « Tout reprendre »: the hard threshold is still crossed, the developer decides; Q is not a limit's pause
  const f = await s.post('/api/limits/resume', { project: root });
  assert.equal(f.status, 200); assert.deepEqual(f.body, { ok: true, resumed: 1, sessions: [{ plan: 'p-restart', id: 'A', name: 'A' }] });
  await until(() => prompts(fake).some((p) => p.session_id === a.sessionId && p.text === PAUSE_TEXT));
  await sleep(600);
  assert.equal(prompts(fake).some((p) => p.session_id === q.sessionId && p.text === PAUSE_TEXT), false, 'Q not relaunched');
  assert.equal((await s.row('p-restart', 'Q')).status, 'paused', 'Q stays as it was');
  assert.ok((await s.messages('p-restart', 'A')).some((m) => m.role === 'system' && /Tout reprendre/.test(m.text)));
  await sleep(600); assert.notEqual((await s.row('p-restart', 'A')).status, 'paused', 'forced: the same limit does not pause it again');
});
