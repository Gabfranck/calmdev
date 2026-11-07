// The connectors (docs/connectors.md): GitHub through a fake gh (test/fake-gh.mjs), Linear through a fake GraphQL
// server on 127.0.0.1, the push towards a bare repository on disk. Nothing leaves the Mac; nothing is called
// before the click; the Linear key never comes back.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, statSync, rmSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../lib/sqlite.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeGh, fakeLinear, LINEAR_KEY, PR_URL } from './fake-gh.mjs';
import { fakeClaude } from './fake-claude.mjs';
import { validatePlan } from '../lib/blocks.mjs';
import * as secrets from '../lib/secrets.mjs';
import * as worktree from '../lib/worktree.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };

const gh = fakeGh(); const lin = await fakeLinear();
process.env.ESCADRILLE_LINEAR_URL = lin.url;
const linear = await import('../lib/linear.mjs');

// A throwaway repository whose origin is a bare repository on disk
const origin = tmp('escadrille-origin-'); sh(origin, ['init', '-q', '--bare']);
const root = tmp('escadrille-con-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']);
writeFileSync(path.join(root, 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); sh(root, ['remote', 'add', 'origin', origin]);

const SECRETS = path.join(tmp('escadrille-secrets-'), 'escadrille', 'secrets.json');
const DB = path.join(tmp('escadrille-db-'), 'db.sqlite');
const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: DB, ESCADRILLE_PLANS: tmp('escadrille-plans-'), ESCADRILLE_CLAUDE: fakeClaude().file, ESCADRILLE_GH: gh.file, ESCADRILLE_LINEAR_URL: lin.url, ESCADRILLE_SECRETS: SECRETS, ESCADRILLE_PUSH_URL: 'http://127.0.0.1:9/', ESCADRILLE_GH_TICK_MS: '3600000' }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; server.stdout.on('data', (d) => { logs += d; }); server.stderr.on('data', (d) => { logs += d; });
after(() => { server.kill('SIGINT'); lin.close(); });
const get = async (p) => (await fetch(BASE + p)).json();
const post = async (p, body) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
const q = encodeURIComponent;
// A session made done by hand: its worktree, one commit in it, its summary
const finish = async (sid, { remove = false } = {}) => {
  const w = await worktree.create({ root, plan: 'pr', session: sid, path: root });
  writeFileSync(path.join(w.path, `${sid}.txt`), sid + '\n'); sh(w.path, ['add', '.']); sh(w.path, ['commit', '-qm', 'work ' + sid]);
  if (remove) await worktree.remove({ root, path: w.path });
  const db = openDatabase(DB);
  db.prepare("update sessions set status = 'done', worktree = ?, summary = ? where plan = 'pr' and id = ?").run(JSON.stringify({ ...w, root, merged: remove }), `Fait : la session ${sid}, PR prête.\nReste : rien.`, sid);
  db.close();
  return w;
};

test('validatePlan: base and tickets accepted, a ticket badly formed refused, unknown fields kept as given', () => {
  const s = { id: 'A', name: 'a', path: '/x', stops: ['fin'], prompt: 'p', tickets: ['ORC-88', 'ORC-88', 'OPS2-3'], autonomy: { kind: 'x' } };
  const { plan, errors } = validatePlan({ title: 'T', base: 'develop', extra: 'guided', sessions: [s] });
  assert.equal(errors, undefined);
  assert.equal(plan.base, 'develop'); assert.deepEqual(plan.sessions[0].tickets, ['ORC-88', 'OPS2-3']);
  assert.equal(plan.extra, 'guided'); assert.deepEqual(plan.sessions[0].autonomy, { kind: 'x' }, 'unknown fields stay');
  assert.equal(validatePlan({ title: 'T', sessions: [{ ...s, tickets: undefined }] }).plan.base, undefined, 'no base: the worktree’s');
  for (const bad of [['ago-88'], ['AGO88'], ['AGO-'], [''], 'ORC-88']) assert.match(validatePlan({ title: 'T', sessions: [{ ...s, tickets: bad }] }).errors.join(), /ticket/, JSON.stringify(bad));
  assert.match(validatePlan({ title: 'T', base: '--force', sessions: [s] }).errors.join(), /base/);
  assert.match(validatePlan({ title: 'T', sessions: [{ ...s, stops: [] }] }).errors.join(), /au moins un arrêt/);
});

test('secrets: a 0600 file in a 0700 folder, per project, cleared', () => {
  const file = path.join(tmp('escadrille-sec-'), 'd', 'secrets.json');
  assert.equal(secrets.get('/p', 'linear', file), null);
  secrets.set('/p', 'linear', ' k1 ', file); secrets.set('/q', 'linear', 'k2', file);
  assert.equal(secrets.get('/p', 'linear', file), 'k1');
  assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
  secrets.clear('/p', 'linear', file);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { '/q': { linear: 'k2' } });
  assert.throws(() => secrets.set('/p', 'linear', '  ', file), /non vide/);
});

test('linear: the key in Authorization, the state found by name, « In Review » as fallback, the names listed otherwise', async () => {
  assert.deepEqual(await linear.viewer(LINEAR_KEY), { id: 'u1', name: 'Dev', email: 'dev@example.com' });
  assert.equal(lin.requests.at(-1).auth, LINEAR_KEY);
  await assert.rejects(linear.viewer('lin_api_BAD'), (e) => /clé refusée/.test(e.message) && !e.message.includes('BAD'));
  assert.deepEqual((await linear.listIssues({ key: LINEAR_KEY, project: 'Orchard' }))[0], { identifier: 'ORC-88', title: 'Ticket ORC-88' });
  assert.deepEqual(await linear.issueByIdentifier({ key: LINEAR_KEY, identifier: 'OPS-3' }), { id: 'uuid-OPS-3', identifier: 'OPS-3', title: 'Ticket OPS-3', state: 'Todo', stateType: 'unstarted', team: { id: 't2', key: 'OPS' } });
  assert.deepEqual(await linear.moveToState({ key: LINEAR_KEY, identifier: 'OPS-3' }), { identifier: 'OPS-3', state: 'In Review' });
  assert.deepEqual(await linear.moveToState({ key: LINEAR_KEY, identifier: 'ORC-91', stateName: 'a revoir' }), { identifier: 'ORC-91', state: 'À revoir' }, 'accents and case aside');
  await assert.rejects(linear.moveToState({ key: LINEAR_KEY, identifier: 'RAW-1', stateName: 'QA' }), /aucun statut « QA » dans l’équipe RAW ; statuts : Backlog, Done/);
  await assert.rejects(linear.issueByIdentifier({ key: LINEAR_KEY, identifier: 'ZZZ-1' }), /introuvable|not found/);
  await assert.rejects(linear.comment({ key: LINEAR_KEY, identifier: 'bad', body: 'x' }), /ORC-88/);
  assert.deepEqual((await linear.comment({ key: LINEAR_KEY, identifier: 'ORC-91', body: 'hello' })).ok, true);
});

test('the PR flow: nothing called before the click, the key never returned, push + PR + tickets, a second click redoes nothing', async () => {
  await until(async () => { try { return await get('/api/plans'); } catch { return null; } });
  const plan = { id: 'pr', title: 'PR', sessions: [
    { id: 'A', name: 'Les connecteurs', path: root, model: 'claude-sonnet-5-5', stops: ['fin'], prompt: 'p', tickets: ['ORC-88', 'RAW-1'] },
    { id: 'B', name: 'Déjà ouverte', path: root, model: 'claude-sonnet-5-5', stops: ['fin'], prompt: 'p' },
    { id: 'C', name: 'Déconnecté', path: root, model: 'claude-sonnet-5-5', stops: ['fin'], prompt: 'p' }] };
  assert.equal((await post('/api/plan', plan)).status, 200);
  assert.equal((await post('/api/plan', { ...plan, id: 'bad', sessions: [{ ...plan.sessions[0], tickets: ['ago-88'] }] })).status, 400, 'a ticket badly formed is refused');
  // the key: stored outside the database, said present, never returned
  let r = await post('/api/project/settings', { project: root, linearKey: LINEAR_KEY, linearState: 'À revoir' });
  assert.equal(r.status, 200); assert.deepEqual(r.body.settings.linear, { key: true, state: 'À revoir', sync: true });
  assert.ok(!JSON.stringify(r.body).includes(LINEAR_KEY));
  const st = await get(`/api/project/settings?project=${q(root)}`);
  assert.deepEqual(st.linear, { key: true, state: 'À revoir', sync: true }); assert.ok(st.stored.includes('linearState'));
  assert.equal(JSON.parse(readFileSync(SECRETS, 'utf8'))[root].linear, LINEAR_KEY); assert.equal(statSync(SECRETS).mode & 0o777, 0o600);
  assert.ok(!readFileSync(DB).includes(LINEAR_KEY), 'never in the database');
  assert.equal((await post('/api/project/settings', { project: root, linearKey: 42 })).status, 400);
  const access = await get(`/api/access?project=${q(root)}`);
  assert.deepEqual(access.extensions.connectors.map((c) => [c.name, c.key]), [['GitHub', false], ['Linear', true]]);
  assert.ok(!JSON.stringify(access).includes(LINEAR_KEY));
  // a session not done: refused; nothing called by the boot, the GETs or the refusal
  assert.match((await post('/api/plan/pr/session/A/pr')).body.error, /pas finie/);
  assert.equal((await get('/api/plan/pr')).state.find((s) => s.id === 'A').pr, null);
  const linBefore = lin.requests.length;
  assert.deepEqual(gh.calls(), []);
  // the click
  const w = await finish('A');
  r = await post('/api/plan/pr/session/A/pr');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.ok, r.body.pr.url, r.body.pr.number, r.body.pr.base, r.body.pr.head], [true, PR_URL, 7, 'main', w.branch]);
  assert.deepEqual(r.body.tickets.map((t) => [t.identifier, t.state, t.ok]), [['ORC-88', 'À revoir', true], ['RAW-1', null, false]]);
  assert.match(r.body.tickets[1].error, /statuts : Backlog, Done/);
  assert.equal(sh(origin, ['rev-parse', w.branch]), sh(root, ['rev-parse', w.branch]), 'the branch pushed to origin');
  const create = gh.calls().find((c) => c.args[1] === 'create');
  assert.deepEqual(create.args.slice(0, 8), ['pr', 'create', '--base', 'main', '--head', w.branch, '--title', 'Les connecteurs']);
  assert.match(create.args[9], /PR prête\.[\s\S]*Plan calmdev pr, session A/);
  const sent = lin.requests.slice(linBefore);
  assert.ok(sent.every((x) => x.auth === LINEAR_KEY));
  assert.deepEqual(sent.find((x) => /issueUpdate/.test(x.query)).variables, { id: 'uuid-ORC-88', s: 't1-2' });
  assert.match(sent.find((x) => /commentCreate/.test(x.query)).variables.b, new RegExp(PR_URL));
  const msgs = (await get('/api/plan/pr/session/A/messages')).messages.filter((m) => m.role === 'system').map((m) => m.text);
  assert.deepEqual(msgs.slice(0, 3), [`Branche poussée : ${w.branch}`, `PR ouverte : ${PR_URL}`, 'ORC-88 → À revoir']);
  assert.match(msgs[3], /^RAW-1 : Linear : aucun statut/);
  // kept: GET /api/plan gives it, a second click redoes nothing
  const kept = (await get('/api/plan/pr')).state.find((s) => s.id === 'A').pr;
  assert.equal(kept.url, PR_URL); assert.equal(kept.tickets.length, 2);
  const nGh = gh.calls().length; const nLin = lin.requests.length;
  const again = await post('/api/plan/pr/session/A/pr');
  assert.deepEqual(again.body, r.body);
  assert.deepEqual([gh.calls().length, lin.requests.length], [nGh, nLin], 'nothing called again');
  // the state, refreshed on demand
  const fresh = await get('/api/plan/pr/session/A/pr');
  assert.deepEqual([fresh.pr.state, fresh.pr.merged, fresh.pr.reviewDecision], ['OPEN', false, 'REVIEW_REQUIRED']);
  assert.deepEqual(gh.calls().at(-1).args, ['pr', 'view', '7', '--json', 'state,mergedAt,url,reviewDecision']);
  assert.ok(!logs.includes(LINEAR_KEY), 'never logged');
});

test('a PR already open gives its URL; a merged session pushes from the repository; gh signed out says so', async () => {
  await until(async () => (await get('/api/plan/pr')).state.length === 3);
  const w = await finish('B', { remove: true });
  assert.ok(!existsSync(w.path));
  gh.setMode('exists');
  const r = await post('/api/plan/pr/session/B/pr');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.pr.url, r.body.pr.number, r.body.tickets], [PR_URL, 7, []]);
  assert.deepEqual(gh.calls().at(-1).args, ['pr', 'list', '--head', w.branch, '--state', 'open', '--json', 'url,number']);
  assert.equal(gh.calls().at(-1).cwd, root, 'from the repository, the worktree being gone');
  assert.ok((await get('/api/plan/pr/session/B/messages')).messages.some((m) => m.text === `PR déjà ouverte : ${PR_URL}`));
  await finish('C');
  gh.setMode('unauth');
  const c = await post('/api/plan/pr/session/C/pr');
  assert.equal(c.status, 400); assert.match(c.body.error, /gh n’est pas connecté : lance gh auth login/);
  assert.equal((await get('/api/plan/pr')).state.find((s) => s.id === 'C').pr, null, 'nothing kept on a failure');
  assert.match((await get('/api/plan/pr/session/C/pr')).error, /aucune PR/);
  gh.setMode('');
  rmSync(path.join(root, '.claude', 'worktrees', 'pr-C'), { recursive: true, force: true }); sh(root, ['worktree', 'prune']); sh(root, ['branch', '-D', 'calmdev/pr/C']);
  assert.match((await post('/api/plan/pr/session/C/pr')).body.error, /n’existe plus/);
});

// The Linear sync through the server (docs/connectors.md « La synchro »): the setting, a launch that moves the named ticket to
// In Progress, a merge that comments once (twice merged, one comment), the kept PR seen merged in production, the key nowhere
test('the sync: setting on by default, off and on again; launch → In Progress; merge → one state comment; PR merged in production → one comment', async () => {
  let st = await get(`/api/project/settings?project=${q(root)}`);
  assert.deepEqual(st.linear, { key: true, state: 'À revoir', sync: true }, 'on by default with a key');
  let r = await post('/api/project/settings', { project: root, linearSync: false });
  assert.equal(r.body.settings.linear.sync, false); assert.ok(r.body.settings.stored.includes('linearSync'));
  assert.equal((await post('/api/project/settings', { project: root, linearSync: 'oui' })).status, 400);
  r = await post('/api/project/settings', { project: root, linearSync: null }); assert.equal(r.body.settings.linear.sync, true); assert.ok(!r.body.settings.stored.includes('linearSync'));
  // the launch: the ticket named in the session's name moves to the team's started state
  const plan = { id: 'sync', title: 'Sync', project: root, sessions: [{ id: 'S', name: 'Le score ORC-5', path: root, model: 'claude-sonnet-5-5', stops: ['fin'], prompt: 'p' }] };
  assert.equal((await post('/api/plan', plan)).status, 200);
  const before = lin.requests.length;
  const launched = await post('/api/launch', { plan: 'sync', session: 'S' }); assert.deepEqual([launched.status, launched.body.launched], [200, ['S']], JSON.stringify(launched.body));
  const moved = await until(() => lin.requests.slice(before).find((x) => /issueUpdate/.test(x.query) && x.variables.id === 'uuid-ORC-5'));
  assert.equal(moved.variables.s, 't1-1', 'Todo → In Progress'); assert.equal(lin.stateName('ORC-5'), 'In Progress');
  // the merge: the session made done by hand, merged twice, one comment of state and cost
  await until(async () => (await get('/api/plan/sync')).state.find((x) => x.id === 'S')?.worktree?.branch);
  const dbw = openDatabase(DB); dbw.prepare("update sessions set status = 'done', summary = ?, usage = ? where plan = 'sync' and id = 'S'").run('Fait : le score.\nReste : la capture.', JSON.stringify({ input: 1, output: 1, cost: 1.5 })); dbw.close();
  const n0 = (lin.comments['ORC-5'] || []).length;
  const m = await post('/api/plan/sync/session/S/merge'); assert.equal(m.status, 200, JSON.stringify(m.body));
  await until(() => (lin.comments['ORC-5'] || []).length > n0);
  assert.match(lin.comments['ORC-5'].at(-1).body, /^État au \d+ \w+ \d{4} \(calmdev\) : le score\. Reste : la capture\. Coût ≈ 1,50 \$\.\n\nSession S du plan sync, fusionnée dans la base du plan\.$/);
  assert.equal((await post('/api/plan/sync/session/S/merge')).status, 200, 'a second merge');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(lin.comments['ORC-5'].length, n0 + 1, 'still one comment');
  assert.equal(lin.stateName('ORC-5'), 'In Progress', 'never Done');
  // the kept PR of session A (base main) seen merged: one production comment per ticket, once
  gh.setMode('merged');
  const fresh = await get('/api/plan/pr/session/A/pr'); assert.equal(fresh.pr.merged, true);
  await until(() => (lin.comments['ORC-88'] || []).some((c) => /Fusionné en production/.test(c.body)));
  assert.deepEqual(lin.comments['ORC-88'].filter((c) => /production/.test(c.body)).map((c) => c.body), [`Fusionné en production par la PR ${PR_URL} (calmdev).`]);
  await get('/api/plan/pr/session/A/pr'); await new Promise((r) => setTimeout(r, 300));
  assert.equal(lin.comments['ORC-88'].filter((c) => /production/.test(c.body)).length, 1, 'seen again: nothing');
  gh.setMode('');
  assert.ok(!logs.includes(LINEAR_KEY), 'never logged');
  const acts = (await get(`/api/pilot/log?project=${q(root)}`)).actions || [];
  assert.ok(!JSON.stringify(acts).includes(LINEAR_KEY));
});

test('phase 16 GH on the server: the PRs of a project with their session, the merge refused without the page cookie', async () => {
  gh.setMode('');
  const r = await get(`/api/github/prs?project=${q(root)}`);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.prs[0].number, 7); assert.equal(r.prs[0].session.planId, 'pr');
  const one = await get(`/api/github/pr/7?project=${q(root)}`);
  assert.deepEqual([one.ok, one.mergeBlock, one.failedLog], [true, null, null]);
  const n = gh.calls().length;
  for (const cookie of [null, 'escadrille_guard=forged']) {
    const res = await fetch(BASE + '/api/github/pr/7/merge', { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ project: root }) });
    assert.equal(res.status, 403, 'a session on 127.0.0.1 cannot merge');
  }
  assert.ok(!gh.calls().slice(n).some((c) => c.args[1] === 'merge'), 'gh pr merge never called');
});
