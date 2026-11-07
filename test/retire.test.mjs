// Retire a plan (Dev, 6 November 2026; docs/flot.md, « Retirer un plan »): POST /api/plan/:id/retire stops the plan's live
// sessions and returns their ids, twice gives the same plan, every starting point refuses a retired plan with the path that
// works, POST /api/plan/:id/reopen gives the plan back without launching anything, and a plan closed by hand (closedAt
// written in its JSON) is read as retired. Throwaway base, ESCADRILLE_PLANS in a temp folder, the fake claude.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fakeClaude } from './fake-claude.mjs';
import { isRetired, retiredPlan, reopenedPlan } from '../lib/retire.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 120)); await new Promise((r) => setTimeout(r, 150)); } };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = [];
after(() => { for (const s of servers) s.kill('SIGKILL'); });

const boot = (dbFile, plans, fake) => {
  const PORT = freePort(); const url = `http://127.0.0.1:${PORT}`; const empty = tmp('escadrille-none-');
  const proc = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: dbFile, ESCADRILLE_PLANS: plans, ESCADRILLE_CLAUDE: fake.file, ESCADRILLE_TRANSCRIPTS: empty, ESCADRILLE_SESSIONS: empty, ESCADRILLE_TESTBOX: 'none' }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(proc); const S = { err: '' }; proc.stderr.on('data', (d) => { S.err += d; });
  S.get = async (p) => (await fetch(url + p)).json();
  S.post = async (p, body = {}) => { const r = await fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  S.ready = () => until(async () => { try { await S.get('/api/plans'); return true; } catch { return false; } }).catch((e) => { throw new Error(e.message + ' ' + S.err); });
  S.stop = () => new Promise((resolve) => { proc.on('exit', resolve); proc.kill('SIGINT'); });
  return S;
};
const launches = (fake) => { const f = path.join(path.dirname(fake.file), 'args.jsonl'); return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0; };
const repo = () => { const root = tmp('escadrille-ret-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); writeFileSync(path.join(root, 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root; };
const session = (id, root) => ({ id, name: id, path: root, model: 'claude-sonnet-5-5', stops: ['La fin'], prompt: 'Travaille.', budget: 1 });

test('isRetired reads the three hand-written forms; retiredPlan keeps its first date; reopenedPlan drops the fields', () => {
  assert.equal(isRetired({ status: 'closed' }), true); assert.equal(isRetired({ closed: true }), true); assert.equal(isRetired({ closedAt: '2026-11-06' }), true);
  assert.equal(isRetired({ status: 'todo' }), false); assert.equal(isRetired(null), false);
  const r = retiredPlan({ id: 'p' }, ' abandonné ', 'T1'); assert.deepEqual([r.status, r.closed, r.closedAt, r.closedWhy], ['closed', true, 'T1', 'abandonné']);
  assert.equal(retiredPlan(r, '', 'T2').closedAt, 'T1', 'twice: the same date');
  const o = reopenedPlan(r, 'T3'); assert.equal(isRetired(o), false); assert.ok(!('closedWhy' in o)); assert.equal(o.reopenedAt, 'T3');
});

test('retire stops the live sessions, refuses every start, reopens without launching; a plan closed by hand is retired', async () => {
  const root = repo(); const dbFile = path.join(tmp('escadrille-db-'), 'db.sqlite'); const plans = tmp('escadrille-plans-'); const fake = fakeClaude();
  let S = boot(dbFile, plans, fake); await S.ready();
  assert.equal((await S.post('/api/plan', { id: 'ret', title: 'Retrait', sessions: [session('A', root), session('B', root)] })).status, 200);
  assert.equal((await S.post('/api/plan', { id: 'main', title: 'À la main', sessions: [session('M', root)] })).status, 200);
  assert.equal((await S.post('/api/launch', { plan: 'ret', session: 'A' })).status, 200);
  await until(async () => (await S.get('/api/plan/ret')).state.find((x) => x.id === 'A').pending.some((p) => p.kind === 'permission'));
  const before = launches(fake); assert.equal(before, 1);

  // 1. retire: A was live, it stops and comes back in stopped
  const r1 = await S.post('/api/plan/ret/retire', { why: 'abandonné' });
  assert.equal(r1.status, 200, JSON.stringify(r1.body)); assert.deepEqual(r1.body.stopped, ['A']); assert.equal(r1.body.ok, true);
  const file = JSON.parse(readFileSync(path.join(plans, 'ret.json'), 'utf8'));
  assert.deepEqual([file.status, file.closed, file.closedWhy], ['closed', true, 'abandonné']); assert.ok(file.closedAt);
  const got = await S.get('/api/plan/ret'); assert.equal(got.plan.closed, true); assert.equal(got.plan.closedAt, file.closedAt);
  assert.ok(!got.state.find((x) => x.id === 'A').pending.some((p) => p.kind === 'permission'), 'the permission of the stopped process is gone');
  const running = await S.get('/api/running'); assert.ok(!running.ours.some((o) => o.plan === 'ret' && o.kind === 'session'), 'no process of the plan left');

  // 2. twice: the same plan, nothing more to stop
  const r2 = await S.post('/api/plan/ret/retire', {});
  assert.equal(r2.status, 200); assert.deepEqual(r2.body.stopped, []); assert.equal(r2.body.closedAt, file.closedAt);
  assert.equal(JSON.parse(readFileSync(path.join(plans, 'ret.json'), 'utf8')).closedWhy, 'abandonné');

  // 3. every starting point refuses it, with the path that works
  const refusals = [
    ['/api/launch', { plan: 'ret' }], ['/api/launch', { plan: 'ret', session: 'B' }],
    ['/api/plan/ret/session/A/message', { text: 'continue' }], ['/api/plan/ret/session/A/resume', {}], ['/api/plan/ret/session/A/now', {}],
    ['/api/plan/ret/session/A/budget', { usd: 5 }], ['/api/plan/ret/session/A/continue-budget', {}], ['/api/plan/ret/session/A/run-tests', {}],
    ['/api/plan/ret/session/A/devserver', {}],
  ];
  for (const [p, body] of refusals) { const r = await S.post(p, body); assert.equal(r.status, 409, `${p} → ${r.status} ${JSON.stringify(r.body)}`); assert.match(r.body.error, /rouvrir/, p); }
  await pause(500); assert.equal(launches(fake), before, 'no process started by any refusal');
  assert.equal((await S.get('/api/plan/ret')).state.find((x) => x.id === 'B').status, 'todo');

  // 4. reopen: the plan is back, nothing launched
  const o = await S.post('/api/plan/ret/reopen'); assert.equal(o.status, 200);
  const back = await S.get('/api/plan/ret'); assert.ok(!back.plan.closed && !back.plan.closedAt && back.plan.status !== 'closed');
  assert.ok(!JSON.parse(readFileSync(path.join(plans, 'ret.json'), 'utf8')).closedAt);
  await pause(500); assert.equal(launches(fake), before, 'reopen launches nothing');
  assert.equal(back.state.find((x) => x.id === 'B').status, 'todo'); assert.notEqual(back.state.find((x) => x.id === 'A').mode, 'page');

  // 5. a plan closed by hand (6 November: closedAt written in the base's JSON) is read as retired, without migration
  await S.stop();
  { const db = new DatabaseSync(dbFile); const j = JSON.parse(db.prepare('select json from plans where id = ?').get('main').json); const hand = JSON.stringify({ ...j, closedAt: '2026-11-06T10:00:00Z', closedWhy: 'à la main' }); db.prepare('update plans set json = ? where id = ?').run(hand, 'main'); db.close(); writeFileSync(path.join(plans, 'main.json'), hand); }
  mkdirSync(path.join(plans, 'retired')); writeFileSync(path.join(plans, 'retired', 'old.json'), JSON.stringify({ id: 'old', title: 'Ancien', project: root, closedAt: '2026-11-06T09:00:00Z', sessions: [session('O', root)] }));
  S = boot(dbFile, plans, fake); await S.ready();
  const m = await S.post('/api/launch', { plan: 'main' }); assert.equal(m.status, 409, JSON.stringify(m.body)); assert.match(m.body.error, /rouvrir/);
  const flow = await S.get('/api/projectflow?project=' + encodeURIComponent(root));
  assert.ok(flow.retired.some((p) => p.id === 'main'), 'the hand-closed plan folds into « Retirés »: ' + JSON.stringify(flow.retired));
  assert.ok(flow.retired.some((p) => p.id === 'old' && p.archived), 'a plan moved to plans/retired/ is listed too');
  for (const all of ['', '&all=1']) { const f = await S.get('/api/projectflow?project=' + encodeURIComponent(root) + all); assert.ok(!f.plans.some((p) => p.id === 'main') && !f.nodes.some((n) => n.plan === 'main'), 'gone from the graph' + all); }
  await pause(300); assert.equal(launches(fake), before);
});
