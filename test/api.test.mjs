// The API contract of phases 3 and 4, against the server on a spare port with a throwaway database, a
// throwaway plans folder, a throwaway git repository and the fake claude: launch, permission, answer,
// messages, state block, merge, the next wave, the SSE events; then, on a second server whose fake
// claude plays a climbing context, the budget, the alerts, the handoff and dismiss (docs/sessions.md).
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeClaude } from './fake-claude.mjs';
import { fakeNpm, devProject } from './fake-npm.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const repo = () => { const root = tmp('escadrille-api-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); mkdirSync(path.join(root, 'app')); writeFileSync(path.join(root, 'app', 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root; };
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };
// The arguments of the last fake claude launched (written as soon as it starts, a few ms after the launch)
const argsOf = async (S) => until(() => { try { return JSON.parse(readFileSync(path.join(S.fake.dir, 'args.json'), 'utf8')); } catch { return null; } });
const settingsOf = (args) => JSON.parse(args[args.indexOf('--settings') + 1]);

// One server on a spare port, with its own fake claude, database and plans folder, and every SSE event of one plan
const boot = (planId, env = {}) => {
  const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
  const fake = fakeClaude(); const plans = tmp('escadrille-plans-');
  const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('escadrille-db-'), 'db.sqlite'), ESCADRILLE_PLANS: plans, ESCADRILLE_TRANSCRIPTS: mkdtempSync(path.join(tmpdir(), 'escadrille-none-')), ESCADRILLE_SESSIONS: mkdtempSync(path.join(tmpdir(), 'escadrille-none-')), ESCADRILLE_CLAUDE: fake.file, ESCADRILLE_NPM: fakeNpm(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const S = { fake, plans, base: BASE, events: [], err: '', out: '', aborter: new AbortController() };
  server.stdout.on('data', (d) => { S.out += d; });
  server.stderr.on('data', (d) => { S.err += d; });
  S.get = async (p) => (await fetch(BASE + p)).json();
  S.post = async (p, body) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  S.sessionOf = async (id) => (await S.get(`/api/plan/${planId}`)).state.find((s) => s.id === id);
  S.ready = async () => {
    await until(async () => { try { await S.get('/api/plans'); return true; } catch { return false; } });
    const r = await fetch(`${BASE}/api/events?plan=${planId}`, { signal: S.aborter.signal }); const reader = r.body.getReader(); let buf = '';
    (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) return; buf += Buffer.from(value).toString(); let i; while ((i = buf.indexOf('\n\n')) !== -1) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /^event: (\S+)/m.exec(chunk)?.[1]; const data = /^data: (.*)$/m.exec(chunk)?.[1]; if (ev) S.events.push({ event: ev, data: ev === 'change' || ev === 'hello' ? null : JSON.parse(data) }); } } } catch {} })();
  };
  S.stop = () => { S.aborter.abort(); server.kill('SIGINT'); };
  return S;
};

const root = repo(); const root2 = repo();
const S1 = boot('jetable');
const S2 = boot('montee', { FAKE_CLAUDE_CONTEXT_WINDOW: '1000', FAKE_CLAUDE_CONTEXT_STEP: '250' });
after(() => { S1.stop(); S2.stop(); });

test('the plan, launched by the API, asks, answers, reports its state, merges and starts the next wave', async () => {
  const { get, post, sessionOf, events } = S1;
  await S1.ready();
  const plan = { id: 'jetable', title: 'Jetable', sessions: [
    { id: 'A', name: 'Première', path: path.join(root, 'app'), model: 'claude-sonnet-5-5', stops: ['Le fichier', 'La fin'], prompt: 'Écris docs/essai.txt.' },
    { id: 'B', name: 'Seconde', wave: 2, after: ['A'], path: root, model: 'claude-sonnet-5-5', stops: ['La fin'], prompt: 'Relis.' }] };
  assert.equal((await post('/api/plan', plan)).status, 200);
  // the contract of /api/plan/:id before any launch
  let r = await get('/api/plan/jetable');
  // FRU (MUET, 6 November): GET gives the prompt as written; the state instruction goes only to the process (checked at launch)
  assert.equal(r.plan.sessions[0].prompt, 'Écris docs/essai.txt.', 'the prompt without the state instruction');
  assert.deepEqual(r.plan.network, [], 'network is rendered, empty by default');
  assert.deepEqual(r.state.map((s) => [s.id, s.status, s.sessionId, s.mode, s.worktree, s.usage, s.pending, s.budget, s.handoffs, s.summary]), [['A', 'todo', null, null, null, null, [], 5, [], null], ['B', 'later', null, null, null, null, [], 5, [], null]]);
  assert.equal((await fetch(S1.base + '/api/update', { method: 'POST', body: '{}' })).status, 404, '/api/update is gone');

  // launch: every todo session of the first wave, in a worktree, running
  const launched = await post('/api/launch', { plan: 'jetable' });
  assert.deepEqual(launched.body, { ok: true, launched: ['A'], queued: [] });
  let A = await sessionOf('A');
  assert.equal(A.status, 'running'); assert.equal(A.mode, 'page');
  assert.equal(A.worktree.path, path.join(root, '.claude', 'worktrees', 'jetable-A')); assert.equal(A.worktree.branch, 'calmdev/jetable/A'); assert.equal(A.worktree.merged, false);
  assert.equal(sh(A.worktree.path, ['branch', '--show-current']), 'calmdev/jetable/A');
  assert.ok(readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8').split('\n').includes('.escadrille/'), 'the handoff folder is excluded from git');
  const args = await argsOf(S1);
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '5', 'the default cap goes to claude');
  assert.deepEqual(settingsOf(args).sandbox.network, { allowedDomains: [], allowLocalBinding: true }, 'no domain by default');
  assert.equal(settingsOf(args).sandbox.enabled, true);
  const frugal = settingsOf(args).hooks.PreToolUse.find((h) => h.matcher === 'Read');
  assert.ok(frugal && frugal.hooks[0].command.includes('frugal-hook.mjs'), 'a plan session gets the frugal hook (docs/frugal.md, phase 14)');
  assert.match(S1.out, new RegExp(`listening on 127\\.0\\.0\\.1 only`), 'the start line says where it listens');

  // the permission request comes up as a pending entry, a message and an SSE event
  A = await until(async () => { const s = await sessionOf('A'); return s.pending.some((p) => p.kind === 'permission') ? s : null; });
  assert.equal(A.sessionId, 'sess-9');
  const ask = A.pending[0];
  assert.deepEqual({ kind: ask.kind, tool: ask.tool, input: ask.input, text: ask.text, network: ask.network }, { kind: 'permission', tool: 'Bash', input: { command: 'curl -s http://x' }, text: 'curl -s http://x', network: true });
  assert.ok(ask.id && ask.at);
  let msgs = (await get('/api/plan/jetable/session/A/messages')).messages;
  assert.deepEqual(msgs.map((m) => m.role), ['system', 'activity', 'ask']);
  assert.equal(msgs[2].data.id, ask.id);
  assert.ok(events.some((e) => e.event === 'pending' && e.data.session === 'A'));
  assert.ok(events.some((e) => e.event === 'message' && e.data.session === 'A' && e.data.message.role === 'ask'));

  // answered: the turn ends, the state block is read, the session waits with a reply pending
  assert.deepEqual((await post('/api/plan/jetable/session/A/answer', { id: ask.id, allow: true, always: true })).body, { ok: true });
  A = await until(async () => { const s = await sessionOf('A'); return s.status === 'waiting' ? s : null; });
  assert.deepEqual(A.stops, [0]); assert.equal(A.claude, 'Regarde docs/essai.txt'); assert.equal(A.health, 'ok');
  assert.deepEqual(A.usage, { input: 112, output: 5, cost: 0.01, claude: { id: A.usage.claude.id, cost: 0.01 }, weekly: null, context: 0.112 });
  assert.equal(A.pending.length, 1); assert.deepEqual({ kind: A.pending[0].kind, stop: A.pending[0].stop, text: A.pending[0].text, summary: A.pending[0].summary }, { kind: 'reply', stop: 0, text: 'Regarde docs/essai.txt', summary: null });
  r = await get('/api/plan/jetable'); assert.ok(r.log.some((l) => l.session === 'A' && l.status === 'waiting'), 'the journal has the change');
  assert.equal((await post('/api/plan/jetable/session/A/answer', { id: ask.id, allow: true })).status, 400, 'an answered request is gone');
  assert.equal((await post('/api/plan/jetable/session/A/dismiss', { id: A.pending[0].id })).status, 400, 'a reply is not dismissed');

  // the developer's turns: the second curl asks again ("always" never covers the network); the rm is remembered, the next one goes through; the last turn says done
  const nextAsk = async () => until(async () => { const s = await sessionOf('A'); return s.pending.find((p) => p.kind === 'permission') || null; });
  assert.deepEqual((await post('/api/plan/jetable/session/A/message', { text: 'Encore' })).body, { ok: true });
  let a = await nextAsk(); assert.equal(a.text, 'curl -s http://y'); assert.equal(a.network, true);
  assert.deepEqual((await post('/api/plan/jetable/session/A/answer', { id: a.id, allow: true })).body, { ok: true });
  A = await until(async () => { const s = await sessionOf('A'); return s.status === 'waiting' ? s : null; });
  assert.deepEqual((await post('/api/plan/jetable/session/A/message', { text: 'Encore' })).body, { ok: true });
  a = await nextAsk(); assert.equal(a.text, 'rm -f out.txt'); assert.equal(a.network, false);
  assert.deepEqual((await post('/api/plan/jetable/session/A/answer', { id: a.id, allow: true, always: true })).body, { ok: true });
  A = await until(async () => { const s = await sessionOf('A'); return s.status === 'waiting' ? s : null; });
  assert.deepEqual((await post('/api/plan/jetable/session/A/message', { text: 'Fin' })).body, { ok: true });
  A = await until(async () => { const s = await sessionOf('A'); return s.status === 'done' ? s : null; });
  assert.deepEqual(A.stops, [0, 1]); assert.deepEqual(A.pending, []); assert.equal(A.worktree.merged, false, 'no autoMerge: the merge waits for the button');
  msgs = (await get('/api/plan/jetable/session/A/messages')).messages;
  assert.deepEqual(msgs.map((m) => m.role), ['system', 'activity', 'ask', 'system', 'claude', 'dev', 'activity', 'ask', 'system', 'claude', 'dev', 'activity', 'ask', 'system', 'claude', 'dev', 'activity', 'activity', 'claude']);
  assert.equal(msgs[4].text, 'La commande a dit ok.', 'the prose without the state block');
  assert.match(msgs[17].text, /autorisé d’office/);

  // the merge, then the next wave starts on its own
  assert.deepEqual((await post('/api/plan/jetable/session/A/merge')).body, { ok: true });
  A = await sessionOf('A'); assert.equal(A.worktree.merged, true); assert.equal(A.mode, null); assert.ok(!existsSync(A.worktree.path), 'the worktree is removed, the branch kept');
  assert.equal(sh(root, ['branch', '--list', 'calmdev/jetable/A']), 'calmdev/jetable/A');
  const B = await until(async () => { const s = await sessionOf('B'); return s.status === 'running' ? s : null; });
  assert.equal(B.worktree.branch, 'calmdev/jetable/B'); assert.equal(B.worktree.path, path.join(root, '.claude', 'worktrees', 'jetable-B'));
  assert.equal(sh(root, ['status', '--porcelain']), '', 'the project stays clean');

  // settings, stop, resume
  assert.deepEqual((await post('/api/plan/jetable/settings', { autoMerge: true })).body, { ok: true });
  assert.equal((await get('/api/plan/jetable')).plan.autoMerge, true);
  for (const bad of [['https://api.github.com'], ['*'], 'api.github.com', [42]]) {
    const x = await post('/api/plan/jetable/settings', { network: bad }); assert.equal(x.status, 400, JSON.stringify(bad)); assert.ok(x.body.error);
  }
  assert.deepEqual((await get('/api/plan/jetable')).plan.network, [], 'a refused list changes nothing');
  assert.deepEqual((await post('/api/plan/jetable/settings', { network: [' API.github.com ', '*.npmjs.org'] })).body, { ok: true });
  r = await get('/api/plan/jetable'); assert.deepEqual(r.plan.network, ['api.github.com', '*.npmjs.org']); assert.equal(r.plan.autoMerge, true, 'a missing field keeps its value');
  assert.deepEqual(JSON.parse(readFileSync(path.join(S1.plans, 'jetable.json'), 'utf8')).network, ['api.github.com', '*.npmjs.org'], 'kept in plans/<id>.json');
  // the plan's network only announces: the project's list opens the sandbox (lib/domains.mjs); a plan-only host stays shut
  const proj = r.plan.project;
  for (const [host, scope] of [['api.github.com', 'sessions'], ['*.npmjs.org', 'both'], ['docs.rs', 'plan']]) assert.equal((await post('/api/project/domain', { project: proj, host, scope })).status, 200, host);
  await until(async () => (await sessionOf('B')).pending.length);
  assert.deepEqual((await post('/api/plan/jetable/session/B/stop')).body, { ok: true });
  let Bs = await sessionOf('B'); assert.equal(Bs.mode, null); assert.equal(Bs.status, 'waiting'); assert.deepEqual(Bs.pending, []);
  assert.deepEqual((await post('/api/plan/jetable/session/B/resume')).body, { ok: true });
  Bs = await sessionOf('B'); assert.equal(Bs.mode, 'page');
  // the restart takes the plan's domains: the sandbox of B opens them, nothing more
  const resumed = await until(async () => { const a = await argsOf(S1); return a.includes('--resume') && settingsOf(a).sandbox.network.allowedDomains.length ? a : null; });
  assert.deepEqual(settingsOf(resumed).sandbox.network.allowedDomains, ['api.github.com', '*.npmjs.org']);

  // what runs: B's claude process and its worktree; A's worktree is gone with its merge
  let run = await get('/api/running');
  const kinds = (o) => o.map((x) => `${x.kind}:${x.plan}/${x.session}`).sort();
  assert.deepEqual(kinds(run.ours), ['session:jetable/B', 'worktree:jetable/B']);
  const sess = run.ours.find((x) => x.kind === 'session');
  assert.ok(sess.pid > 0); assert.equal(sess.cwd, Bs.worktree.cwd); assert.equal(sess.url, null); assert.ok(sess.since);
  const wtB = run.ours.find((x) => x.kind === 'worktree'); assert.equal(wtB.pid, null); assert.equal(wtB.cwd, Bs.worktree.cwd); assert.ok(wtB.since);
  assert.ok(Array.isArray(run.others)); assert.ok(!run.others.some((o) => o.pid === sess.pid), 'our claude is not among the others');
  for (const o of run.others) assert.deepEqual(Object.keys(o).sort(), ['args', 'cwd', 'pid', 'since']);

  // open: the folder of the session; no package.json yet, then a dev script
  assert.deepEqual(Bs.open, { folder: Bs.worktree.cwd, dev: false, url: null });
  assert.equal((await post('/api/plan/jetable/session/B/devserver')).status, 400, 'no dev script, no dev server');
  devProject(Bs.worktree.cwd);
  assert.deepEqual((await sessionOf('B')).open, { folder: Bs.worktree.cwd, dev: true, url: null });
  const before = events.filter((e) => e.event === 'change').length;
  const dev = await post('/api/plan/jetable/session/B/devserver');
  assert.equal(dev.status, 200); assert.equal(dev.body.ok, true); assert.ok(dev.body.url, JSON.stringify((await get("/api/plan/jetable/session/B/messages")).messages.slice(-1))); assert.match(dev.body.url, /^http:\/\/localhost:\d+$/);
  assert.equal(await (await fetch(dev.body.url)).text(), 'dev ok');
  assert.deepEqual((await post('/api/plan/jetable/session/B/devserver')).body, dev.body, 'one dev server per session');
  assert.deepEqual((await sessionOf('B')).open, { folder: Bs.worktree.cwd, dev: true, url: dev.body.url });
  await until(() => events.filter((e) => e.event === 'change').length > before);
  run = await get('/api/running');
  assert.deepEqual(kinds(run.ours), ['devserver:jetable/B', 'session:jetable/B', 'worktree:jetable/B']);
  const ds = run.ours.find((x) => x.kind === 'devserver'); assert.equal(ds.url, dev.body.url); assert.equal(ds.cwd, Bs.worktree.cwd); assert.ok(ds.pid > 0);
  assert.ok((await get('/api/plan/jetable/session/B/messages')).messages.some((m) => m.role === 'system' && m.text.includes(dev.body.url)), 'the chat says where it runs');

  // stop: a worktree with its session alive is refused; the session stops, comes back; stop-all stops it and the dev server
  let x = await post('/api/running/stop', { kind: 'worktree', plan: 'jetable', session: 'B' }); assert.equal(x.status, 400); assert.match(x.body.error, /tourne encore/);
  assert.deepEqual((await post('/api/running/stop', { kind: 'session', plan: 'jetable', session: 'B' })).body, { ok: true });
  assert.equal((await sessionOf('B')).mode, null);
  assert.equal((await post('/api/running/stop', { kind: 'session', plan: 'jetable', session: 'B' })).status, 400, 'nothing left to stop');
  assert.equal((await post('/api/running/stop', { kind: 'nope', plan: 'jetable', session: 'B' })).status, 400);
  assert.deepEqual((await post('/api/plan/jetable/session/B/resume')).body, { ok: true });
  const all = await post('/api/running/stop-all');
  assert.equal(all.body.ok, true); assert.deepEqual(all.body.stopped.map((s) => s.kind).sort(), ['devserver', 'session']);
  await assert.rejects(fetch(dev.body.url), 'the dev server is gone');
  run = await get('/api/running'); assert.deepEqual(kinds(run.ours), ['worktree:jetable/B']);
  assert.equal((await sessionOf('B')).open.url, null);
  // the worktree: refused while it holds changes not committed (the dev project), removed once clean, the branch kept
  x = await post('/api/running/stop', { kind: 'worktree', plan: 'jetable', session: 'B' }); assert.equal(x.status, 400); assert.match(x.body.error, /non commités/);
  assert.ok(existsSync(Bs.worktree.path));
  rmSync(path.join(Bs.worktree.cwd, 'package.json')); rmSync(path.join(Bs.worktree.cwd, 'dev.js'));
  assert.deepEqual((await post('/api/running/stop', { kind: 'worktree', plan: 'jetable', session: 'B' })).body, { ok: true });
  assert.ok(!existsSync(Bs.worktree.path)); assert.equal(sh(root, ['branch', '--list', 'calmdev/jetable/B']), 'calmdev/jetable/B');
  assert.deepEqual((await get('/api/running')).ours, []);
  if (process.env.SHOW) writeFileSync(process.env.SHOW, JSON.stringify(await get('/api/plan/jetable'), null, 1));
  assert.equal(S1.err.trim(), '', S1.err);
});

test('the server listens on 127.0.0.1 by default, on 0.0.0.0 with ESCADRILLE_HOST, as server.address() says', async () => {
  // S1 is the default: its start line is built from server.address()
  await S1.ready();
  assert.match(S1.out, /listening on 127\.0\.0\.1 only/);
  const S3 = boot('ouvert', { ESCADRILLE_HOST: '0.0.0.0' });
  try { await S3.ready(); await until(() => /listening on/.test(S3.out)); assert.match(S3.out, /listening on 0\.0\.0\.0 \(LAN open/); }
  finally { S3.stop(); }
});

test('a climbing context: the alert at 60 %, the handoff at 75 %, a fresh session on the same branch, the budget alert and the cap, dismiss', async () => {
  const { get, post, sessionOf, events } = S2;
  await S2.ready();
  // the fake reads 2 + 250 k + 110 tokens of a 1000-token window at turn k: 0.36, 0.61, 0.86, then 1; and spends 0.01 $ per turn
  const plan = { id: 'montee', title: 'Montée', network: ['example.com'], sessions: [{ id: 'H', name: 'Haute', path: root2, model: 'claude-sonnet-5-5', stops: ['La fin'], prompt: 'Relis tout.', budget: 0.06 }] };
  assert.equal((await post('/api/plan', plan)).status, 200);
  let r = await get('/api/plan/montee');
  assert.equal((await post('/api/project/domain', { project: r.plan.project, host: 'example.com' })).status, 200); // the project's list opens, the plan announces
  assert.deepEqual(r.plan.network, ['example.com']); assert.equal(r.plan.sessions[0].budget, 0.06); assert.equal(r.state[0].budget, 0.06);
  assert.deepEqual((await post('/api/launch', { plan: 'montee' })).body, { ok: true, launched: ['H'], queued: [] });
  const args = await argsOf(S2);
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '0.06');
  assert.deepEqual(settingsOf(args).sandbox.network.allowedDomains, ['example.com'], "the project's domains open the sandbox");
  const waiting = async () => until(async () => { const s = await sessionOf('H'); return s.status === 'waiting' ? s : null; });
  const send = async (text) => { assert.deepEqual((await post('/api/plan/montee/session/H/message', { text })).body, { ok: true }); };

  // turn 1: 36 % of the window, nothing; the reply carries the summary of the state block
  let H = await waiting();
  assert.equal(H.usage.context, 0.362); assert.equal(H.sessionId, 'sess-9');
  assert.deepEqual(H.pending.map((p) => p.kind), ['reply']); assert.equal(H.pending[0].summary, 'Fait : tour 1\nReste : la suite'); assert.equal(H.summary, 'Fait : tour 1\nReste : la suite');
  // turn 2: 61 %, the context alert, once
  await send('Encore'); H = await waiting();
  assert.equal(H.usage.context, 0.612);
  const alert = H.pending.find((p) => p.kind === 'alert');
  assert.deepEqual({ what: alert.what, pct: alert.pct, text: alert.text }, { what: 'context', pct: 0.612, text: 'Contexte : 61 % de la fenêtre' });
  assert.ok(alert.id && alert.at);
  assert.deepEqual(H.pending.map((p) => p.kind), ['alert', 'reply']);
  assert.ok(events.filter((e) => e.event === 'pending' && e.data.session === 'H').length >= 2, 'the SSE pending went out');
  // dismiss: the alert goes, an unknown id is refused
  assert.deepEqual((await post('/api/plan/montee/session/H/dismiss', { id: alert.id })).body, { ok: true });
  H = await sessionOf('H'); assert.deepEqual(H.pending.map((p) => p.kind), ['reply']);
  assert.equal((await post('/api/plan/montee/session/H/dismiss', { id: 'nope' })).status, 400);

  // turn 3: 86 %: the handoff is asked (one more turn, no reply pending), the fake writes the file; the server
  // stops the process and starts a fresh one whose prompt begins with the handoff text and ends with the original prompt
  await send('Encore');
  H = await until(async () => { const s = await sessionOf('H'); return s.handoffs.length ? s : null; });
  assert.equal(H.handoffs.length, 1);
  const h = H.handoffs[0];
  assert.equal(h.n, 1); assert.equal(h.file, path.join(root2, '.claude', 'worktrees', 'montee-H', '.calmdev', 'passation.md'));
  assert.match(h.text, /^Fait : les tours 1 à 3 de la session sess-9\./); assert.ok(h.at);
  assert.ok(!existsSync(h.file), 'the handoff file is read once and removed');
  // (the fresh process may already have finished its first turn: only the info entry is certain here)
  assert.deepEqual(H.pending.filter((p) => p.kind === 'info').map((p) => p.text), ['Passation n°1 faite, session fraîche relancée']);
  assert.ok(!H.pending.some((p) => p.kind === 'alert' && p.what === 'context'), 'the context alert left with the handoff');
  assert.ok(events.some((e) => e.event === 'pending' && e.data.session === 'H'));
  r = await get('/api/plan/montee');
  assert.ok(r.log.some((l) => /Passation n°1 demandée \(contexte 86 %\)/.test(l.claude)), 'the journal has the request');
  assert.ok(r.log.some((l) => /Passation n°1 faite \(contexte 86 %\), session fraîche relancée/.test(l.claude)), 'the journal has the handoff');
  // the fresh process: a new session id, no --resume, the handoff then the original prompt
  H = await waiting();
  assert.equal(H.sessionId, 'sess-10'); assert.equal(H.usage.context, 0.362, 'a fresh window');
  const fresh = await argsOf(S2); assert.ok(!fresh.includes('--resume'));
  const prompts = readFileSync(path.join(S2.fake.dir, 'prompts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const last = prompts[prompts.length - 1];
  assert.equal(last.session_id, 'sess-10');
  assert.match(last.text, /^# Passation n°1, laissée par la session précédente\n\nFait : les tours 1 à 3 de la session sess-9\./);
  assert.match(last.text, /# Le prompt d'origine\n\nRelis tout\.\n\n## Suivi/);
  assert.match(prompts[prompts.length - 2].text, /passation\.md/, 'the previous process got the handoff request');
  // the cost carries over: 0.04 before, 0.01 in the fresh process → 0.05 of 0.06, the budget alert; one turn more hits the cap
  assert.equal(H.usage.cost, 0.05);
  const budget = H.pending.find((p) => p.kind === 'alert' && p.what === 'budget');
  assert.ok(budget, 'the budget alert'); assert.equal(budget.text, 'Budget : 0,05 $ sur 0,06 $ (83 %)'); assert.ok(Math.abs(budget.pct - 0.8333) < 0.001);
  await send('Encore'); H = await waiting();
  assert.equal(H.usage.cost, 0.06); assert.equal(H.mode, null, 'the process is stopped at the cap');
  assert.equal(H.pending.filter((p) => p.kind === 'alert' && p.what === 'budget').length, 1, 'the budget alert sounds once');
  const msgs = (await get('/api/plan/montee/session/H/messages')).messages;
  assert.ok(msgs.some((m) => m.role === 'system' && /Plafond de 0,06 \$ atteint/.test(m.text)));
  assert.equal(S2.err.trim(), '', S2.err);
});
