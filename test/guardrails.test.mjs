// The protected guardrails (docs/autonomy.md, « Garde-fous protégés »; phase 10, session E): tests that try to get around
// them. lib/guardrails.mjs alone, then the server on a spare port against the fake claude, on a throwaway repository that
// is Escadrille (it holds lib/guardrails.mjs and server.mjs) and one that is not:
//   1. a session modifies lib/policy.mjs: its sandbox refuses the write, and the commit the fake makes anyway holds the merge;
//   2. Autonome, merge if tests are green: the branch that modifies it is never merged, only the browser's key approves,
//      and the approval names a commit (one more commit asks again);
//   3. a rename (git mv), and a commit made with git plumbing that never writes the file: both seen.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeClaude } from './fake-claude.mjs';
import * as G from '../lib/guardrails.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
// git needs to start from Node (in Claude Code's sandbox it may not: spawn EPERM, docs/terrain.md)
let gitOk = true; try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitOk = false; }
const files = (root, list) => { for (const [f, txt] of Object.entries(list)) { mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); writeFileSync(path.join(root, f), txt); } };
const repo = (escadrille = true) => {
  const root = tmp('escadrille-guard-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']);
  files(root, { 'a.txt': 'un\n', 'lib/policy.mjs': 'export const rules = ["no push"];\n', ...(escadrille ? { 'lib/guardrails.mjs': '// guard\n', 'server.mjs': '// server\n' } : {}) });
  sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); return root;
};
const until = async (fn, ms = 40000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString().slice(0, 140)); await new Promise((r) => setTimeout(r, 150)); } };
const servers = [];
after(() => { for (const s of servers) s.kill('SIGKILL'); });

const boot = (turns) => {
  const PORT = freePort(); const base = `http://127.0.0.1:${PORT}`;
  const S = { fake: fakeClaude(), plans: tmp('escadrille-plans-'), db: path.join(tmp('escadrille-db-'), 'db.sqlite'), empty: tmp('escadrille-none-'), keys: tmp('escadrille-keys-') };
  S.proc = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...process.env, PORT: String(PORT), ESCADRILLE_DB: S.db, ESCADRILLE_PLANS: S.plans, ESCADRILLE_CLAUDE: S.fake.file, ESCADRILLE_TRANSCRIPTS: S.empty, ESCADRILLE_SESSIONS: S.empty, ESCADRILLE_GUARD_DIR: S.keys, ESCADRILLE_FALLBACK_MIN: '0', FAKE_CLAUDE_TURNS: JSON.stringify(turns) }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(S.proc); S.err = ''; S.proc.stderr.on('data', (d) => { S.err += d; });
  S.get = async (p) => (await fetch(base + p)).json();
  S.post = async (p, body, headers = {}) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  S.raw = (p) => fetch(base + p, { redirect: 'manual' });
  S.ready = () => until(async () => { try { await S.get('/api/plans'); return true; } catch { return false; } });
  S.session = async (plan, id) => (await S.get(`/api/plan/${plan}`)).state.find((s) => s.id === id);
  S.args = () => readFileSync(path.join(S.fake.dir, 'args.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return S;
};
const sess = (root, extra) => ({ name: 's', path: root, model: 'claude-sonnet-5-5', prompt: 'Travaille.', budget: 1, ...extra });
// The browser's key: the link of guard-link hands it as a cookie
const cookieOf = async (S) => {
  const link = readFileSync(path.join(S.keys, 'guard-link'), 'utf8').trim(); const k = new URL(link).searchParams.get('k');
  assert.equal((await S.raw('/guard?k=' + 'f'.repeat(64))).status, 403, 'a wrong key gets nothing');
  const r = await S.raw('/guard?k=' + k); assert.equal(r.status, 303);
  const c = r.headers.get('set-cookie'); assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Strict/);
  return c.split(';')[0];
};

test('the list: the doc and the code say the same files; the touched ones, case folded; Escadrille or not; the sandbox refusals', { skip: !gitOk && 'git cannot start from Node here' }, () => {
  const doc = readFileSync(path.join(HERE, '..', 'docs', 'autonomy.md'), 'utf8');
  const section = doc.split(/^## /m).find((s) => s.startsWith('Garde-fous protégés')); assert.ok(section, 'docs/autonomy.md has the section');
  const listed = [...section.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]);
  assert.deepEqual(listed.sort(), [...G.PROTECTED].sort());
  for (const f of ['lib/policy.mjs', 'lib/autonomy.mjs', 'lib/worktree.mjs', 'lib/limits.mjs', 'lib/planner.mjs', 'server.mjs']) assert.ok(G.PROTECTED.includes(f), f);
  assert.ok(Object.isFrozen(G.PROTECTED));
  // Dev, 2026-11-02 04:00: the key is asked only for the files that define the guardrails; server.mjs merges on green tests
  assert.deepEqual(G.protectedTouched(['src/a.js', './lib/policy.mjs', 'LIB/Policy.mjs', 'server.mjs']), ['LIB/Policy.mjs', 'lib/policy.mjs'].sort());
  const esc = repo(true); const plain = repo(false);
  assert.equal(G.isEscadrille(esc, { own: plain }), true); assert.equal(G.isEscadrille(plain, { own: esc }), false);
  assert.equal(G.isEscadrille(path.join(HERE, '..')), true, 'this repository');
  const wt = path.join(esc, '.claude', 'worktrees', 'p-A');
  const s = G.sandboxGuard({ sandbox: { enabled: true, filesystem: { denyRead: ['~/.ssh'] } }, permissions: { deny: ['Read(~/.ssh/**)'] } }, { root: esc, worktree: wt, base: 'main' });
  const common = realpathSync(path.join(esc, '.git'));
  // Dev, 2026-11-02: only the files that define the guardrails are write-denied; server.mjs stays writable, its merge waits for the review
  assert.ok(!s.sandbox.filesystem.denyWrite.includes(path.join(wt, 'server.mjs')), 'server.mjs is writable, merge-gated');
  for (const p of [path.join(wt, 'lib/policy.mjs'), path.join(wt, 'lib/guardrails.mjs'), path.join(wt, 'CLAUDE.md'), path.join(common, 'refs/heads/main'), path.join(common, 'refs/heads/main.lock'), path.join(common, 'packed-refs'), path.join(common, 'HEAD')]) assert.ok(s.sandbox.filesystem.denyWrite.includes(p), p);
  assert.ok(s.permissions.deny.includes(`Edit(/${path.join(wt, 'lib/policy.mjs')})`)); assert.ok(s.permissions.deny.includes('Read(~/.ssh/**)'), 'the existing rules stay');
  assert.deepEqual(s.sandbox.filesystem.denyRead, ['~/.ssh']); assert.equal(s.sandbox.enabled, true);
  assert.equal(G.guardWrites({ root: esc, worktree: null, base: '../x' }).refs.some((r) => r.includes('..')), false, 'a strange base names no path');
  // a rename names both sides
  sh(esc, ['checkout', '-qb', 'mv']); sh(esc, ['mv', 'lib/policy.mjs', 'lib/rules.mjs']); sh(esc, ['commit', '-qm', 'mv']); sh(esc, ['checkout', '-q', 'main']);
  assert.deepEqual(G.protectedTouched(G.branchFiles(esc, 'mv')), ['lib/policy.mjs']);
  assert.ok(G.keyMatches('ab', 'ab')); assert.equal(G.keyMatches('', ''), false); assert.equal(G.keyMatches(null, 'ab'), false);
  assert.equal(G.keyFromCookie('a=1; escadrille_guard=xyz; b=2'), 'xyz');
});

test('attempt 1: a session modifies lib/policy.mjs: the sandbox refuses it, the commit made anyway holds the merge; a plain project is not held', { skip: !gitOk && 'git cannot start from Node here' }, async () => {
  const S = boot([{ write: 'lib/policy.mjs', stops: [0], claude: 'Politique allégée', done: true }]); await S.ready();
  const esc = repo(true); const plain = repo(false);
  assert.equal((await S.post('/api/plan', { id: 'esc', title: 'Esc', sessions: [sess(esc, { id: 'A', stops: ['Fin'] })] })).status, 200);
  assert.equal((await S.post('/api/plan', { id: 'plain', title: 'Plain', sessions: [sess(plain, { id: 'A', stops: ['Fin'] })] })).status, 200);
  await S.post('/api/launch', { plan: 'esc' });
  const a = await until(async () => { const s = await S.session('esc', 'A'); return s.review?.guard ? s : null; });
  // what the sandbox was told: the worktree's lib/policy.mjs is unwritable, by Bash and by the file tools; the prompt says it
  const args = S.args().find((x) => x.includes('--settings') && JSON.parse(x[x.indexOf('--settings') + 1]).sandbox.filesystem.denyWrite);
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]); const wtPolicy = path.join(a.worktree.path, 'lib', 'policy.mjs');
  assert.ok(settings.sandbox.filesystem.denyWrite.includes(wtPolicy)); assert.ok(settings.permissions.deny.includes(`Edit(/${wtPolicy})`));
  assert.ok(settings.sandbox.filesystem.denyWrite.includes(path.join(realpathSync(path.join(esc, '.git')), 'refs', 'heads', 'main')), 'main cannot be moved by git update-ref');
  const first = JSON.parse(readFileSync(path.join(S.fake.dir, 'prompts.jsonl'), 'utf8').split('\n')[0]).text;
  assert.match(first, /Garde-fous protégés \(docs\/autonomy\.md\) : lib\/guardrails\.mjs, lib\/policy\.mjs/); assert.match(first, /dis-le dans why avec health "error", et arrête-toi/);
  assert.deepEqual(a.review.guard, ['lib/policy.mjs']); assert.equal(a.review.seen, false);
  const entry = a.pending.find((x) => x.kind === 'review'); assert.deepEqual(entry.guard, ['lib/policy.mjs']); assert.match(entry.text, /Garde-fou touché : lib\/policy\.mjs/);
  await until(async () => (await S.session('esc', 'A')).status === 'done');
  const m = await S.post('/api/plan/esc/session/A/merge'); assert.equal(m.status, 409); assert.deepEqual(m.body.guard, ['lib/policy.mjs']); assert.match(m.body.error, /Garde-fou touché/);
  assert.equal(readFileSync(path.join(esc, 'lib/policy.mjs'), 'utf8'), 'export const rules = ["no push"];\n', 'main untouched');
  // the same session on a project that is not Escadrille: no guard, no refusal in its sandbox
  await S.post('/api/launch', { plan: 'plain' });
  const p = await until(async () => { const s = await S.session('plain', 'A'); return s.status === 'done' ? s : null; });
  assert.equal(p.review, null);
  const last = S.args().at(-1); assert.equal(JSON.parse(last[last.indexOf('--settings') + 1]).sandbox.filesystem.denyWrite, undefined);
  assert.equal((await S.post('/api/plan/plain/session/A/merge')).status, 200);
});

test('attempt 2: Autonome, merge if green: never merged; the reviewed route asks for the browser key and the seen commit; a later commit asks again', { skip: !gitOk && 'git cannot start from Node here' }, async () => {
  const S = boot([{ write: 'lib/policy.mjs', stops: [0], claude: 'Fait', done: true }]); await S.ready();
  const root = repo(true);
  assert.equal((await S.post('/api/project/settings', { project: root, autonomy: { mode: 'autonome', autoMergeIfGreen: true, testCommand: 'true', guardedPaths: [] } })).status, 200, 'the guarded paths emptied: the protected list does not depend on them');
  assert.equal((await S.post('/api/plan', { id: 'auto', title: 'Auto', autoMerge: true, autonomy: { mode: 'autonome', autoMergeIfGreen: true, testCommand: 'true', guardedPaths: [] }, sessions: [sess(root, { id: 'A', stops: ['Fin'] })] })).status, 200);
  await S.post('/api/launch', { plan: 'auto' });
  await until(async () => { const s = await S.session('auto', 'A'); return s.status === 'done' && s.review?.guard ? s : null; });
  // the green tests go through the merge: refused
  const rt = await S.post('/api/plan/auto/session/A/run-tests'); if (rt.status === 200) assert.equal(rt.body.ok, false);
  await new Promise((r) => setTimeout(r, 500));
  let a = await S.session('auto', 'A'); assert.equal(a.worktree.merged, false, 'Autonome and green: not merged');
  // a session calling the route from 127.0.0.1 has no key: 403
  const noKey = await S.post('/api/plan/auto/session/A/reviewed'); assert.equal(noKey.status, 403); assert.match(noKey.body.error, /guard-link/);
  assert.equal((await S.post('/api/plan/auto/session/A/reviewed', {}, { cookie: 'escadrille_guard=' + 'a'.repeat(64) })).status, 403, 'a guessed key');
  const cookie = await cookieOf(S);
  const d = await S.get('/api/plan/auto/session/A/diff'); assert.match(d.head, /^[0-9a-f]{40}$/); assert.deepEqual(d.guard, ['lib/policy.mjs']);
  assert.equal((await S.post('/api/plan/auto/session/A/reviewed', { head: '0'.repeat(40) }, { cookie })).status, 409, 'not the commit seen');
  // one more commit lands after the diff was read: the approval of the old one is refused
  sh(a.worktree.path, ['commit', '-q', '--allow-empty', '-m', 'later']);
  assert.equal((await S.post('/api/plan/auto/session/A/reviewed', { head: d.head }, { cookie })).status, 409);
  const d2 = await S.get('/api/plan/auto/session/A/diff');
  assert.deepEqual((await S.post('/api/plan/auto/session/A/reviewed', { head: d2.head }, { cookie })).body, { ok: true });
  a = await S.session('auto', 'A'); assert.equal(a.review.guardHead, d2.head);
  // approved for d2.head; a commit after it asks again (the merge is by commit, never by branch name)
  sh(a.worktree.path, ['commit', '-q', '--allow-empty', '-m', 'after approval']);
  const again = await S.post('/api/plan/auto/session/A/merge'); assert.equal(again.status, 409); assert.match(again.body.error, /Garde-fou touché/);
  assert.equal(readFileSync(path.join(root, 'lib/policy.mjs'), 'utf8'), 'export const rules = ["no push"];\n');
  const d3 = await S.get('/api/plan/auto/session/A/diff');
  assert.deepEqual((await S.post('/api/plan/auto/session/A/reviewed', { head: d3.head }, { cookie })).body, { ok: true });
  // reviewed with the key: the merge goes through (automatically after done, or by the button)
  await until(async () => (await S.session('auto', 'A')).worktree?.merged === true || (await S.post('/api/plan/auto/session/A/merge')).status === 200);
  assert.match(sh(root, ['show', 'HEAD:lib/policy.mjs']), /écrit au tour/);
});

test('attempt 3: a rename, and a commit made with git plumbing that never writes the file: both held', { skip: !gitOk && 'git cannot start from Node here' }, async () => {
  const S = boot([{ run: 'git mv lib/policy.mjs lib/rules.mjs && printf "export const rules = [];\\n" > lib/rules.mjs && git add -A && git commit -qm rename', stops: [0], claude: 'Renommé', done: true }]); await S.ready();
  const root = repo(true); const root2 = repo(true);
  assert.equal((await S.post('/api/plan', { id: 'mv', title: 'Mv', sessions: [sess(root, { id: 'A', stops: ['Fin'] })] })).status, 200);
  await S.post('/api/launch', { plan: 'mv' });
  const a = await until(async () => { const s = await S.session('mv', 'A'); return s.status === 'done' && s.review ? s : null; });
  assert.deepEqual(a.review.guard, ['lib/policy.mjs'], 'the old name is seen');
  const m = await S.post('/api/plan/mv/session/A/merge'); assert.equal(m.status, 409); assert.deepEqual(m.body.guard, ['lib/policy.mjs']);
  assert.equal(sh(root, ['ls-files', 'lib/policy.mjs']), 'lib/policy.mjs', 'main keeps it');
  // plumbing: a blob and the index, the worktree's lib/guardrails.mjs never written (its writes are denied); the merge reads the branch, not the turns
  assert.equal((await S.post('/api/plan', { id: 'plumb', title: 'Plumb', sessions: [sess(root2, { id: 'A', stops: ['Fin'] })] })).status, 200);
  await S.post('/api/launch', { plan: 'plumb' });
  const b = await until(async () => { const s = await S.session('plumb', 'A'); return s.status === 'done' && s.worktree ? s : null; });
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: b.worktree.path, input: '// no gate\n' }).toString().trim();
  sh(b.worktree.path, ['update-index', '--cacheinfo', `100644,${blob},lib/guardrails.mjs`]); sh(b.worktree.path, ['commit', '-qm', 'plumbing']);
  const pm = await S.post('/api/plan/plumb/session/A/merge'); assert.equal(pm.status, 409); assert.ok(pm.body.guard.includes('lib/guardrails.mjs'));
  const fresh = await S.session('plumb', 'A'); assert.ok(fresh.review.guard.includes('lib/guardrails.mjs'), 'the merge opened the review « garde-fou touché »');
  assert.equal(readFileSync(path.join(root2, 'lib/guardrails.mjs'), 'utf8'), '// guard\n');
});
