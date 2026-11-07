// The review (docs/review.md), on throwaway git repositories: the diff parser (added, deleted, renamed, binary, no final
// newline, quoted paths), then on a server with the fake claude: a pair review, comments, "viewed" reset when the file
// changes, a session review whose 'changes' verdict reaches the session, and mergeAllowed by level.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { fakeClaude } from './fake-claude.mjs';
import { parseDiff, isGenerated, globRe, reviewId, reviewMessage } from '../lib/review.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };
const commit = (cwd, msg) => { sh(cwd, ['add', '-A']); sh(cwd, ['commit', '-qm', msg]); };
const repo = () => {
  const root = tmp('escadrille-rev-');
  sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']);
  writeFileSync(path.join(root, 'keep.txt'), 'a\nb\nc\nd\ne\n');
  writeFileSync(path.join(root, 'gone.txt'), 'bye\n');
  writeFileSync(path.join(root, 'old name.md'), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  writeFileSync(path.join(root, 'tail.txt'), 'one\ntwo');
  commit(root, 'start');
  return root;
};
const diffOf = (root, range) => sh(root, ['-c', 'core.quotepath=true', 'diff', '--no-color', '--no-ext-diff', '--full-index', '-M', '--src-prefix=a/', '--dst-prefix=b/', range]);

test('the parser: added, deleted, renamed with a change, binary, no final newline, quoted paths, line numbers', () => {
  const root = repo();
  sh(root, ['checkout', '-q', '-b', 'feature']);
  writeFileSync(path.join(root, 'keep.txt'), 'a\nB\nc\nd\ne\nf\n');
  writeFileSync(path.join(root, 'new.mjs'), 'export const x = 1;\n');
  writeFileSync(path.join(root, 'café é.md'), 'accent\n');
  rmSync(path.join(root, 'gone.txt'));
  renameSync(path.join(root, 'old name.md'), path.join(root, 'new name.md'));
  writeFileSync(path.join(root, 'new name.md'), readFileSync(path.join(root, 'new name.md'), 'utf8').replace('line 10\n', 'line ten\n'));
  writeFileSync(path.join(root, 'tail.txt'), 'one\ntwo\nthree');
  writeFileSync(path.join(root, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 0, 255]));
  mkdirSync(path.join(root, 'dist')); writeFileSync(path.join(root, 'dist', 'app.min.js'), 'x\n');
  commit(root, 'feature');
  const files = parseDiff(diffOf(root, 'main...feature'));
  const by = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(by).sort(), ['café é.md', 'dist/app.min.js', 'gone.txt', 'keep.txt', 'new name.md', 'new.mjs', 'pic.png', 'tail.txt']);

  assert.equal(by['new.mjs'].status, 'added'); assert.equal(by['new.mjs'].additions, 1); assert.equal(by['new.mjs'].deletions, 0);
  assert.deepEqual(by['new.mjs'].hunks[0].lines, [{ kind: 'add', old: null, new: 1, text: 'export const x = 1;' }]);
  assert.equal(by['gone.txt'].status, 'deleted'); assert.equal(by['gone.txt'].blob, 'deleted');
  assert.deepEqual(by['gone.txt'].hunks[0].lines, [{ kind: 'del', old: 1, new: null, text: 'bye' }]);

  const k = by['keep.txt']; assert.equal(k.status, 'modified'); assert.equal(k.additions, 2); assert.equal(k.deletions, 1);
  assert.match(k.hunks[0].header, /^@@ -1,5 \+1,6 @@/);
  assert.deepEqual(k.hunks[0].lines.slice(0, 3), [{ kind: 'ctx', old: 1, new: 1, text: 'a' }, { kind: 'del', old: 2, new: null, text: 'b' }, { kind: 'add', old: null, new: 2, text: 'B' }]);
  assert.deepEqual(k.hunks[0].lines.at(-1), { kind: 'add', old: null, new: 6, text: 'f' });

  const r = by['new name.md']; assert.equal(r.status, 'renamed'); assert.equal(r.oldPath, 'old name.md'); assert.equal(r.additions, 1); assert.equal(r.deletions, 1);
  assert.ok(r.hunks[0].lines.some((l) => l.kind === 'add' && l.new === 10 && l.text === 'line ten'));

  const t = by['tail.txt']; // 'two' had no final newline, 'three' has none either
  const del = t.hunks[0].lines.find((l) => l.kind === 'del'); const last = t.hunks[0].lines.at(-1);
  assert.equal(del.text, 'two'); assert.equal(del.noEol, true); assert.equal(last.text, 'three'); assert.equal(last.noEol, true);

  assert.equal(by['pic.png'].binary, true); assert.deepEqual(by['pic.png'].hunks, []); assert.equal(by['pic.png'].status, 'added');
  assert.equal(by['café é.md'].status, 'added');
  assert.ok(isGenerated('dist/app.min.js') && isGenerated('package-lock.json') && isGenerated('src/__snapshots__/a.snap') && !isGenerated('src/app.mjs'));

  // a pure rename: no hunks, a blob that says "same content"
  sh(root, ['checkout', '-q', '-b', 'move', 'main']); renameSync(path.join(root, 'gone.txt'), path.join(root, 'moved.txt')); commit(root, 'move');
  const [m] = parseDiff(diffOf(root, 'main...move'));
  assert.deepEqual({ path: m.path, oldPath: m.oldPath, status: m.status, hunks: m.hunks }, { path: 'moved.txt', oldPath: 'gone.txt', status: 'renamed', hunks: [] });
  // a content line that looks like a header ('--- a/x' deleted, '++ b' added) stays a content line
  sh(root, ['checkout', '-q', '-b', 'tricky', 'main']); writeFileSync(path.join(root, 'keep.txt'), 'a\n-- a/x\n+ b/y\nd\ne\n'); commit(root, 'tricky');
  writeFileSync(path.join(root, 'keep.txt'), 'a\n++ b/y\nd\ne\n'); commit(root, 'tricky 2');
  const [tk] = parseDiff(diffOf(root, 'tricky~1...tricky'));
  assert.deepEqual(tk.hunks[0].lines.map((l) => l.kind + ':' + l.text), ['ctx:a', 'del:-- a/x', 'del:+ b/y', 'add:++ b/y', 'ctx:d', 'ctx:e']);
});

test('globs of guarded domains, the stable id, the message to a session', () => {
  assert.ok(globRe('auth/**').test('auth/a/b.mjs')); assert.ok(!globRe('auth/*').test('auth/a/b.mjs')); assert.ok(globRe('db/*.sql').test('db/1.sql')); assert.ok(!globRe('db/*.sql').test('xdb/1.sql'));
  assert.equal(reviewId('/r', 'dev', 'release/r01'), reviewId('/r', 'dev', 'release/r01')); assert.notEqual(reviewId('/r', 'dev', 'a'), reviewId('/r', 'dev', 'b'));
  const msg = reviewMessage('changes', 'Deux choses.', [{ path: 'a.mjs', line: 4, side: 'new', snippet: '  const x = 1;', body: 'Nomme-la.', resolved: false }, { path: 'b.mjs', line: 1, side: 'old', snippet: 'x', body: 'vu', resolved: true }]);
  assert.equal(msg, 'Revue : changements demandés.\n\nDeux choses.\n\n- a.mjs:4 (`const x = 1;`) : Nomme-la.');
});

// --- the server ------------------------------------------------------------------------------------------------
// its own port, asked of the system (test/free-port.mjs)
const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const fake = fakeClaude();
const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:${process.env.PATH}`, PORT: String(PORT), ESCADRILLE_TRANSCRIPTS: tmp('escadrille-transcripts-'), ESCADRILLE_DB: path.join(tmp('escadrille-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-plans-'), ESCADRILLE_CLAUDE: fake.file }, stdio: ['ignore', 'pipe', 'pipe'] });
let errOut = ''; server.stderr.on('data', (d) => { errOut += d; });
after(() => server.kill('SIGINT'));
const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
const q = encodeURIComponent;
const ready = () => until(async () => { try { return (await get("/api/plans")).status === 200; } catch { return false; } }, 20000);

test('a pair review: files, collapsed files on demand, comments, resolve, viewed reset when the file changes, submit', async () => {
  await ready();
  const root = repo();
  sh(root, ['checkout', '-q', '-b', 'release/r01']);
  writeFileSync(path.join(root, 'keep.txt'), 'a\nB\nc\nd\ne\n');
  writeFileSync(path.join(root, 'package-lock.json'), '{}\n');
  writeFileSync(path.join(root, 'big.txt'), Array.from({ length: 1600 }, (_, i) => `l${i}`).join('\n') + '\n');
  commit(root, 'r01'); sh(root, ['checkout', '-q', 'main']);

  assert.equal((await get(`/api/review?project=${q(root)}&base=main&head=nope`)).status, 400, 'unknown branch');
  assert.equal((await get(`/api/review?project=${q(root)}&base=main&head=--output=x`)).status, 400, 'no option as a branch');
  let r = await get(`/api/review?project=${q(root)}&base=main&head=release/r01`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const R = r.body; const id = R.id;
  assert.equal(id, reviewId(root, 'main', 'release/r01'));
  assert.deepEqual({ base: R.base, head: R.head, level: R.level, verdict: R.verdict, mergeAllowed: R.mergeAllowed }, { base: 'main', head: 'release/r01', level: 'guided', verdict: null, mergeAllowed: null });
  // Q's pre-review (lib/prereview.mjs), called through the hook of docs/review.md: one entry per file of the diff
  assert.equal(typeof R.prereview.summary, 'string'); assert.deepEqual(R.prereview.files.map((f) => f.path).sort(), R.files.map((f) => f.path).sort());
  assert.match(R.headSha, /^[0-9a-f]{40}$/);
  const by = Object.fromEntries(R.files.map((f) => [f.path, f]));
  assert.equal(by['package-lock.json'].generated, true); assert.equal(by['package-lock.json'].collapsed, 'generated'); assert.equal(by['package-lock.json'].hunks, null);
  assert.equal(by['big.txt'].collapsed, 'large'); assert.equal(by['big.txt'].hunks, null); assert.equal(by['big.txt'].additions, 1600);
  assert.equal(by['keep.txt'].collapsed, null); assert.equal(by['keep.txt'].viewed, false);
  const big = await get(`/api/review/${id}/file?path=big.txt`); assert.equal(big.body.hunks[0].lines.length, 1600);
  assert.equal((await get(`/api/review/${id}/file?path=nothing`)).status, 400);
  assert.equal((await get('/api/review/0000000000000000')).status, 404);

  // comments: a line in the diff on either side, refused outside it
  assert.equal((await post(`/api/review/${id}/comment`, { path: 'keep.txt', side: 'new', line: 40, body: 'x' })).status, 400);
  assert.equal((await post(`/api/review/${id}/comment`, { path: 'keep.txt', side: 'new', line: 2, body: '' })).status, 400);
  const c1 = await post(`/api/review/${id}/comment`, { path: 'keep.txt', side: 'new', line: 2, body: 'Pourquoi en capitale ?' });
  assert.equal(c1.status, 200); assert.equal(c1.body.comment.snippet, 'B'); assert.equal(c1.body.comment.author, 'dev');
  const c2 = await post(`/api/review/${id}/comment`, { path: 'keep.txt', side: 'old', line: 2, body: 'ancienne', author: 'pilot' });
  assert.equal(c2.body.comment.snippet, 'b'); assert.equal(c2.body.comment.author, 'pilot');
  assert.equal((await post(`/api/review/${id}/comment/${c2.body.comment.id}/resolve`, {})).status, 200);
  assert.equal((await post(`/api/review/${id}/comment/9999/resolve`, {})).status, 404);
  r = await get(`/api/review/${id}`);
  assert.deepEqual(r.body.comments.map((c) => [c.line, c.side, c.resolved]), [[2, 'new', false], [2, 'old', true]]);

  // viewed: kept while the file stays, reset when it changes on head, untouched for the other files
  await post(`/api/review/${id}/viewed`, { path: 'keep.txt', viewed: true });
  await post(`/api/review/${id}/viewed`, { path: 'package-lock.json', viewed: true });
  r = await get(`/api/review/${id}`); assert.equal(r.body.files.find((f) => f.path === 'keep.txt').viewed, true);
  let queue = (await get(`/api/reviews?project=${q(root)}`)).body.reviews;
  assert.equal(queue.length, 1); assert.deepEqual({ files: queue[0].files, viewed: queue[0].viewed, comments: queue[0].comments, additions: queue[0].additions }, { files: 3, viewed: 2, comments: 1, additions: 1602 });
  sh(root, ['checkout', '-q', 'release/r01']); writeFileSync(path.join(root, 'keep.txt'), 'a\nBB\nc\nd\ne\n'); commit(root, 'again'); sh(root, ['checkout', '-q', 'main']);
  r = await get(`/api/review/${id}`);
  assert.equal(r.body.files.find((f) => f.path === 'keep.txt').viewed, false, 'the file changed: unchecked');
  assert.equal(r.body.files.find((f) => f.path === 'package-lock.json').viewed, true, 'the other one stays');
  assert.equal((await get(`/api/reviews?project=${q(root)}`)).body.reviews[0].viewed, 1);
  await post(`/api/review/${id}/viewed`, { path: 'package-lock.json', viewed: false });
  assert.equal((await get(`/api/review/${id}`)).body.files.find((f) => f.path === 'package-lock.json').viewed, false);

  // submit: a body for changes, nothing sent outside a plan; an approve takes the pair out of the queue until head moves
  assert.equal((await post(`/api/review/${id}/submit`, { verdict: 'changes', body: '' })).status, 400);
  assert.equal((await post(`/api/review/${id}/submit`, { verdict: 'nope', body: 'x' })).status, 400);
  assert.deepEqual((await post(`/api/review/${id}/submit`, { verdict: 'changes', body: 'Reprends keep.txt.' })).body, { ok: true, sent: false, merged: false, escalated: false, retries: 0, retryMax: 2, mergeAllowed: null });
  assert.equal((await post(`/api/review/${id}/submit`, { verdict: 'approve' })).status, 200);
  assert.equal((await get(`/api/reviews?project=${q(root)}`)).body.reviews.length, 0);
  sh(root, ['checkout', '-q', 'release/r01']); writeFileSync(path.join(root, 'n.txt'), 'n\n'); commit(root, 'more'); sh(root, ['checkout', '-q', 'main']);
  queue = (await get(`/api/reviews?project=${q(root)}`)).body.reviews;
  assert.equal(queue.length, 1); assert.equal(queue[0].verdict.stale, true);
});

test('a session review: base and branch from the worktree, changes sent to the session, merge gated by the level', async () => {
  await ready();
  const root = repo();
  const plan = { id: 'revue', title: 'Revue', sessions: [{ id: 'A', name: 'Première', path: root, model: 'claude-sonnet-5-5', stops: ['La fin'], prompt: 'Écris.' }] };
  assert.equal((await post('/api/plan', plan)).status, 200);
  assert.equal((await get('/api/review?plan=revue&session=A')).status, 400, 'no worktree before the launch');
  assert.deepEqual((await post('/api/launch', { plan: 'revue' })).body.launched, ['A']);
  const st = await until(async () => { const s = (await get('/api/plan/revue')).body.state.find((x) => x.id === 'A'); return s.pending.some((p) => p.kind === 'permission') && s; });
  assert.equal(st.worktree.base, 'main', 'the worktree knows the branch it started from');
  // the session's work, committed on its branch
  writeFileSync(path.join(st.worktree.path, 'keep.txt'), 'a\nb\nC\nd\ne\n'); commit(st.worktree.path, 'session work');

  let r = await get('/api/review?plan=revue&session=A');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.id;
  assert.deepEqual({ base: r.body.base, head: r.body.head, title: r.body.title, files: r.body.files.map((f) => f.path) }, { base: 'main', head: 'calmdev/revue/A', title: 'A · Première', files: ['keep.txt'] });
  assert.deepEqual(r.body.mergeAllowed, { allowed: true, level: 'guided', why: '', review: id });
  assert.equal((await get(`/api/reviews?project=${q(root)}`)).body.reviews[0].id, id, 'the session is in the queue');

  // the turn ends first (the pilot queues a message while a permission waits)
  const ask = st.pending.find((p) => p.kind === 'permission');
  await post('/api/plan/revue/session/A/answer', { id: ask.id, allow: false });
  await until(async () => (await get('/api/plan/revue')).body.state.find((x) => x.id === 'A').status === 'waiting');
  await post(`/api/review/${id}/comment`, { path: 'keep.txt', side: 'new', line: 3, body: 'Pas de capitale ici.' });
  const s = await post(`/api/review/${id}/submit`, { verdict: 'changes', body: 'Une chose à reprendre.' });
  assert.equal(s.status, 200); assert.equal(s.body.sent, true);
  const prompts = await until(() => { try { const p = readFileSync(path.join(fake.dir, "prompts.jsonl"), "utf8"); return /changements demandés/.test(p) && p; } catch { return null; } });
  const last = prompts.trim().split('\n').map((l) => JSON.parse(l)).find((p) => /changements demandés/.test(p.text));
  assert.equal(last.text, 'Revue : changements demandés.\n\nUne chose à reprendre.\n\n- keep.txt:3 (`C`) : Pas de capitale ici.');
  const msgs = (await get('/api/plan/revue/session/A/messages')).body.messages;
  assert.ok(msgs.some((m) => m.role === 'dev' && /changements demandés/.test(m.text)), 'the message is in the session chat');

  // the levels: a bad value refused; strict blocks the merge until an approve on the current head
  assert.equal((await post('/api/project/settings', { project: root, review: 'loose' })).status, 400);
  assert.equal((await post('/api/project/settings', { project: root, review: 'strict' })).body.settings.review, 'strict');
  r = await get(`/api/review/${id}`); assert.equal(r.body.level, 'strict');
  assert.equal(r.body.mergeAllowed.allowed, false); assert.match(r.body.mergeAllowed.why, /Approbation requise/);
  let m = await post('/api/plan/revue/session/A/merge');
  assert.equal(m.status, 409); assert.equal(m.body.review, id); assert.match(m.body.error, /Approbation requise/);
  assert.equal(sh(root, ['log', '--oneline']).trim().split('\n').length, 1, 'nothing merged');
  assert.equal((await post(`/api/review/${id}/submit`, { verdict: 'approve' })).body.mergeAllowed.allowed, true);
  // the branch moves after the approve: blocked again
  writeFileSync(path.join(st.worktree.path, 'keep.txt'), 'a\nb\nc\nd\ne\nf\n'); commit(st.worktree.path, 'more');
  r = await get(`/api/review/${id}`); assert.equal(r.body.verdict.stale, true); assert.equal(r.body.mergeAllowed.allowed, false); assert.match(r.body.mergeAllowed.why, /Branche modifiée/);
  await post(`/api/review/${id}/submit`, { verdict: 'approve' });
  m = await post('/api/plan/revue/session/A/merge');
  assert.equal(m.status, 200, JSON.stringify(m.body)); assert.match(readFileSync(path.join(root, 'keep.txt'), 'utf8'), /f\n$/);

  // guided and auto let it through without an approve
  for (const level of ['guided', 'auto']) {
    await post('/api/project/settings', { project: root, review: level });
    assert.equal((await get(`/api/review/${id}`)).body.mergeAllowed.allowed, true, level);
  }

  // a stop review: the last reply the session stopped on; retry capped by retryMax, then escalated to the developer
  const perm = await until(async () => (await get('/api/plan/revue')).body.state.find((x) => x.id === 'A').pending.find((p) => p.kind === 'permission'));
  await post('/api/plan/revue/session/A/answer', { id: perm.id, allow: false });
  const reply = await until(async () => { const x = (await get('/api/plan/revue')).body.state.find((y) => y.id === 'A'); return x.status === 'waiting' && x.pending.find((p) => p.kind === 'reply'); });
  await post('/api/project/settings', { project: root, retryMax: 1 });
  const sr = await get('/api/review?plan=revue&session=A&kind=stop');
  assert.equal(sr.status, 200, JSON.stringify(sr.body));
  assert.deepEqual({ kind: sr.body.kind, stop: sr.body.stop.id, files: sr.body.files, retries: sr.body.retries, retryMax: sr.body.retryMax, escalated: sr.body.escalated }, { kind: 'stop', stop: reply.id, files: [], retries: 0, retryMax: 1, escalated: false });
  const sid = sr.body.id;
  assert.equal((await post(`/api/review/${sid}/submit`, { verdict: 'retry', body: '' })).status, 400, 'a retry needs its reason');
  let rt = await post(`/api/review/${sid}/submit`, { verdict: 'retry', body: 'Le test manque.', author: 'pilot' });
  assert.deepEqual({ sent: rt.body.sent, escalated: rt.body.escalated, retries: rt.body.retries }, { sent: true, escalated: false, retries: 1 });
  await until(() => /à refaire \(1\/1\)[\s\S]*Le test manque\./.test(readFileSync(path.join(fake.dir, 'prompts.jsonl'), 'utf8')));
  rt = await post(`/api/review/${sid}/submit`, { verdict: 'retry', body: 'Toujours pas.' });
  assert.deepEqual({ sent: rt.body.sent, escalated: rt.body.escalated }, { sent: false, escalated: true });
  const top = (await get(`/api/reviews?project=${q(root)}`)).body.reviews[0];
  assert.deepEqual({ id: top.id, kind: top.kind, escalated: top.escalated }, { id: sid, kind: 'stop', escalated: true }, 'the escalated review comes first');
  assert.equal((await post(`/api/review/${sid}/submit`, { verdict: 'reject', body: '' })).status, 400, 'a reject needs its reason');
  rt = await post(`/api/review/${sid}/submit`, { verdict: 'reject', body: 'On arrête là.' });
  assert.equal(rt.body.sent, true); assert.equal((await get(`/api/review/${sid}`)).body.escalated, false, 'the developer decided');
  assert.equal(errOut.includes('TypeError'), false, errOut);
});

test('the kinds: image (before and after), doc, plan, each its own review of the same pair', async () => {
  await ready();
  const root = repo();
  const png = (n) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]);
  writeFileSync(path.join(root, 'old.png'), png(1)); commit(root, 'a png');
  sh(root, ['checkout', '-q', '-b', 'design/x']);
  writeFileSync(path.join(root, 'old.png'), png(2)); writeFileSync(path.join(root, 'new.png'), png(3));
  writeFileSync(path.join(root, 'guide.md'), '# Guide\n'); mkdirSync(path.join(root, 'plans')); writeFileSync(path.join(root, 'plans', 'p.json'), '{"id":"p"}\n');
  writeFileSync(path.join(root, 'keep.txt'), 'z\n'); commit(root, 'design'); sh(root, ['checkout', '-q', 'main']);
  const open = (kind) => get(`/api/review?project=${q(root)}&base=main&head=design/x${kind ? '&kind=' + kind : ''}`);
  assert.equal((await open('video')).status, 400);
  const code = (await open()).body; assert.equal(code.kind, 'code'); assert.equal(code.files.length, 5);
  const img = (await open('image')).body;
  assert.notEqual(img.id, code.id, 'another review than the code one');
  const by = Object.fromEntries(img.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(by).sort(), ['new.png', 'old.png']);
  assert.equal(by['new.png'].before, null); assert.match(by['new.png'].after, /\/blob\?path=new\.png&side=new$/);
  const before = await fetch(BASE + by['old.png'].before); const after = await fetch(BASE + by['old.png'].after);
  assert.equal(before.headers.get('content-type'), 'image/png');
  assert.deepEqual([...Buffer.from(await before.arrayBuffer())], [...png(1)], 'before: read at the base');
  assert.deepEqual([...Buffer.from(await after.arrayBuffer())], [...png(2)], 'after: read at head');
  assert.equal((await fetch(`${BASE}/api/review/${img.id}/blob?path=new.png&side=old`)).status, 400, 'an added file has no before');
  assert.deepEqual((await open('doc')).body.files.map((f) => f.path), ['guide.md']);
  const plan = (await open('plan')).body; assert.deepEqual(plan.files.map((f) => f.path), ['plans/p.json']);
  assert.equal(await (await fetch(BASE + plan.files[0].after)).text(), '{"id":"p"}\n');
  assert.equal((await post(`/api/review/${img.id}/submit`, { verdict: 'reject', body: 'Trop sombre.' })).body.sent, false, 'no session behind a pair');
});

// Phase 11, G (Dev, 2 novembre 02:32, Orchard R01 in a kit): a session of a plan delivered as a kit is never merged, so
// its review stays in the server's list; once approved on its last commit the verdict says so (stale false), which the
// page reads to move it from « À relire » to « Relues » (public/projects.js reviewed()); a new commit puts it back
test('a kit session approved on its last commit: still listed, verdict fresh, read by the page as « Relues »; a new commit, to read again', async () => {
  await ready();
  const root = repo();
  const plan = { id: 'kit', title: 'Kit', delivery: 'kit', sessions: [{ id: 'K', name: 'Kit', path: root, model: 'claude-sonnet-5-5', stops: ['La fin'], prompt: 'Écris.' }] };
  assert.equal((await post('/api/plan', plan)).status, 200);
  assert.deepEqual((await post('/api/launch', { plan: 'kit' })).body.launched, ['K']);
  const st = await until(async () => { const s = (await get('/api/plan/kit')).body.state.find((x) => x.id === 'K'); return s.worktree && s; });
  writeFileSync(path.join(st.worktree.path, 'keep.txt'), 'a\nb\nK\nd\ne\n'); commit(st.worktree.path, 'kit work');
  const id = (await get('/api/review?plan=kit&session=K')).body.id;
  assert.equal((await post(`/api/review/${id}/submit`, { verdict: 'approve' })).status, 200);
  const { reviewed, toReview } = pagePredicates();
  let x = (await get(`/api/reviews?project=${q(root)}`)).body.reviews.find((r) => r.id === id);
  assert.ok(x, 'never merged: still listed'); assert.equal(x.verdict.verdict, 'approve'); assert.equal(x.verdict.stale, false);
  assert.equal(reviewed(x), true); assert.equal(toReview([x]).length, 0, 'out of « À relire » and of the counts');
  writeFileSync(path.join(st.worktree.path, 'keep.txt'), 'a\nb\nK\nd\ne\nf\n'); commit(st.worktree.path, 'more');
  x = (await get(`/api/reviews?project=${q(root)}`)).body.reviews.find((r) => r.id === id);
  assert.equal(x.verdict.stale, true); assert.equal(reviewed(x), false, 'the branch moved: to read again');
});
function pagePredicates() { const w = {}; w.window = w; runInNewContext(readFileSync(path.join(HERE, '..', 'public', 'projects.js'), 'utf8'), w); return w.escadrilleProjects; }
