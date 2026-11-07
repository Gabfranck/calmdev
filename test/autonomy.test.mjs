// The autonomy (docs/autonomy.md): lib/autonomy.mjs alone, then the three modes played against the fake claude on a
// spare port with a throwaway database and repo, ESCADRILLE_FALLBACK_MIN=0: the fallback of a data stop sent alone,
// a taste stop that waits, the permissions the local rule answers, the guarded paths that hold the merge and the
// next wave, the merge if tests are green, and the weekly quota at 100 % that refuses a start.
import { freePort } from './free-port.mjs';
import { plain } from '../lib/i18n.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fakeClaude } from './fake-claude.mjs';
import * as A from '../lib/autonomy.mjs';
import { shouldPush } from '../lib/push.mjs';
import { validatePlan, stopTitle } from '../lib/blocks.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const repo = () => { const root = tmp('escadrille-auto-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); writeFileSync(path.join(root, 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root; };
const until = async (fn, ms = 40000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 140)); await new Promise((r) => setTimeout(r, 150)); } };
const servers = [];
after(() => { for (const s of servers) s.kill('SIGKILL'); });

const boot = (turns) => {
  const PORT = freePort(); const base = `http://127.0.0.1:${PORT}`;
  const S = { fake: fakeClaude(), plans: tmp('escadrille-plans-'), db: path.join(tmp('escadrille-db-'), 'db.sqlite'), empty: tmp('escadrille-none-'), keys: tmp('escadrille-keys-') };
  S.proc = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', ESCADRILLE_GUARD_DIR: S.keys, PORT: String(PORT), ESCADRILLE_DB: S.db, ESCADRILLE_PLANS: S.plans, ESCADRILLE_CLAUDE: S.fake.file, ESCADRILLE_TRANSCRIPTS: S.empty, ESCADRILLE_SESSIONS: S.empty, ESCADRILLE_FALLBACK_MIN: '0', ESCADRILLE_TESTBOX: 'none', FAKE_CLAUDE_TURNS: JSON.stringify(turns) }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(S.proc); S.err = ''; S.proc.stderr.on('data', (d) => { S.err += d; });
  S.get = async (p) => (await fetch(base + p)).json();
  S.post = async (p, body, headers = {}) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  // the browser's key: the link of guard-link hands it as a cookie (every agreement « à relire » asks it)
  S.cookie = async () => { const k = new URL(readFileSync(path.join(S.keys, 'guard-link'), 'utf8').trim()).searchParams.get('k'); const r = await fetch(base + '/guard?k=' + k, { redirect: 'manual' }); return r.headers.get('set-cookie').split(';')[0]; };
  S.ready = () => until(async () => { try { await S.get('/api/plans'); return true; } catch { return false; } });
  S.session = async (plan, id) => (await S.get(`/api/plan/${plan}`)).state.find((s) => s.id === id);
  S.messages = async (plan, id) => (await S.get(`/api/plan/${plan}/session/${id}/messages`)).messages;
  S.prompts = () => { try { return readFileSync(path.join(S.fake.dir, 'prompts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
  return S;
};
const sess = (root, extra) => ({ name: 's', path: root, model: 'claude-sonnet-5-5', prompt: 'Travaille.', budget: 1, ...extra });

test('the setting: defaults, validation field by field, and a plan that may only get stricter', () => {
  assert.deepEqual(A.validateAutonomy(undefined).value, { ...A.DEFAULTS });
  assert.deepEqual(A.validateAutonomy({ mode: 'guide', quietHours: { from: '22:00', to: '07:00' } }).value.quietHours, { from: '22:00', to: '07:00' });
  for (const bad of [{ mode: 'x' }, { waitKinds: ['goût'] }, { guardedPaths: [''] }, { planCapUsd: -1 }, { askAboveUsd: 'x' }, { autoMergeIfGreen: 1 }, { quietHours: { from: '25:00', to: '07:00' } }, { notifyLevel: 'some' }, { fallbackDelayMin: -2 }, { other: 1 }, 'guide'])
    assert.ok(A.validateAutonomy(bad).errors, JSON.stringify(bad));
  const cur = A.validateAutonomy({ mode: 'guide', planCapUsd: 10 }).value; const v = (x) => A.validateAutonomy({ ...cur, ...x }).value;
  assert.deepEqual(A.hardenErrors(cur, v({ mode: 'surveille', planCapUsd: 5, fallbackDelayMin: 30, guardedPaths: [...cur.guardedPaths, 'infra/**'], waitKinds: A.KINDS })), []);
  for (const soft of [{ mode: 'autonome' }, { planCapUsd: 11 }, { planCapUsd: null }, { askAboveUsd: 50 }, { fallbackDelayMin: 1 }, { guardedPaths: ['.github/**'] }, { waitKinds: ['security'] }, { autoMergeIfGreen: true, testCommand: 'true' }, { stopAtQuotaLimit: false }])
    assert.ok(A.hardenErrors(cur, v(soft)).length, JSON.stringify(soft));
  // the stops: a string or { title, kind, fallback }
  const { plan } = validatePlan({ title: 'T', autonomy: { mode: 'autonome' }, sessions: [{ id: 'A', name: 'a', path: '/x', prompt: 'p', stops: ['Fin', { title: 'Le schéma', kind: 'data', fallback: 'Garde-le.' }] }] });
  assert.deepEqual(plan.sessions[0].stops, ['Fin', { title: 'Le schéma', kind: 'data', fallback: 'Garde-le.' }]); assert.equal(plan.autonomy.mode, 'autonome');
  assert.equal(stopTitle(plan.sessions[0].stops[1]), 'Le schéma');
  assert.match(validatePlan({ title: 'T', sessions: [{ id: 'A', name: 'a', path: '/x', prompt: 'p', stops: [{ title: 'x', kind: 'goût' }] }] }).errors.join(), /genre inconnu/);
  assert.match(validatePlan({ title: 'T', delivery: 'zip', sessions: [{ id: 'A', name: 'a', path: '/x', prompt: 'p', stops: ['x'] }] }).errors.join(), /delivery/);
});

test('waitsForHuman for the three modes and the six kinds; decidePermission; the globs, quiet hours, notify level, quota', () => {
  const expect = { surveille: A.KINDS, guide: ['taste', 'security', 'release'], autonome: ['security', 'release'] };
  for (const mode of A.MODES) for (const kind of A.KINDS) assert.equal(A.waitsForHuman({ mode, stop: { title: 't', kind, fallback: 'Continue.' } }), expect[mode].includes(kind), `${mode}/${kind}`);
  for (const mode of A.MODES) assert.equal(A.waitsForHuman({ mode, stop: { title: 't', kind: 'data' } }), true, 'no fallback: waits');
  assert.equal(A.waitsForHuman({ mode: 'autonome', waitKinds: ['data'], stop: { title: 't', kind: 'data', fallback: 'x' } }), true, 'waitKinds replaces the mode’s list');
  assert.equal(A.waitsForHuman({ mode: 'autonome', stop: 'Fin' }), true, 'a string: info without fallback');
  for (const [mode, allow, out] of [['surveille', true, 'wait'], ['guide', true, 'allow'], ['guide', false, 'deny'], ['autonome', null, 'wait'], ['autonome', true, 'allow']]) assert.equal(A.decidePermission({ mode, suggest: allow === null ? null : { allow } }), out);
  const plan = { autonomy: { ...A.DEFAULTS, mode: 'guide', fallbackDelayMin: 2 } }; const session = { stops: [{ title: 'a', kind: 'taste', fallback: 'x' }, { title: 'b', kind: 'data', fallback: 'Garde.' }] };
  assert.equal(A.decideReply({ plan, session, pending: { stop: 0 } }).action, 'wait');
  assert.deepEqual(A.decideReply({ plan, session, pending: { stop: 1 } }), { action: 'fallback', text: 'Garde.', afterMs: 120000, kind: 'data' });
  assert.equal(A.decideReply({ plan, session, pending: { stop: null } }).action, 'wait');
  assert.deepEqual(A.guardedFiles(['.env', 'app/.env.local', '.github/workflows/ci.yml', 'db/migrations/1.sql', 'src/a.js'], A.DEFAULTS.guardedPaths), ['.env', '.github/workflows/ci.yml', 'app/.env.local', 'db/migrations/1.sql']);
  const at = (h, m) => new Date(2026, 10, 1, h, m);
  assert.equal(A.inQuietHours({ from: '22:00', to: '07:00' }, at(23, 30)), true); assert.equal(A.inQuietHours({ from: '22:00', to: '07:00' }, at(12, 0)), false);
  assert.equal(shouldPush({ level: 'all', quietHours: { from: '22:00', to: '07:00' }, kind: 'waiting', now: at(3, 0) }), false, 'quiet hours hold a push');
  assert.equal(shouldPush({ level: 'waiting', kind: 'waiting', now: at(12, 0) }), true);
  assert.equal(shouldPush({ level: 'waiting', kind: 'done', now: at(12, 0) }), false);
  assert.equal(shouldPush({ level: 'none', kind: 'permission', now: at(12, 0) }), false);
  assert.match(plain(A.quotaRefusal(1, new Date(Date.now() + 864e5).toISOString())), /Quota hebdo à 100 %/);
  assert.equal(A.quotaRefusal(1, new Date(Date.now() - 1000).toISOString()), null, 'the reset passed');
  assert.equal(A.quotaRefusal(0.8, null), null);
  const tomorrow = new Date(Date.now() + 864e5).toISOString();
  assert.equal(A.quotaRefusal(1, tomorrow, Date.now(), { overage: { status: 'allowed', using: true } }), null, 'extra usage allowed: Anthropic limits, not Escadrille');
  assert.match(plain(A.quotaRefusal(1, tomorrow, Date.now(), { overage: { status: 'rejected' } })), /Quota hebdo à 100 %/, 'extra usage refused: the stop holds');
  assert.equal(plain(A.summaryLine({ ...A.DEFAULTS, mode: 'guide' })), 'Guidé · 3 domaines sous garde · fusion auto éteinte');
});

test('Guidé: the taste stop waits, the data stop gets its fallback alone; the plan only hardens', async () => {
  const S = boot([{ stops: [0], claude: 'Le design' }, { stops: [0, 1], claude: 'Le schéma' }, { stops: [0, 1, 2], claude: 'Fini', done: true }]); await S.ready();
  const root = repo();
  assert.equal((await S.post('/api/project/settings', { project: root, autonomy: { mode: 'guide' } })).status, 200);
  const stops = [{ title: 'Le design', kind: 'taste', fallback: 'Garde ce design.' }, { title: 'Le schéma', kind: 'data', fallback: 'Garde le schéma proposé et continue.' }, 'La fin'];
  assert.equal((await S.post('/api/plan', { id: 'guide', title: 'Guidé', sessions: [sess(root, { id: 'A', stops })] })).status, 200);
  const p = (await S.get('/api/plan/guide')).plan;
  assert.equal(p.autonomy.mode, 'guide', 'the project’s setting written into the plan'); assert.deepEqual(p.sessions[0].stops, ['Le design', 'Le schéma', 'La fin'], 'the views read titles');
  assert.equal(p.autonomyLine, 'Guidé · 3 domaines sous garde · fusion auto éteinte');
  assert.equal((await S.post('/api/plan/guide/settings', { autonomy: { mode: 'autonome' } })).status, 400);
  assert.equal((await S.post('/api/plan/guide/settings', { autonomy: { guardedPaths: [] } })).status, 400);
  assert.equal((await S.post('/api/plan/guide/settings', { autonomy: { guardedPaths: [...p.autonomy.guardedPaths, 'infra/**'] } })).status, 200);
  await S.post('/api/launch', { plan: 'guide' });
  // turn 1 reaches the taste stop: it waits, no fallback
  const w = await until(async () => { const s = await S.session('guide', 'A'); return s.status === 'waiting' ? s : null; });
  const reply = w.pending.find((x) => x.kind === 'reply'); assert.equal(reply.stop, 0); assert.equal(reply.fallbackAt, undefined);
  await new Promise((r) => setTimeout(r, 600)); assert.equal(S.prompts().length, 1, 'nothing sent for the taste stop');
  // the human answers; turn 2 reaches the data stop: the fallback leaves alone, after 0 min
  await S.post('/api/plan/guide/session/A/message', { text: 'Va.' });
  await until(() => S.prompts().length >= 3);
  assert.equal(S.prompts()[2].text, 'Garde le schéma proposé et continue.');
  const msgs = await S.messages('guide', 'A');
  const auto = msgs.find((m) => m.role === 'dev' && m.data?.auto); assert.ok(auto, 'the dev message carries data.auto'); assert.equal(auto.text, 'Garde le schéma proposé et continue.');
  assert.ok(msgs.some((m) => m.role === 'system' && /^Repli envoyé après 0 min \(Guidé\)/.test(m.text)));
  const done = await until(async () => { const s = await S.session('guide', 'A'); return s.status === 'done' ? s : null; });
  assert.ok(done.pending.some((x) => x.kind === 'info' && /Repli envoyé/.test(x.text)), 'an info entry in À faire');
  assert.ok((await S.get('/api/plan/guide')).log.some((l) => /Repli envoyé/.test(l.claude || '')), 'a line in the journal');
});

test('Autonome: a permission the rule allows is answered alone, one it is silent on waits', async () => {
  const S = boot([{ command: 'git status', stops: [0], claude: 'Statut' }, { command: 'frobnicate-xyz --go', stops: [0], claude: 'Inconnu' }]); await S.ready();
  const root = repo();
  // the project's setting is a ceiling: an Autonome plan in a Surveillé project is refused, then allowed once the project is Autonome
  assert.equal((await S.post('/api/plan', { id: 'auto', title: 'Auto', autonomy: { mode: 'autonome' }, sessions: [sess(root, { id: 'A' })] })).status, 400);
  assert.equal((await S.post('/api/project/settings', { project: root, autonomy: { mode: 'autonome' } })).status, 200);
  assert.equal((await S.post('/api/plan', { id: 'auto', title: 'Auto', autonomy: { mode: 'autonome' }, sessions: [sess(root, { id: 'A', stops: [{ title: 'Le statut', kind: 'info', fallback: 'Continue.' }, 'La fin'] })] })).status, 200);
  await S.post('/api/launch', { plan: 'auto' });
  // turn 1: git status answered alone; its info stop follows its fallback, turn 2 asks for an unknown tool and waits
  const w = await until(async () => { const s = await S.session('auto', 'A'); return s.pending.find((x) => x.kind === 'permission' && /frobnicate/.test(x.text)) ? s : null; });
  const msgs = await S.messages('auto', 'A');
  const ans = msgs.find((m) => m.role === 'system' && m.data?.auto && m.data.allow === true); assert.ok(ans, 'answered alone'); assert.match(ans.text, /Autorisé seul \(Autonome/);
  assert.equal(w.pending.find((x) => x.kind === 'permission').suggest, null, 'the rule says nothing: it waits');
  await new Promise((r) => setTimeout(r, 500)); assert.ok((await S.session('auto', 'A')).pending.some((x) => x.kind === 'permission'), 'still waiting');
});

test('a diff under .github/ holds the merge and the next wave until reviewed; delivery kit counts done as delivered', async () => {
  const S = boot([{ write: '.github/workflows/ci.yml', stops: [0], claude: 'CI', done: true }]); await S.ready();
  const root = repo();
  assert.equal((await S.post('/api/plan', { id: 'garde', title: 'Garde', delivery: 'kit', sessions: [sess(root, { id: 'A', stops: ['La CI'] }), sess(root, { id: 'B', wave: 2, stops: ['La suite'] })] })).status, 200);
  await S.post('/api/launch', { plan: 'garde' });
  const a = await until(async () => { const s = await S.session('garde', 'A'); return s.review ? s : null; });
  assert.deepEqual(a.review.files, ['.github/workflows/ci.yml']); assert.equal(a.review.seen, false);
  assert.ok(a.pending.some((x) => x.kind === 'review' && x.files.includes('.github/workflows/ci.yml')));
  const r = await S.post('/api/plan/garde/session/A/merge'); assert.equal(r.status, 400); assert.match(r.body.error, /à relire avant la fusion : \.github\/workflows\/ci\.yml\..*\/plan\/garde/i);
  const b = await until(async () => { const s = await S.session('garde', 'B'); return s.queued ? s : null; });
  assert.equal(b.status, 'todo'); assert.match(b.claude, /À relire d’abord : A/);
  const d = await S.get('/api/plan/garde/session/A/diff'); assert.ok(d.files.includes('.github/workflows/ci.yml')); assert.match(d.patch, /ci\.yml/);
  assert.deepEqual((await S.post('/api/plan/garde/session/A/reviewed', { head: d.head }, { cookie: await S.cookie() })).body, { ok: true });
  await until(async () => ['running', 'waiting', 'done'].includes((await S.session('garde', 'B')).status));
  assert.equal((await S.session('garde', 'A')).worktree.merged, false, 'kit: delivered, not merged');
  const m = (await S.post('/api/plan/garde/session/A/merge')).body;
  assert.doesNotMatch(String(m.error || ''), /à relire/, 'seen: no longer held by L'); assert.match(String(m.error || ''), /Domaine sous garde/, 'R: a guarded domain is strict, its approve is still asked');
});

test('the merge if tests are green: code 0 merges, a red code leaves it to the hand; the quota at 100 % refuses a start', async () => {
  const S = boot([{ write: 'src/x.txt', stops: [0], claude: 'Fait', done: true }]); await S.ready();
  const root = repo(); const root2 = repo();
  for (const [r, cmd] of [[root, 'test -f src/x.txt'], [root2, 'echo cassé; exit 3']]) assert.equal((await S.post('/api/project/settings', { project: r, autonomy: { mode: 'autonome', autoMergeIfGreen: true, testCommand: cmd } })).status, 200);
  assert.equal((await S.post('/api/plan', { id: 'vert', title: 'Vert', autonomy: { mode: 'autonome', autoMergeIfGreen: true, testCommand: 'test -f src/x.txt' }, sessions: [sess(root, { id: 'A', stops: ['Fin'] })] })).status, 200);
  assert.equal((await S.post('/api/plan', { id: 'rouge', title: 'Rouge', autonomy: { mode: 'autonome', autoMergeIfGreen: true, testCommand: 'echo cassé; exit 3' }, sessions: [sess(root2, { id: 'A', stops: ['Fin'] })] })).status, 200);
  await S.post('/api/launch', { plan: 'vert' });
  // the tests run outside the sandbox: never without the developer's click
  const ask = await until(async () => { const s = await S.session('vert', 'A'); return s.pending.find((x) => x.kind === 'run-tests') ? s : null; });
  assert.equal(ask.worktree.merged, false); assert.equal(ask.pending.find((x) => x.kind === "run-tests").text, "Lancer les tests hors bac à sable ? test -f src/x.txt");
  assert.equal((await S.post('/api/plan/vert/session/A/run-tests')).body.ok, true);
  await until(async () => (await S.session('vert', 'A')).worktree?.merged === true);
  assert.equal(sh(root, ['show', 'HEAD:src/x.txt']), 'écrit au tour 1');
  await S.post('/api/launch', { plan: 'rouge' });
  await until(async () => (await S.session('rouge', 'A')).pending.some((x) => x.kind === 'run-tests')); await S.post('/api/plan/rouge/session/A/run-tests');
  const red = await until(async () => { const s = await S.session('rouge', 'A'); return s.pending.find((x) => x.kind === 'info' && /Tests rouges/.test(x.text)) ? s : null; });
  assert.equal(red.worktree.merged, false); assert.match(red.pending.find((x) => /Tests rouges/.test(x.text)).text, /code 3.*cassé/);
  // the weekly quota at 100 % until tomorrow: nothing starts
  const db = new DatabaseSync(S.db); db.prepare("insert into escadrilles (id, title, status, weekly, reset_at, created, at) values ('q', 'q', 'stopped', 1, ?, ?, ?)").run(new Date(Date.now() + 864e5).toISOString(), new Date().toISOString(), new Date().toISOString()); db.close();
  assert.equal((await S.post('/api/plan', { id: 'quota', title: 'Quota', sessions: [sess(repo(), { id: 'A', stops: ['Fin'] })] })).status, 200);
  const q = (await S.post('/api/launch', { plan: 'quota' })).body; assert.deepEqual(q.queued, ['A']);
  assert.match((await S.session('quota', 'A')).claude, /Quota hebdo à 100 %/);
});

test('a session already waiting resumes alone when its project leaves Surveillé, from the date of its pending entry', async () => {
  const S = boot([{ stops: [0], claude: 'Le schéma' }, { stops: [0, 1], claude: 'Fini', done: true }]); await S.ready();
  const root = repo();
  assert.equal((await S.post('/api/plan', { id: 'reveil', title: 'Réveil', sessions: [sess(root, { id: 'A', stops: [{ title: 'Le schéma', kind: 'data', fallback: 'Garde le schéma.' }, 'La fin'] })] })).status, 200);
  await S.post('/api/launch', { plan: 'reveil' });
  await until(async () => (await S.session('reveil', 'A')).status === 'waiting');
  await new Promise((r) => setTimeout(r, 400)); assert.equal(S.prompts().length, 1, 'Surveillé: it waits');
  assert.equal((await S.post('/api/project/settings', { project: root, autonomy: { mode: 'autonome' } })).status, 200);
  await until(() => S.prompts().length >= 2); assert.equal(S.prompts()[1].text, 'Garde le schéma.');
});
