// The burst « Jusqu'à la limite » (docs/burst.md), against a fake claude on a spare port with a throwaway database:
// the horizon, the backlog read and created, a burst that chains two tasks (questions answered « ok pour tout », the
// plan made autonomous without network and within the cap), the hard stop at the cap, Stop, the drain, the pushes.
// The fake is test/fake-claude.mjs's shape: a planner (it has --append-system-prompt) asks its questions, then writes
// a plan of one session; a session says done at its first turn, 0.5 $.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as burst from '../lib/burst.mjs';
import { openDatabase } from '../lib/sqlite.mjs';
import { horizonOf } from '../lib/horizon.mjs';
import { fake } from './burst-fake.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const repo = (backlog) => { const root = tmp('escadrille-burst-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); mkdirSync(path.join(root, 'docs')); if (backlog) writeFileSync(path.join(root, 'docs', 'backlog.md'), backlog); writeFileSync(path.join(root, 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root; };
const until = async (fn, ms = 40000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 140)); await new Promise((r) => setTimeout(r, 100)); } };

const pushed = [];
const fakePush = createServer((req, res) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => { const msgs = JSON.parse(s); pushed.push(...msgs); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: msgs.map(() => ({ status: 'ok' })) })); }); });
await new Promise((r) => fakePush.listen(0, '127.0.0.1', r));
const servers = [];
after(() => { for (const s of servers) s.kill('SIGKILL'); fakePush.close(); });

const boot = (env = {}, same = null) => {
  const PORT = freePort(); const base = `http://127.0.0.1:${PORT}`;
  const S = same ? { fake: same.fake, plans: same.plans, db: same.db, empty: same.empty } : { fake: fake(), plans: tmp('escadrille-plans-'), db: path.join(tmp('escadrille-db-'), 'db.sqlite'), empty: tmp('escadrille-none-') };
  S.proc = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: S.db, ESCADRILLE_PLANS: S.plans, ESCADRILLE_CLAUDE: S.fake.file, ESCADRILLE_TRANSCRIPTS: S.empty, ESCADRILLE_SESSIONS: S.empty, ESCADRILLE_PUSH_URL: `http://127.0.0.1:${fakePush.address().port}/push`, ESCADRILLE_BURST_TICK_MS: '200', ESCADRILLE_BURST_HUMAN_WAIT_MS: '300', ESCADRILLE_BURST_UNTIL: new Date(Date.now() + 3 * 36e5).toISOString(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(S.proc); S.err = ''; S.proc.stderr.on('data', (d) => { S.err += d; });
  S.base = base; S.get = async (p) => (await fetch(base + p)).json();
  S.post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  S.ready = () => until(async () => { try { await S.get('/api/plans'); return true; } catch { return false; } });
  return S;
};
const BACKLOG = '# Backlog\n\n- [ ] Écrire le README\n- [x] Déjà fait\n- [ ] Ajouter un test\n';

test('the rules: backlog, roadmap, memory, until and drain, the plan shaped, the answer, the horizon', () => {
  assert.deepEqual(burst.parseBacklog(BACKLOG), [{ n: 1, text: 'Écrire le README', done: false }, { n: 2, text: 'Déjà fait', done: true }, { n: 3, text: 'Ajouter un test', done: false }]);
  assert.deepEqual(burst.parseBacklog('- ~~vieux~~\n- neuf').map((t) => t.done), [true, false]);
  // a numbered open task is pre-checked in « Avancer le backlog » ; a numbered done one is not
  assert.deepEqual(burst.parseBacklog('- [ ] 1. Un\n- [ ] Deux\n- [x] 2. Fait').map((t) => !!t.pick), [true, false, false]);
  assert.deepEqual(burst.fromRoadmap('## Phase 1 : faite\n- a\n## Phase 2\n- b\n- c\n'), ['b', 'c']);
  assert.deepEqual(burst.fromRoadmap('## Phase 2\n- x\n- Reporté en phase 3 :\n  - **un**\n    suite\n  - deux\n- autre\n'), ['un suite', 'deux']);
  assert.deepEqual(burst.fromMemory('- Brancher le push\n- Le push est fait\n- Reste à tester\n'), ['Brancher le push', 'Reste à tester']);
  const t0 = Date.parse('2026-11-01T08:00:00Z');
  assert.equal(burst.untilOf({ resetsAt: '2026-11-01T12:00:00Z', cutoff: '2026-11-01T11:45:00Z', now: t0 }), '2026-11-01T11:45:00.000Z');
  assert.equal(burst.drainAtOf('2026-11-01T12:00:00.000Z'), '2026-11-01T11:15:00.000Z');
  const b = { until: '2026-11-01T12:00:00Z', drainAt: '2026-11-01T11:15:00Z', tasks: [] };
  assert.equal(burst.shouldDrain(b, t0), false); assert.equal(burst.shouldDrain(b, Date.parse('2026-11-01T11:20:00Z')), true);
  assert.equal(burst.shouldDrain(b, Date.parse('2026-11-01T11:00:00Z')), false); assert.equal(burst.shouldDrain({ ...b, tasks: [{ status: 'done', started: '2026-11-01T08:00:00Z', ended: '2026-11-01T10:00:00Z' }] }, Date.parse('2026-11-01T10:30:00Z')), true, 'a 2 h task does not fit in 1 h 30');
  const p = burst.shapePlan({ network: ['x.com'], sessions: [{ budget: 3 }, {}] }, { rest: 4, defaultBudget: 5 });
  assert.deepEqual(p.network, []); assert.equal(p.autonomy.mode, 'autonome');
  assert.equal(burst.shapePlan({ sessions: [{}] }, { rest: 4, projectAutonomy: { mode: 'surveille' } }).autonomy.mode, 'surveille', 'a Surveillé project stays Surveillé'); assert.deepEqual(p.sessions.map((s) => s.budget), [1.5, 2.5]);
  assert.deepEqual(burst.shapePlan({ sessions: [{ budget: 1 }] }, { rest: 4, projectAutonomy: { mode: 'strict' } }).autonomy, { mode: 'strict' }, 'a stricter project keeps its own');
  assert.equal(burst.answerFor({ install: [] }), 'ok pour tout\n\nÉcris le plan.');
  assert.equal(burst.reviewMinutes([{ additions: 300, deletions: 100 }]), 60);
  assert.deepEqual(burst.validateAutoBurst({ on: true }), { on: true, minMarginPct: 30, maxHoursLeft: 8 });
  assert.equal(burst.autoWants({ on: true, minMarginPct: 30, maxHoursLeft: 8 }, { remainingPct: 54, hoursLeft: 6 }), true);
  assert.equal(burst.autoWants({ on: true, minMarginPct: 30, maxHoursLeft: 8 }, { remainingPct: 54, hoursLeft: 9 }), false);
  assert.equal(burst.defaultCap({ remainingUsd: 112 }), 67); assert.equal(burst.defaultCap({ remainingUsd: null }), 10);
  const db = new DatabaseSync(':memory:'); db.exec('create table escadrilles (weekly real, reset_at text, at text)'); db.exec('create table sessions (usage text, at text)');
  assert.equal(horizonOf({ db }).source, 'none');
  db.prepare('insert into escadrilles values (?, ?, ?)').run(0.46, '2026-11-01T12:00:00Z', '2026-11-01T06:00:00Z');
  assert.deepEqual(horizonOf({ db, calibration: { dollarsPerPct: 2 }, now: t0 }), { project: null, usedPct: 46, resetsAt: '2026-11-01T12:00:00Z', remainingPct: 54, remainingUsd: 108, hoursLeft: 4, source: 'calibration' });
  db.prepare('insert into sessions values (?, ?)').run(JSON.stringify({ weekly: 0.5 }), '2026-11-01T07:00:00Z');
  assert.equal(horizonOf({ db, now: t0 }).usedPct, 50, 'a newer session reading wins (weeklyNow)');
});

test('the server: horizon and backlog, a burst of two tasks, the cap, Stop, the drain, the pushes', async () => {
  const S = boot(); await S.ready();
  const devs = new DatabaseSync(S.db); devs.prepare('insert into devices (id, name, token_hash, expo_push_token, created) values (?, ?, ?, ?, ?)').run('d1', 'iPhone', 'h', 'ExponentPushToken[ok]', new Date().toISOString());
  devs.prepare('insert into escadrilles (id, title, project, status, weekly, reset_at, created, at) values (?, ?, ?, ?, ?, ?, ?, ?)').run('old', 'x', '/', 'waiting', 0.46, new Date(Date.now() + 6 * 36e5).toISOString(), new Date().toISOString(), new Date().toISOString());
  const root = repo(BACKLOG);
  const h = await S.get('/api/project/horizon?project=' + encodeURIComponent(root));
  assert.equal(h.usedPct, 46); assert.equal(h.remainingPct, 54); assert.equal(h.hoursLeft, 6); assert.equal(h.source, 'none'); assert.equal(h.remainingUsd, null);

  // The backlog: read, never overwritten, created from a text
  assert.equal((await S.get('/api/project/backlog?project=' + encodeURIComponent(root))).tasks.length, 3);
  assert.equal((await S.post('/api/project/backlog', { project: root, from: 'text', text: 'x' })).status, 409);
  const other = repo(null); writeFileSync(path.join(other, 'ROADMAP.md'), '## Phase 1\n- un\n- deux\n');
  assert.deepEqual((await S.post('/api/project/backlog', { project: other, from: 'roadmap' })).body.tasks.map((t) => t.text), ['un', 'deux']);
  assert.match(readFileSync(path.join(other, 'docs', 'backlog.md'), 'utf8'), /- \[ \] un/);

  // A burst of tasks 1 and 3, cap 2 $, in a project set to Autonome (a Surveillé project keeps Surveillé)
  assert.equal((await S.post('/api/project/settings', { project: root, autonomy: { mode: 'autonome' } })).status, 200);
  const { body: { id } } = await S.post('/api/burst', { project: root, tasks: [1, 2, 3], capUsd: 2 });
  assert.ok(id);
  assert.equal((await S.post('/api/burst', { project: root, capUsd: 2 })).status, 409, 'one burst per project');
  const b = await until(async () => { const x = await S.get('/api/burst/' + id); return x.status === 'done' && x; }, 30000);
  assert.deepEqual(b.tasks.map((t) => [t.n, t.status]), [[1, 'done'], [3, 'done']], 'the done task 2 is left out');
  const prompts = S.fake.prompts();
  assert.equal(prompts.filter((p) => p.planner && p.text === 'ok pour tout\n\nÉcris le plan.').length, 2, '« ok pour tout » sent to each planner');
  assert.match(S.fake.system(), /## La rafale\n\nCette planification vient d'une rafale/);
  const plan = JSON.parse(readFileSync(path.join(S.plans, b.tasks[0].plan + '.json'), 'utf8'));
  assert.deepEqual(plan.network, []); assert.equal(plan.autonomy.mode, 'autonome');
  assert.ok(plan.sessions[0].budget < 2 && plan.sessions[0].budget > 1.5, 'the 3 $ cap bounded to the rest: ' + plan.sessions[0].budget);
  assert.ok(b.spentUsd >= 1.1 && b.spentUsd <= 1.3, 'two planners and two sessions: ' + b.spentUsd);
  assert.ok(b.log.some((l) => /Rafale lancée : 2 tâches, 2 \$ au plus/.test(l.text)));
  assert.equal((await S.get('/api/bursts?project=' + encodeURIComponent(root))).bursts.length, 1);
  await until(() => pushed.some((m) => m.data.kind === 'burst-end'));
  assert.match(pushed.find((m) => m.data.kind === 'burst-start').title, /Rafale lancée : 2 tâches/);
  assert.match(pushed.find((m) => m.data.kind === 'burst-end').title, /Rafale finie : 2\/2 faites/);

  // The cap: 0.55 $ is reached at the end of the first task's session
  const r2 = repo(BACKLOG);
  const c = (await S.post('/api/burst', { project: r2, capUsd: 0.55 })).body.id;
  const capped = await until(async () => { const x = await S.get('/api/burst/' + c); return x.status !== 'running' && x; }, 30000);
  assert.equal(capped.status, 'limit'); assert.equal(capped.tasks[1].status, 'todo', 'the second task never starts');

  // Stop: the planner stops, the task stays to do
  const r3 = repo(BACKLOG);
  const s = (await S.post('/api/burst', { project: r3, capUsd: 5 })).body.id;
  await until(async () => (await S.get('/api/burst/' + s)).tasks[0].status === 'planning');
  assert.deepEqual((await S.post(`/api/burst/${s}/stop`)).body, { ok: true });
  const stopped = await S.get('/api/burst/' + s);
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.tasks[0].status, 'todo');

  // The drain: drainAt already past, nothing starts and the burst ends done
  const r4 = repo(BACKLOG);
  const d = (await S.post('/api/burst', { project: r4, capUsd: 5, drainMin: 600 })).body.id;
  const drained = await until(async () => { const x = await S.get('/api/burst/' + d); return x.status === 'done' && x; });
  assert.ok(drained.log.some((l) => /^Vidange/.test(l.text))); assert.ok(drained.tasks.every((t) => t.status === 'todo'));
  assert.equal(S.err.includes('Error') ? S.err : '', '');
});

// The end at until, without exception (1 November: the noon burst stayed « draining » until the evening and relaunched
// a session when the server restarted): at a tick and at the start of the server, the burst ends 'ended', the
// sessions of its plans leave the page and none is resumed; a burst already over never gets a session resumed.
// a busy timeout: the server writes the same file; without it a read under load throws « database is locked »
const sql = (S, q, ...a) => { const d = openDatabase(S.db); try { return /^\s*select/i.test(q) ? d.prepare(q).all(...a) : d.prepare(q).run(...a); } finally { d.close(); } };
const PAST = () => new Date(Date.now() - 60e3).toISOString();
const sessionOf = (S, plan) => sql(S, 'select status, mode, session_id from sessions where plan = ?', plan)[0];
const runningTask = async (S, root) => {
  assert.equal((await S.post('/api/project/settings', { project: root, autonomy: { mode: 'autonome' } })).status, 200);
  const { body: { id } } = await S.post('/api/burst', { project: root, tasks: [1], capUsd: 5 });
  const b = await until(async () => { const x = await S.get('/api/burst/' + id); return x.tasks[0].status === 'running' && x.tasks[0].plan && x; });
  await until(() => { const r = sessionOf(S, b.tasks[0].plan); return r && r.session_id && r.mode === 'page' && r.status === 'waiting'; });
  return { id, plan: b.tasks[0].plan };
};

test('the rules of the end: pastUntil, the finished plans', () => {
  const t = Date.parse('2026-11-01T14:00:00Z');
  assert.equal(burst.pastUntil({ until: '2026-11-01T14:00:00Z' }, t), true, 'at until, it is over');
  assert.equal(burst.pastUntil({ until: '2026-11-01T14:00:00Z' }, t - 1), false);
  assert.equal(burst.pastUntil({ until: null }, t), false, 'no until, no end by the clock');
  const d = new DatabaseSync(':memory:'); burst.ensureTable(d);
  const row = (id, status, plan) => burst.insertBurst(d, { id, project: '/p', created: 'x', status, capUsd: 1, until: 'u', drainAt: 'u', tasks: [{ n: 1, plan }], log: [] });
  row('a', 'draining', 'p-active'); row('b', 'done', 'p-done'); row('c', 'ended', 'p-ended'); row('e', 'stopped', null);
  assert.deepEqual([...burst.finishedPlans(d)].sort(), ['p-done', 'p-ended']);
});

test('a burst past its until ends at the next tick, its sessions stopped', { timeout: 120000 }, async () => {
  const S = boot({ FAKE_SESSION_WAITS: '1' }); await S.ready();
  const { id, plan } = await runningTask(S, repo(BACKLOG));
  sql(S, 'update bursts set until = ?, status = ? where id = ?', PAST(), 'draining', id); // draining, as on 1 November
  const b = await until(async () => { const x = await S.get('/api/burst/' + id); return x.status === 'ended' && x; });
  assert.ok(b.log.some((l) => /Heure de fin .* passée/.test(l.text)), JSON.stringify(b.log));
  assert.equal(b.tasks[0].status, 'todo'); assert.match(b.tasks[0].note, /reprenable/);
  await until(() => sessionOf(S, plan).mode === null);
  const en = await (await fetch(S.base + '/api/burst/' + id, { headers: { cookie: 'escadrille-lang=en' } })).json();
  assert.ok(en.log.some((l) => /End time .* passed/.test(l.text)), 'the journal line in English');
  S.proc.kill('SIGKILL');
});

test('at the start of the server, a burst past its until ends and none of its sessions is resumed', { timeout: 120000 }, async () => {
  const S = boot({ FAKE_SESSION_WAITS: '1' }); await S.ready();
  const { id, plan } = await runningTask(S, repo(BACKLOG));
  S.proc.kill('SIGKILL'); await new Promise((r) => S.proc.once('exit', r));
  // the server died during a turn (the row says running) and the clock passed until while it was down
  sql(S, "update sessions set status = 'running' where plan = ?", plan);
  sql(S, 'update bursts set until = ? where id = ?', PAST(), id);
  const spawned = S.fake.sessionSpawns(); const said = S.fake.prompts().length;
  const S2 = boot({ FAKE_SESSION_WAITS: '1' }, S); await S2.ready();
  const b = await S2.get('/api/burst/' + id);
  assert.equal(b.status, 'ended', 'ended before the first request'); assert.equal(b.tasks[0].status, 'todo');
  assert.equal(sessionOf(S, plan).mode, null); assert.equal(sessionOf(S, plan).status, 'waiting');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(S.fake.sessionSpawns(), spawned, 'no session process started'); assert.equal(S.fake.prompts().length, said, 'nothing sent');
  S2.proc.kill('SIGKILL'); await new Promise((r) => S2.proc.once('exit', r));

  // a burst already over: a session left in the page (by any path) is not resumed either, and says why
  sql(S, "update sessions set mode = 'page', status = 'running' where plan = ?", plan);
  const S3 = boot({ FAKE_SESSION_WAITS: '1' }, S); await S3.ready();
  assert.equal(sessionOf(S, plan).mode, null);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(S.fake.sessionSpawns(), spawned, 'still no session process');
  assert.ok(sql(S, 'select text from session_messages where plan = ?', plan).some((m) => m.text === '⟦srv.b.notResumed⟧'));
  S3.proc.kill('SIGKILL');
});

// FREIN (Dev, 7 Nov.): above the threshold of finished deliveries not reviewed, « Avancer le backlog » is refused by the
// server with the path that works, said once in the thread; raised in Accès (POST /api/limits { brake }), it starts again
test('the review pace brake: the burst refused above the threshold, open again once raised', async () => {
  const S = boot(); await S.ready();
  const root = repo(BACKLOG);
  sql(S, 'insert into plans (id, title, created, json, project) values (?, ?, ?, ?, ?)', 'frein-p', 'Frein', new Date().toISOString(), JSON.stringify({ id: 'frein-p', sessions: [{ id: 'A' }, { id: 'B' }] }), root);
  for (const id of ['A', 'B']) sql(S, 'insert into sessions (plan, id, status, worktree) values (?, ?, ?, ?)', 'frein-p', id, 'done', JSON.stringify({ path: root, branch: 'b-' + id }));
  const set = await S.post('/api/limits', { project: root, brake: 1 });
  assert.equal(set.status, 200); assert.deepEqual([set.body.brake.count, set.body.brake.threshold], [2, 1]);
  assert.equal((await S.post('/api/limits', { project: root, brake: 0 })).status, 400, 'a threshold is an integer from 1');
  const r = await S.post('/api/burst', { project: root, capUsd: 1 });
  assert.equal(r.status, 409); assert.match(r.body.error, /2 livraisons finies à relire \(seuil 1\)/); assert.match(r.body.error, /monte le seuil dans Accès/);
  await S.post('/api/burst', { project: root, capUsd: 1 });
  assert.equal(sql(S, "select text from main_messages where project = ? and role = 'system'", root).filter((m) => /livraisons finies à relire/.test(m.text)).length, 1, 'said once in the thread');
  assert.equal((await S.post('/api/limits', { project: root, brake: 5 })).body.brake.threshold, 5);
  const ok = await S.post('/api/burst', { project: root, capUsd: 1 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); await S.post(`/api/burst/${ok.body.id}/stop`);
  S.proc.kill('SIGKILL');
});
