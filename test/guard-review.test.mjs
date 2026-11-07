// A branch the developer merged by hand (docs/backlog.md, phase 12, session GUARD): its tip is in main, so the waves no
// longer wait for its unseen review, and that review stays listed (files, « À faire », the plan page's block) until seen.
// The 403 of …/reviewed without the browser's key, naming guard-link, is test/guardrails.test.mjs (attempt 2) and
// test/gate.test.mjs (the route probe): not written a third time here.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeClaude } from './fake-claude.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const repo = () => { const root = tmp('escadrille-guard-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); writeFileSync(path.join(root, 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root; };
const until = async (fn, ms = 40000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 140)); await new Promise((r) => setTimeout(r, 150)); } };
const servers = [];
after(() => { for (const s of servers) s.kill('SIGKILL'); });

// prev: a server that ran before, its plans and its base kept (a restart)
const boot = (turns, prev = null) => {
  const PORT = freePort(); const base = `http://127.0.0.1:${PORT}`;
  const S = prev ? { fake: fakeClaude(), plans: prev.plans, db: prev.db, empty: prev.empty } : { fake: fakeClaude(), plans: tmp('escadrille-plans-'), db: path.join(tmp('escadrille-db-'), 'db.sqlite'), empty: tmp('escadrille-none-') };
  S.proc = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: S.db, ESCADRILLE_PLANS: S.plans, ESCADRILLE_CLAUDE: S.fake.file, ESCADRILLE_TRANSCRIPTS: S.empty, ESCADRILLE_SESSIONS: S.empty, ESCADRILLE_TESTBOX: 'none', ESCADRILLE_PAUSE_TICK_MS: '400', FAKE_CLAUDE_TURNS: JSON.stringify(turns) }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(S.proc); S.err = ''; S.proc.stderr.on('data', (d) => { S.err += d; });
  S.get = async (p) => (await fetch(base + p)).json();
  S.post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  S.ready = () => until(async () => { try { await S.get('/api/plans'); return true; } catch { return false; } });
  S.session = async (plan, id) => (await S.get(`/api/plan/${plan}`)).state.find((s) => s.id === id);
  S.messages = async (plan, id) => (await S.get(`/api/plan/${plan}/session/${id}/messages`)).messages;
  return S;
};
const sess = (root, extra) => ({ name: 's', path: root, model: 'claude-sonnet-5-5', prompt: 'Travaille.', budget: 1, ...extra });

// Harbor, 3 November (plan 2026-11-02-e-reputation-harbor-uber-d-abord-puis): D, J, F, K merged by the pilot into the PR branch
// stayed « à relire » and held the waves. Now the server sees the merge, marks it, closes the review and refuses its actions.
test('a branch merged outside the server: seen after a restart, out of the Revue, the next wave goes, its actions refused (409)', async () => {
  const S = boot([{ write: '.github/workflows/ci.yml', stops: [0], claude: 'CI', done: true }]); await S.ready();
  const root = repo(); sh(root, ['branch', 'feat/pr']); // the PR branch the pilot merges into, never declared by the plan
  assert.equal((await S.post('/api/plan', { id: 'main-a-la-main', title: 'À la main', sessions: [sess(root, { id: 'A', stops: ['La CI'] }), sess(root, { id: 'B', wave: 2, stops: ['La suite'] })] })).status, 200);
  await S.post('/api/launch', { plan: 'main-a-la-main' });
  const a = await until(async () => { const s = await S.session('main-a-la-main', 'A'); return s.status === 'done' && s.review ? s : null; });
  assert.equal(a.review.seen, false); assert.deepEqual(a.review.files, ['.github/workflows/ci.yml']);
  // not merged yet: several ticks pass, B waits behind « À relire d'abord »
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await S.session('main-a-la-main', 'B')).status, 'later', 'nothing merged: B waits');
  assert.ok(!(await S.session('main-a-la-main', 'A')).worktree.merged);
  // the server stops; the pilot merges the branch into the PR branch, outside the server; the server starts again on the same base
  S.proc.kill('SIGKILL'); await new Promise((r) => S.proc.once('exit', r));
  sh(root, ['checkout', '-q', 'feat/pr']); sh(root, ['merge', '--no-ff', '-q', '-m', 'merge by the pilot', a.worktree.branch]); const m = sh(root, ['rev-parse', 'HEAD']); sh(root, ['checkout', '-q', 'main']);
  const S2 = boot([{ stops: [0], claude: 'suite', done: true }], S); await S2.ready();
  const after_ = await until(async () => { const s = await S2.session('main-a-la-main', 'A'); return s.worktree.merged ? s : null; });
  assert.equal(after_.worktree.outside, true); assert.equal(after_.worktree.mergedInto, 'feat/pr'); assert.equal(after_.worktree.mergedCommit, m); assert.equal(after_.worktree.mergedBy, 't');
  assert.equal(after_.review.seen, true, 'its review is closed'); assert.ok(!after_.pending.some((x) => x.kind === 'review'), 'out of « À faire »');
  assert.ok((await S2.messages('main-a-la-main', 'A')).some((mm) => mm.role === 'system' && /fusionnée hors calmdev/i.test(mm.text)));
  await until(async () => ['running', 'waiting', 'done'].includes((await S2.session('main-a-la-main', 'B')).status));
  // out of the Revue's queue; its review page says « Fusionnée (commit) » and takes no action, the server refuses them
  assert.ok(!(await S2.get('/api/reviews')).reviews.some((r) => r.plan === 'main-a-la-main' && r.session === 'A'));
  const rv = await S2.get('/api/review?plan=main-a-la-main&session=A');
  assert.equal(rv.merged.commit, m); assert.equal(rv.merged.into, 'feat/pr');
  assert.deepEqual(rv.files.map((f) => f.path), ['.github/workflows/ci.yml'], 'read only, the diff is what the merge brought');
  for (const [p, body] of [[`/api/review/${rv.id}/submit`, { verdict: 'approve' }], [`/api/review/${rv.id}/decide`, { action: 'retry' }], [`/api/review/${rv.id}/decide`, { action: 'reject', reason: 'non' }], ['/api/plan/main-a-la-main/session/A/reviewed', {}]]) {
    const r = await S2.post(p, body); assert.equal(r.status, 409, p + ' ' + JSON.stringify(r.body)); assert.match(r.body.error, /fusionnée|srv\.e\.merged/i);
  }
  // a new commit on the branch after that merge: no longer counted as merged
  sh(after_.worktree.path, ['commit', '-q', '--allow-empty', '-m', 'after']);
  await until(async () => !(await S2.session('main-a-la-main', 'A')).worktree.merged);
});

// Harbor, 3 November: J and F, started from dev, kept up with the PR branch; their 17 migrations counted as theirs against dev.
// Against the target the plan declares (its base, the PR branch), only the session's own files are guarded.
test('the guarded files count against the declared target, not the branch the worktree started from', async () => {
  const root = repo();
  sh(root, ['checkout', '-qb', 'feat/pr']); execFileSync('mkdir', ['-p', path.join(root, 'db', 'migrations')]); writeFileSync(path.join(root, 'db', 'migrations', '001.sql'), 'create table t();\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'migration']); sh(root, ['checkout', '-q', 'main']);
  const S = boot([{ write: 'src/own.txt', stops: [0], claude: 'un' }, { run: 'git merge -q --no-edit feat/pr', write: 'src/two.txt', stops: [0], claude: 'deux', done: true }]); await S.ready();
  const plan = { id: 'cible-pr', title: 'Cible PR', sessions: [sess(root, { id: 'J', stops: ['La suite'] })] };
  assert.equal((await S.post('/api/plan', plan)).status, 200);
  await S.post('/api/launch', { plan: 'cible-pr' });
  const j = await until(async () => { const s = await S.session('cible-pr', 'J'); return s.status === 'waiting' ? s : null; });
  assert.equal(j.worktree.base, 'main', 'started from main');
  // the plan now declares where its sessions are merged: the PR branch
  assert.equal((await S.post('/api/plan', { ...plan, base: 'feat/pr' })).status, 200);
  assert.equal((await S.post('/api/plan/cible-pr/session/J/message', { text: 'Rattrape feat/pr et continue.' })).status, 200);
  const done = await until(async () => { const s = await S.session('cible-pr', 'J'); return s.status === 'done' ? s : null; });
  assert.ok(!done.review, 'no migration of the PR branch under guard: ' + JSON.stringify(done.review));
  const d = await S.get('/api/plan/cible-pr/session/J/diff');
  assert.deepEqual(d.files, ['src/own.txt', 'src/two.txt']);
});

test('the plan page: the guard approval is always a button, a 403 renders through keyNote everywhere, « Relire » loads the diff', () => {
  const html = readFileSync(path.join(HERE, '..', 'public', 'plan.html'), 'utf8');
  const block = html.slice(html.indexOf('const reviewBlock ='), html.indexOf('const loadDiff ='));
  assert.doesNotMatch(block, /d\?\.head \?/, 'no approval hidden behind the diff');
  assert.match(block, /data-reviewed=.*data-guard/);
  assert.match(html, /r\.status === 403 && j && j\.error\) refused\.add/, 'api() remembers every 403, the gate’s and the guardrail’s');
  assert.doesNotMatch(html, /\$\{notes\[[^\]]+\] \? `/, 'every note goes through noteOf (one rendering)');
  assert.match(html, /gotoReview\) \{ chosen = t\.dataset\.gotoReview; await loadDiff/);
  for (const lang of ['fr', 'en']) { const j = JSON.parse(readFileSync(path.join(HERE, '..', 'public', 'i18n', lang + '.json'), 'utf8')); for (const k of ['plan.key.why', 'plan.key.do', 'plan.key.copy', 'plan.key.copied', 'plan.key.then', 'plan.guardLookFirst', 'rev.merged', 'rev.mergedInto', 'rev.mergedBy', 'srv.e.merged', 'srv.s.mergedOutside', 'srv.s.outsideMoved']) assert.ok(j[k], `${lang} ${k}`); }
});
