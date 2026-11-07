// The robustness of phase 7 (docs/sessions.md, « La robustesse (phase 7) »), against the fake claude on a spare
// port with a throwaway database: the rest of the cap given to --max-budget-usd, the cap raised that restarts a
// capped process, the project's queue at N=1, and the interrupted turn that resumes on its own after a restart.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeClaude } from './fake-claude.mjs';
import { remaining, queueRule, isFinished, createQueue, planChangeRefusals, holdsSlot } from '../lib/queue.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const NODE = process.execPath;
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const repo = () => { const root = tmp('escadrille-rob-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); writeFileSync(path.join(root, 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root; };
const until = async (fn, ms = 40000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 120)); await new Promise((r) => setTimeout(r, 150)); } };
const servers = [];
after(() => { for (const s of servers) s.kill('SIGKILL'); });

// One server, its usage estimate reading empty transcript folders (fast, and nothing of the Mac); `same` reuses the database, the plans folder and the fake claude of a previous one
const boot = (env = {}, same = null) => {
  const PORT = freePort(); const base = `http://127.0.0.1:${PORT}`;
  const S = same ? { ...same } : { fake: fakeClaude(), plans: tmp('escadrille-plans-'), db: path.join(tmp('escadrille-db-'), 'db.sqlite'), empty: tmp('escadrille-none-') };
  S.base = base;
  S.proc = spawn(NODE, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: S.db, ESCADRILLE_PLANS: S.plans, ESCADRILLE_CLAUDE: S.fake.file, ESCADRILLE_TRANSCRIPTS: S.empty, ESCADRILLE_SESSIONS: S.empty, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(S.proc); S.err = ''; S.proc.stderr.on('data', (d) => { S.err += d; });
  S.get = async (p) => (await fetch(base + p)).json();
  S.post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  S.ready = () => until(async () => { try { await S.get('/api/plans'); return true; } catch { return false; } });
  S.session = async (plan, id) => (await S.get(`/api/plan/${plan}`)).state.find((s) => s.id === id);
  S.args = () => JSON.parse(readFileSync(path.join(S.fake.dir, 'args.json'), 'utf8'));
  S.prompts = () => { try { return readFileSync(path.join(S.fake.dir, 'prompts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
  S.launches = () => { try { return Number(readFileSync(path.join(S.fake.dir, 'launches'), 'utf8')); } catch { return 0; } };
  S.stop = () => new Promise((resolve) => { S.proc.on('exit', resolve); S.proc.kill('SIGINT'); });
  return S;
};
const cap = (args) => args[args.indexOf('--max-budget-usd') + 1];

test('the rules of lib/queue.mjs: the rest, the queue, a finished plan, canStart and its guards', () => {
  assert.equal(remaining(5, 0), 5); assert.equal(remaining(5, 1.234), 3.77); assert.equal(remaining(5, 4.9), 0.5); assert.equal(remaining(5, 7), 0.5);
  assert.equal(remaining(0.06, 0.06), 0.06, 'the floor never goes above a smaller cap');
  assert.deepEqual(queueRule({ parallel: null, active: 9 }), { ok: true, why: '' });
  assert.deepEqual(queueRule({ parallel: 2, active: 1 }), { ok: true, why: '' });
  assert.deepEqual(queueRule({ parallel: 1, active: 1 }), { ok: false, why: 'En file : 1 session tourne déjà' });
  assert.deepEqual(queueRule({ parallel: 2, active: 3 }), { ok: false, why: 'En file : 3 sessions tournent déjà' });
  const plan = { sessions: [{ id: 'A' }, { id: 'B' }] };
  assert.equal(isFinished(plan, [{ id: 'A', status: 'done', worktree: { merged: true } }, { id: 'B', status: 'done', worktree: null }]), true);
  assert.equal(isFinished(plan, [{ id: 'A', status: 'done', worktree: { merged: false } }, { id: 'B', status: 'done' }]), false);
  let active = 0; const q = createQueue({ countActive: () => active, parallelOf: () => 1 });
  assert.equal(q.canStart(plan, plan.sessions[0]).ok, true);
  q.addGuard((p, s) => (s.id === 'B' ? { ok: false, why: 'à relire' } : null));
  assert.deepEqual(q.canStart(plan, plan.sessions[1]), { ok: false, why: 'à relire' });
  const old = { sessions: [{ id: 'A', prompt: 'a' }, { id: 'B', prompt: 'b' }] };
  assert.deepEqual(planChangeRefusals(old, [{ id: 'A', status: 'done' }, { id: 'B', status: 'later' }], { sessions: [{ id: 'A', prompt: 'a' }, { id: 'C' }] }), [], 'B later may go, C may come');
  assert.deepEqual(planChangeRefusals(old, [{ id: 'A', status: 'waiting' }], { sessions: [{ id: 'B' }] }), ['A est lancée (waiting) : elle ne peut pas disparaître du plan']);
  assert.deepEqual(planChangeRefusals(null, [], { sessions: [] }), [], 'a new plan');
  // key order, the state instruction, stopMeta and a stop sent back as its title are no change; a real change is named
  const st = { id: 'A', name: 'a', prompt: 'p', stops: [{ title: 'T', kind: 'review' }], budget: 2 };
  const back = { stopMeta: [{ kind: 'review' }], budget: 2, stops: ['T'], prompt: 'p\n\n## Suivi, obligatoire à la fin de chaque tour\n\nx', name: 'a', id: 'A' };
  assert.deepEqual(planChangeRefusals({ sessions: [st] }, [{ id: 'A', status: 'done' }], { sessions: [back] }), []);
  assert.deepEqual(planChangeRefusals({ sessions: [st] }, [{ id: 'A', status: 'done' }], { sessions: [{ ...back, budget: 3, stops: ['U'] }] }), ['A est lancée (done) : elle ne peut plus changer (budget, stops)']);
  active = 1; assert.deepEqual(q.canStart(plan, plan.sessions[0]), { ok: false, why: 'En file : 1 session tourne déjà' }, 'the queue comes first');
});

test('FRU (MUET): a merged session frees its place in parallel even while its process lives', () => {
  assert.equal(holdsSlot({ status: 'waiting', worktree: { branch: 'b' } }, true), true, 'live, not merged: holds');
  assert.equal(holdsSlot({ status: 'waiting', worktree: { branch: 'b', merged: true } }, true), false, 'merged: frees its place');
  assert.equal(holdsSlot({ status: 'running', worktree: null }, true), true, 'no worktree, live: holds');
  assert.equal(holdsSlot({ status: 'waiting', worktree: { branch: 'b' } }, false), false, 'no process: never holds');
  // the queue at parallel 1, counted the way server.mjs counts: the merged one no longer blocks the next
  const rows = [{ id: 'A', live: true, worktree: { merged: true } }, { id: 'B', live: true, worktree: { merged: false } }];
  const q = createQueue({ parallelOf: () => 2, countActive: () => rows.filter((r) => holdsSlot(r, r.live)).length });
  assert.equal(q.canStart({}, {}).ok, true, 'A merged: one place of two taken');
});

test('the rest of the cap goes to --max-budget-usd; a raise restarts a capped process with the rest', async () => {
  const S = boot({ FAKE_CLAUDE_CONTEXT_WINDOW: '1000000' }); await S.ready();
  const root = repo();
  const plan = { id: 'budget', title: 'Budget', sessions: [
    { id: 'R', name: 'Reste', path: root, model: 'claude-sonnet-5-5', stops: ['La fin'], prompt: 'Travaille.', budget: 0.6 },
    { id: 'P', name: 'Plafond', path: root, model: 'claude-sonnet-5-5', stops: ['La fin'], prompt: 'Travaille.', budget: 0.02 }] };
  assert.equal((await S.post('/api/plan', plan)).status, 200);
  const waiting = (id) => until(async () => { const s = await S.session('budget', id); return s.status === 'waiting' ? s : null; });

  // R: the first start gets the whole cap; stopped after a turn (0,01 $), a message restarts it with the rest
  await S.post('/api/launch', { plan: 'budget', session: 'R' });
  await waiting('R'); assert.equal(cap(S.args()), '0.6');
  assert.deepEqual((await S.post('/api/plan/budget/session/R/stop')).body, { ok: true });
  const n = S.launches();
  await S.post('/api/plan/budget/session/R/message', { text: 'Encore' });
  await until(() => S.launches() > n); await waiting('R');
  assert.equal(cap(S.args()), '0.6', 'the rest (0,60 $ minus the 0,01 $ spent) plus that 0,01 $, which Claude Code restores under --resume');
  assert.equal(S.args()[S.args().indexOf('--resume') + 1], 'sess-9');
  await S.post('/api/plan/budget/session/R/stop');

  // P: two turns reach its 0,02 $ cap, the server stops the process
  await S.post('/api/launch', { plan: 'budget', session: 'P' });
  await waiting('P'); await S.post('/api/plan/budget/session/P/message', { text: 'Encore' });
  let P = await until(async () => { const s = await S.session('budget', 'P'); return s.status === 'waiting' && s.usage.cost >= 0.02 ? s : null; });
  assert.equal(P.mode, null, 'capped: no process');
  assert.equal((await S.post('/api/plan/budget/session/P/budget', { budget: 0 })).status, 400);
  assert.equal((await S.post('/api/plan/budget/session/P/budget', { budget: 'beaucoup' })).status, 400);
  const m = S.launches();
  const r = await S.post('/api/plan/budget/session/P/budget', { budget: 1 });
  assert.deepEqual(r.body, { ok: true, budget: 1, remaining: 0.98, restarted: true });
  await until(() => S.launches() > m);
  assert.equal(cap(S.args()), '1', 'the rest 0,98 $ plus the 0,02 $ Claude Code restores'); assert.ok(S.args().includes('--resume'));
  await until(() => S.prompts().some((p) => p.text === 'Ton plafond passe à 1 $ ; continue.'));
  P = await waiting('P'); assert.equal(P.budget, 1); assert.ok(P.usage.cost > 0.02, 'the turn after the raise ran');
  assert.equal(JSON.parse(readFileSync(path.join(S.plans, 'budget.json'), 'utf8')).sessions.find((s) => s.id === 'P').budget, 1, 'the plan is the contract');
  const msgs = (await S.get('/api/plan/budget/session/P/messages')).messages;
  assert.ok(msgs.some((x) => x.role === 'system' && /Plafond relevé à 1 \$ \(reste 0,98 \$\) : processus relancé/.test(x.text)));
  // not capped: the raise waits for the next start
  assert.deepEqual((await S.post('/api/plan/budget/session/R/budget', { budget: 2 })).body, { ok: true, budget: 2, remaining: 1.98, restarted: false }, 'R spent 0,01 $ before and after its stop');
  await S.stop();
});

test('the queue at parallel 1: two todo sessions, one runs, the other waits queued and starts when the first is done', async () => {
  const S = boot(); await S.ready();
  const root = repo();
  assert.equal((await S.post('/api/project/settings', { project: root, parallel: 0 })).status, 400);
  assert.equal((await S.post('/api/project/settings', { project: root, parallel: 1 })).body.settings.parallel, 1);
  // the network of the settings takes what a plan takes: an IP, host:port, localhost; a URL or a bad port is refused
  let n = await S.post('/api/project/settings', { project: root, network: ['127.0.0.1', '127.0.0.1:3318', 'localhost:5432', 'api.github.com', 'db.example.com:443'] });
  assert.equal(n.status, 200); assert.deepEqual(n.body.settings.network, ['127.0.0.1', '127.0.0.1:3318', 'localhost:5432', 'api.github.com', 'db.example.com:443'].map((host) => ({ host, scope: 'both' })));
  for (const bad of ['http://127.0.0.1', '127.0.0.1:99999', '300.1.1.1', 'exemple']) assert.equal((await S.post('/api/project/settings', { project: root, network: [bad] })).status, 400, bad);
  assert.equal((await S.post('/api/project/settings', { project: root, network: null })).status, 200);
  const plan = { id: 'file', title: 'File', sessions: [
    { id: 'A', name: 'Première', path: root, model: 'claude-sonnet-5-5', stops: ['Le fichier', 'La fin'], prompt: 'Écris.' },
    { id: 'B', name: 'Seconde', path: root, model: 'claude-sonnet-5-5', stops: ['La fin'], prompt: 'Écris aussi.' }] };
  assert.equal((await S.post('/api/plan', plan)).status, 200);
  assert.deepEqual((await S.post('/api/launch', { plan: 'file' })).body, { ok: true, launched: ['A'], queued: ['B'] });
  let B = await S.session('file', 'B');
  assert.deepEqual([B.status, B.queued, B.claude], ['todo', true, 'En file : 1 session tourne déjà']);
  // a new version of the launched plan: A launched can neither go nor change (409 with the list); B todo may change, C may come
  let v = await S.post('/api/plan', { ...plan, sessions: [plan.sessions[1]] });
  assert.equal(v.status, 409); assert.deepEqual(v.body.sessions, ['A est lancée (running) : elle ne peut pas disparaître du plan']);
  v = await S.post('/api/plan', { ...plan, sessions: [{ ...plan.sessions[0], prompt: 'Autre chose.' }, plan.sessions[1]] });
  assert.equal(v.status, 409); assert.match(v.body.error, /A est lancée \(running\) : elle ne peut plus changer/);
  assert.equal((await S.post('/api/plan', { ...plan, sessions: [plan.sessions[0], { ...plan.sessions[1], prompt: 'Écris autre chose.' }, { id: 'C', name: 'Ajoutée', path: root, model: 'claude-sonnet-5-5', stops: ['La fin'], prompt: 'Relis.' }] })).status, 200);
  assert.deepEqual((await S.get('/api/plan/file')).plan.sessions.map((s) => s.id), ['A', 'B', 'C'], 'A is still there');
  // the refusal of 1 November: the plan read by GET (prompts with the state instruction, stopMeta) sent back with one more session is accepted
  const read = (await S.get('/api/plan/file')).plan;
  assert.doesNotMatch(read.sessions[0].prompt, /(?:calmdev|escadrille):state/, 'FRU (MUET): the read prompt is the prompt as written');
  await until(() => S.prompts().some((p) => /calmdev:state/.test(p.text))); // the launched process still gets the state instruction
  v = await S.post('/api/plan', { ...read, sessions: [...read.sessions, { id: 'D', name: 'Relue', path: root, model: 'claude-sonnet-5-5', stops: ['La fin'], prompt: 'Ajoutée après relecture.' }] });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.deepEqual((await S.get('/api/plan/file')).plan.sessions.map((s) => s.id), ['A', 'B', 'C', 'D']);
  assert.equal((await S.get('/api/plan/file')).plan.sessions[0].prompt.match(/(?:calmdev|escadrille):state\n/g), null, 'the instruction is neither stored nor sent');
  v = await S.post('/api/plan', { ...read, sessions: read.sessions.map((x) => (x.id === 'A' ? { ...x, model: 'claude-opus-5-5' } : x)) });
  assert.equal(v.status, 409); assert.match(v.body.error, /A est lancée \(running\) : elle ne peut plus changer \(model\)/);
  // A goes through its four turns (one permission each) and says done
  for (let t = 1; t <= 4; t++) {
    const ask = await until(async () => (await S.session('file', 'A')).pending.find((p) => p.kind === 'permission'));
    await S.post('/api/plan/file/session/A/answer', { id: ask.id, allow: true });
    const A = await until(async () => { const s = await S.session('file', 'A'); return ['waiting', 'done'].includes(s.status) && !s.pending.some((p) => p.kind === 'permission') ? s : null; });
    if (A.status === 'done') break;
    await S.post('/api/plan/file/session/A/message', { text: 'Encore' });
  }
  B = await until(async () => { const s = await S.session('file', 'B'); return s.status === 'running' ? s : null; });
  assert.equal(B.queued, false); assert.ok(B.worktree?.branch);
  await S.stop();
});

test('an interrupted turn resumes on its own after a restart of the server, with the resume message', async () => {
  const S = boot(); await S.ready();
  const root = repo();
  const plan = { id: 'reprise', title: 'Reprise', sessions: [{ id: 'A', name: 'Seule', path: root, model: 'claude-sonnet-5-5', stops: ['La fin'], prompt: 'Écris.' }] };
  assert.equal((await S.post('/api/plan', plan)).status, 200);
  await S.post('/api/launch', { plan: 'reprise' });
  await until(async () => (await S.session('reprise', 'A')).pending.some((p) => p.kind === 'permission'));
  await S.stop();
  const S2 = boot({}, S); await S2.ready();
  await until(() => S2.prompts().some((p) => p.session_id === 'sess-9' && p.text === 'Le serveur a redémarré pendant ton tour ; reprends où tu en étais, puis finis par ton bloc calmdev:state.'));
  assert.equal(S2.args()[S2.args().indexOf('--resume') + 1], 'sess-9');
  const A = await S2.session('reprise', 'A');
  assert.equal(A.status, 'running', 'the turn is running again, nobody had to write');
  assert.ok(A.pending.some((p) => p.kind === 'info' && p.text === 'Reprise seule après redémarrage'));
  assert.ok(!A.pending.some((p) => p.kind === 'reply'));
  await S2.stop();
});
