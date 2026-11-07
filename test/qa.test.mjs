// The QA plan of a run (docs/qa.md, lib/qa.mjs): the brief written from the plan alone, then a simulated plan against
// the fake claude on a spare port: two sessions merged by the button, the QA session appended and launched once (Sonnet,
// 3 $), its file shown by /qa/:plan and first in GET /api/qa; a project whose setting qa is false gets none.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeClaude } from './fake-claude.mjs';
import * as Q from '../lib/qa.mjs';
import { validatePlan } from '../lib/blocks.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));

test('the brief: every session, its stops, its summary, what it said, its merge; the file, the Signaler link, the shape', () => {
  const plan = validatePlan({ id: 'run-1', title: 'Le run', created: '2026-11-02T08:00:00Z', sessions: [
    { id: 'A', name: 'La barre', path: '/p', model: 'claude-opus-5-5', prompt: 'x', where: 'public/sidebar.js', stops: ['La barre faite'] },
    { id: 'B', name: 'Les limites', path: '/p', wave: 2, prompt: 'y', stops: ['Le panneau', 'Accès'] },
  ] }).plan;
  const state = [
    { id: 'A', status: 'done', stops: [0], summary: 'Fait : la barre\nReste : rien', usage: { cost: 1.234 }, worktree: { branch: 'escadrille/run-1/A', merged: true } },
    { id: 'B', status: 'done', stops: [0], summary: null, worktree: { branch: 'escadrille/run-1/B', merged: true } },
  ];
  const log = [{ session: 'A', claude: 'Regarde /flow à 390' }, { session: 'A', claude: 'Regarde /flow à 390' }, { session: 'B', claude: 'Le panneau dans /' }];
  const merges = ['abc123 Merge escadrille/run-1/A: La barre'];
  assert.equal(Q.needsQa(plan, state), true);
  assert.equal(Q.needsQa(plan, [state[0], { ...state[1], worktree: { merged: false } }]), false, 'one not merged');
  assert.equal(Q.needsQa({ ...plan, delivery: 'kit' }, state), false, 'a kit never merges');
  assert.equal(Q.needsQa({ ...plan, qa: { session: 'QA' } }, state), false, 'once per plan');
  const b = Q.qaBrief({ plan, state, log, merges, port: 3078 });
  for (const s of ['docs/qa/run-1.md', '### A · La barre', '### B · Les limites', '  - [x] La barre faite', '  - [ ] Accès', '> Fait : la barre', '1.23 $', 'fusionnée (escadrille/run-1/A) · abc123',
    'Regarde /flow à 390', 'Le panneau dans /', '## Les cinq qui comptent', 'http://localhost:3078/signaler.html?ecran=', '--since=2026-11-02T08:00:00Z', 'Résumé de fin : (aucun)'])
    assert.ok(b.includes(s), s);
  assert.equal(b.split('Regarde /flow à 390').length, 2, 'a line said twice is written once');
  assert.ok(b.indexOf('docs/qa/run-1.md') < b.indexOf('docs/qa/phase-9.md'), 'the file is the first path of the brief');
  const s = Q.qaSession({ plan, state, log, merges, root: '/p', port: 3078 });
  assert.deepEqual([s.id, s.model, s.budget, s.wave, s.after, s.path, s.where], ['QA', 'claude-sonnet-5-5', 3, 3, ['A', 'B'], '/p', 'docs/qa/run-1.md']);
  const next = validatePlan(Q.withQa(plan, s, '2026-11-02T10:00:00Z'));
  assert.ok(!next.errors, next.errors); assert.deepEqual(next.plan.qa, { session: 'QA', at: '2026-11-02T10:00:00Z' });
  assert.equal(next.plan.waves.find((w) => w.n === 3).title, 'La QA du run');
  assert.equal(Q.needsQa(next.plan, state), false);
});

const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
let gitOk = true; try { sh(tmpdir(), ['--version']); } catch { gitOk = false; }
const repo = () => { const root = tmp('escadrille-qa-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); writeFileSync(path.join(root, 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root; };
const until = async (fn, ms = 40000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 140)); await new Promise((r) => setTimeout(r, 150)); } };
const servers = [];
after(() => { for (const s of servers) s.kill('SIGKILL'); });
const boot = () => {
  const PORT = freePort(); const base = `http://127.0.0.1:${PORT}`;
  const S = { fake: fakeClaude(), plans: tmp('escadrille-plans-'), db: path.join(tmp('escadrille-db-'), 'db.sqlite'), empty: tmp('escadrille-none-') };
  const turns = [{ writeFrom: 'docs/[a-z0-9/-]+\\.(md|txt)', stops: [0], claude: 'Fini', done: true }];
  S.proc = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: S.db, ESCADRILLE_PLANS: S.plans, ESCADRILLE_CLAUDE: S.fake.file, ESCADRILLE_TRANSCRIPTS: S.empty, ESCADRILLE_SESSIONS: S.empty, FAKE_CLAUDE_TURNS: JSON.stringify(turns) }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(S.proc); S.err = ''; S.proc.stderr.on('data', (d) => { S.err += d; });
  S.get = async (p) => (await fetch(base + p)).json();
  S.page = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };
  S.post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  S.ready = () => until(async () => { try { await S.get('/api/plans'); return true; } catch { return false; } });
  S.session = async (plan, id) => (await S.get(`/api/plan/${plan}`)).state.find((s) => s.id === id);
  S.prompts = () => { try { return readFileSync(path.join(S.fake.dir, 'prompts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
  return S;
};
const sess = (root, id, extra) => ({ id, name: 'Session ' + id, path: root, model: 'claude-sonnet-5-5', prompt: `Écris docs/${id.toLowerCase()}.txt.`, budget: 1, stops: ['Fait'], ...extra });

test('a simulated plan: the last merge launches the QA session once, its file is the first line of the Review', { skip: !gitOk && 'git cannot run here' }, async () => {
  const S = boot(); await S.ready(); const root = repo();
  // FIAB 6: the QA is grouped by project by default (test/fiab.test.mjs); the per-plan QA stays behind qa: 'plan'
  assert.equal((await S.post('/api/project/settings', { project: root, qa: 'plan' })).status, 200);
  assert.equal((await S.post('/api/plan', { id: 'run', title: 'Le run simulé', sessions: [sess(root, 'A'), sess(root, 'B')] })).status, 200);
  await S.post('/api/launch', { plan: 'run' });
  await until(async () => (await S.session('run', 'A'))?.status === 'done' && (await S.session('run', 'B'))?.status === 'done');
  assert.equal((await S.post('/api/plan/run/session/A/merge')).status, 200);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await S.get('/api/plan/run')).plan.sessions.length, 2, 'one merge left: no QA yet');
  assert.deepEqual((await S.get('/api/qa?project=' + encodeURIComponent(root))).qa, []);
  assert.equal((await S.post('/api/plan/run/session/B/merge')).status, 200);
  // the QA session: appended, Sonnet, 3 $, after A and B, launched with the brief
  const p = await until(async () => { const j = await S.get('/api/plan/run'); return j.plan.qa ? j.plan : null; });
  const qs = p.sessions.find((s) => s.id === 'QA');
  assert.deepEqual([qs.model, qs.budget, qs.after, qs.where], ['claude-sonnet-5-5', 3, ['A', 'B'], 'docs/qa/run.md']);
  assert.ok(JSON.parse(readFileSync(path.join(S.plans, 'run.json'), 'utf8')).qa, 'the plan file carries it');
  const brief = await until(() => S.prompts().find((x) => x.text.includes('Tu es la session QA')));
  assert.match(brief.text, /### A · Session A[\s\S]*fusionnée \(calmdev\/run\/A\)/);
  assert.match(brief.text, /Merge calmdev\/run\/B: Session B/, 'the merges read in git');
  const qrow = await until(async () => { const s = await S.session('run', 'QA'); return s?.status === 'done' ? s : null; });
  assert.equal(qrow.budget, 3);
  // the Review: « Plan de QA » first, ready, its link opens the file from the worktree until it is merged
  const list = await until(async () => { const j = await S.get('/api/qa?project=' + encodeURIComponent(root)); return j.qa[0]?.ready ? j.qa : null; });
  assert.deepEqual([list.length, list[0].plan, list[0].title, list[0].merged, list[0].url], [1, 'run', 'Le run simulé', false, '/qa/run']);
  const page = await S.page('/qa/run'); assert.equal(page.status, 200); assert.match(page.text, /écrit au tour 1/);
  // merged: the file comes from the project, and no second QA
  assert.equal((await S.post('/api/plan/run/session/QA/merge')).status, 200);
  assert.equal(readFileSync(path.join(root, 'docs', 'qa', 'run.md'), 'utf8'), 'écrit au tour 1\n');
  await new Promise((r) => setTimeout(r, 500));
  const end = await S.get('/api/plan/run');
  assert.equal(end.plan.sessions.filter((s) => s.id === 'QA').length, 1);
  assert.equal(S.prompts().filter((x) => x.text.includes('Tu es la session QA')).length, 1, 'launched once');
  assert.equal((await S.get('/api/qa?project=' + encodeURIComponent(root))).qa[0].merged, true);
  assert.equal((await S.page('/qa/run')).status, 200);
  assert.equal((await S.page('/qa/nope')).status, 404);
  // Accès: a project that turned it off gets no QA session
  const r2 = repo();
  assert.equal((await S.post('/api/project/settings', { project: r2, qa: false })).status, 200);
  assert.equal((await S.get('/api/project/settings?project=' + encodeURIComponent(r2))).qa, false);
  assert.equal((await S.post('/api/project/settings', { project: r2, qa: 'oui' })).status, 400);
  assert.equal((await S.post('/api/plan', { id: 'off', title: 'Sans QA', sessions: [sess(r2, 'A')] })).status, 200);
  await S.post('/api/launch', { plan: 'off' });
  await until(async () => (await S.session('off', 'A'))?.status === 'done');
  assert.equal((await S.post('/api/plan/off/session/A/merge')).status, 200);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await S.get('/api/plan/off')).plan.qa, undefined);
  assert.equal((await S.get('/api/plan/off')).plan.sessions.length, 1);
});
