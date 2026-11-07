// Approve and merge (Dev, 6 novembre, docs/review.md « Approuver »): an approve on a finished session merges it at once,
// locally; a session not finished is not merged; a merge that cannot go (a conflict) keeps the approve and gives its reason;
// nothing reaches a remote nor the gh command during the merge, and the diff of this branch never calls them.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeClaude } from './fake-claude.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };
// a project with a remote: whatever the merge does, the remote must not move
const repo = () => {
  const remote = tmp('escadrille-apr-remote-'); sh(remote, ['init', '-q', '--bare', '-b', 'main']);
  const root = tmp('escadrille-apr-');
  sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']);
  writeFileSync(path.join(root, 'keep.txt'), 'a\n'); sh(root, ['add', '-A']); sh(root, ['commit', '-qm', 'start']);
  sh(root, ['remote', 'add', 'origin', remote]); sh(root, ['push', '-q', 'origin', 'main']);
  return { root, remote };
};
// a gh on the PATH that leaves a mark if anything calls it
const bin = tmp('escadrille-apr-bin-'); const ghMark = path.join(bin, 'gh-called');
writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\ntouch '${ghMark}'\nexit 1\n`); chmodSync(path.join(bin, 'gh'), 0o755);

// turn 1 writes out.txt and stops, not done; turn 2 (after a message) says done
const fake = fakeClaude();
const PORT = await freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:${process.env.PATH}`, PORT: String(PORT), ESCADRILLE_TRANSCRIPTS: tmp('escadrille-transcripts-'), ESCADRILLE_DB: path.join(tmp('escadrille-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-plans-'), ESCADRILLE_CLAUDE: fake.file, FAKE_CLAUDE_TURNS: JSON.stringify([{ write: 'out.txt', stops: [0], done: false }, { stops: [0, 1], done: true, hold: 1500 }]) }, stdio: ['ignore', 'pipe', 'pipe'] });
let errOut = ''; server.stderr.on('data', (d) => { errOut += d; });
after(() => server.kill('SIGINT'));
const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
const ready = () => until(async () => { try { return (await get('/api/plans')).status === 200; } catch { return false; } }, 20000);
const rowOf = async (plan) => (await get('/api/plan/' + plan)).body.state.find((x) => x.id === 'A');
const launch = async (id, root) => {
  assert.equal((await post('/api/plan', { id, title: id, sessions: [{ id: 'A', name: 'Une', path: root, model: 'claude-sonnet-5-5', stops: ['Le travail', 'La fin'], prompt: 'Écris.' }] })).status, 200);
  assert.deepEqual((await post('/api/launch', { plan: id })).body.launched, ['A']);
  return until(async () => { const s = await rowOf(id); return s.status === 'waiting' && s.worktree && s; });
};
const finish = async (id) => { await post(`/api/plan/${id}/session/A/message`, { text: 'Termine.' }); return until(async () => { const s = await rowOf(id); return s.status === 'done' && s; }); };

test('an approve on a finished session merges it locally (merged: true); not finished, nothing merged; no push, no gh', async () => {
  await ready();
  const { root, remote } = repo(); const remoteHead = sh(remote, ['rev-parse', 'main']);
  await launch('apr-ok', root);
  let r = await get('/api/review?plan=apr-ok&session=A'); assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.id;
  // its turn is running: Approve alone, nothing merged
  await post('/api/plan/apr-ok/session/A/message', { text: 'Encore.' });
  await until(async () => (await rowOf('apr-ok')).status === 'running');
  assert.equal((await get(`/api/review/${id}`)).body.mergeOnApprove, false, 'a turn running: Approve alone');
  let s = await post(`/api/review/${id}/submit`, { verdict: 'approve' });
  assert.equal(s.status, 200); assert.equal(s.body.merged, false); assert.equal(s.body.mergeBlocked, undefined);
  assert.equal(existsSync(path.join(root, 'out.txt')), false, 'a session in the middle of a turn is not merged');

  await until(async () => (await rowOf('apr-ok')).status !== 'running');
  r = await get(`/api/review/${id}`); assert.equal(r.body.mergeOnApprove, true, 'finished: Approve and merge');
  s = await post(`/api/review/${id}/submit`, { verdict: 'approve' });
  assert.equal(s.status, 200, JSON.stringify(s.body)); assert.equal(s.body.merged, true, JSON.stringify(s.body));
  assert.ok(existsSync(path.join(root, 'out.txt')), 'the work is on main');
  assert.equal((await rowOf('apr-ok')).worktree.merged, true);
  // local only: the remote has not moved, gh was never called
  assert.equal(sh(remote, ['rev-parse', 'main']), remoteHead, 'nothing pushed');
  assert.equal(sh(remote, ['for-each-ref']).trim().split('\n').length, 1, 'no new ref on the remote');
  assert.equal(existsSync(ghMark), false, 'gh never called');
  assert.equal(errOut.includes('TypeError'), false, errOut);
});

// 6 novembre, 21:04: APPS, FONT, ARCH and APP, waiting on Dev's word at their last stop, were approved and never merged
test('an approve on a session waiting on the developer merges it and closes it', async () => {
  await ready();
  const { root } = repo();
  await launch('apr-wait', root);
  const r = await get('/api/review?plan=apr-wait&session=A'); assert.equal(r.body.mergeOnApprove, true, 'waiting: Approve and merge');
  const s = await post(`/api/review/${r.body.id}/submit`, { verdict: 'approve' });
  assert.equal(s.body.merged, true, JSON.stringify(s.body));
  assert.ok(existsSync(path.join(root, 'out.txt')), 'the work is on main');
  const row = await rowOf('apr-wait');
  assert.equal(row.worktree.merged, true); assert.equal(row.status, 'done', 'the approve answered its last question');
  assert.equal(row.pending.some((p) => p.kind === 'reply'), false, 'nothing left waiting in « À toi »');
});

// 6 novembre, 22:55: APPS, ARCH and FONT, merged by hand into main, still said « Réponds à » in « À toi »
test('a session waiting on the developer, merged by hand outside the server, is closed like an approve', async () => {
  await ready();
  const { root } = repo();
  const w = await launch('apr-hand', root);
  sh(root, ['merge', '--no-ff', '-q', '-m', 'merge by hand', w.worktree.branch]);
  const row = await until(async () => { const s = await rowOf('apr-hand'); return s.worktree.merged && s; });
  assert.equal(row.worktree.outside, true);
  assert.equal(row.status, 'done', 'the hand merge answered its last question');
  assert.equal(row.pending.some((p) => p.kind === 'reply'), false, 'nothing left waiting in « À toi »');
  assert.match(readFileSync(path.join(HERE, '..', 'server.mjs'), 'utf8'), /if \(m \|\| !existsSync\(wt\.root\)\) \{ if \(r\.status === 'waiting'\)/, 'one marked merged before this close is closed too');
});

test('an approve on a session in conflict: the approve is kept, the reason comes back, nothing merged', async () => {
  await ready();
  const { root, remote } = repo(); const remoteHead = sh(remote, ['rev-parse', 'main']);
  await launch('apr-conflict', root);
  await finish('apr-conflict');
  writeFileSync(path.join(root, 'out.txt'), 'autre chose sur main\n'); sh(root, ['add', '-A']); sh(root, ['commit', '-qm', 'main moves']);
  const id = (await get('/api/review?plan=apr-conflict&session=A')).body.id;
  const s = await post(`/api/review/${id}/submit`, { verdict: 'approve' });
  assert.equal(s.status, 200, JSON.stringify(s.body)); assert.equal(s.body.merged, false);
  assert.equal(s.body.mergeBlocked.kind, 'conflict', JSON.stringify(s.body)); assert.match(s.body.mergeBlocked.why, /out\.txt/);
  const back = (await get(`/api/review/${id}`)).body;
  assert.equal(back.verdict.verdict, 'approve', 'the approve is kept');
  assert.equal(back.mergeBlocked.kind, 'conflict', 'the reason is still there on reload');
  assert.equal((await rowOf('apr-conflict')).worktree.merged, false);
  assert.equal(sh(remote, ['rev-parse', 'main']), remoteHead, 'nothing pushed'); assert.equal(existsSync(ghMark), false);
});

test('the code of this change never calls push, gh nor a PR route', () => {
  const src = ['lib/review.mjs', 'public/review.html'].map((f) => path.join(HERE, '..', f));
  // the lines of approve-and-merge: from its comment to the end of the submit and of the page's helpers
  for (const f of src) {
    const text = readFileSync(f, 'utf8');
    const start = text.indexOf('Approve and merge (Dev, 6 novembre)'); assert.ok(start >= 0, f);
    const block = text.slice(start, text.indexOf('\n};', start) + 3);
    assert.doesNotMatch(block, /\bpush\b|\bgh\b|\/pr\b|github\.com|api\.github/i, f);
  }
  const helpers = readFileSync(path.join(HERE, '..', 'lib/review.mjs'), 'utf8');
  const h = helpers.slice(helpers.indexOf('const mergeOnApprove'), helpers.indexOf('export const submit'));
  assert.ok(h.length > 100); assert.doesNotMatch(h, /\bpush\b|\bgh\b|\/pr\b/);
});
