// lib/mergedin.mjs on throwaway repositories (Harbor, 3 November): a branch merged outside the server is seen, against its
// declared target or through a merge commit in another branch; a fresh branch or a copy of it never is; the guarded files
// of a session count against its real target (the PR branch), not the branch its worktree started from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mergedInto, targetOf, mergedWaitingOver, staleError, HEALTH_CLEARED } from '../lib/mergedin.mjs';
import { changedFiles } from '../lib/branchfiles.mjs';

const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const put = (root, f, text = f + '\n') => { mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); writeFileSync(path.join(root, f), text); };
const commit = (root, f, m = f) => { put(root, f); sh(root, ['add', '.']); sh(root, ['commit', '-qm', m]); return sh(root, ['rev-parse', 'HEAD']); };
// dev, a PR branch feat/pr off dev with 17 migrations, and a session branch off dev with one commit of its own
const repo = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-mergedin-')));
  sh(root, ['init', '-q', '-b', 'dev']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 'Pilote']);
  commit(root, 'a.txt', 'start');
  sh(root, ['checkout', '-qb', 'feat/pr']); for (let i = 1; i <= 17; i++) put(root, `db/migrations/${String(i).padStart(3, '0')}.sql`); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'migrations']);
  sh(root, ['checkout', '-q', 'dev']);
  sh(root, ['checkout', '-qb', 'escadrille/p/J']); const start = sh(root, ['rev-parse', 'HEAD']); commit(root, 'src/j.ts', 'J'); sh(root, ['checkout', '-q', 'dev']);
  return { root, start };
};

test('targetOf: the session’s base, else the plan’s, else the branch the worktree started from', () => {
  const plan = { base: 'feat/pr', sessions: [{ id: 'J' }, { id: 'K', base: 'feat/other' }] };
  assert.equal(targetOf(plan, 'J', { base: 'dev' }), 'feat/pr');
  assert.equal(targetOf(plan, 'K', { base: 'dev' }), 'feat/other');
  assert.equal(targetOf({ sessions: [{ id: 'J' }] }, 'J', { base: 'dev' }), 'dev');
  assert.equal(targetOf({ sessions: [] }, 'J', {}), null);
});

test('a branch merged into its declared target (git merge of the pilot): the merge commit, its author and the base before it', async () => {
  const { root, start } = repo();
  assert.equal(await mergedInto({ root, branch: 'escadrille/p/J', targets: ['feat/pr'], start }), null, 'not merged yet');
  sh(root, ['checkout', '-q', 'feat/pr']); const before = sh(root, ['rev-parse', 'HEAD']);
  sh(root, ['merge', '--no-ff', '-q', '-m', 'merge J', 'escadrille/p/J']); const m = sh(root, ['rev-parse', 'HEAD']); sh(root, ['checkout', '-q', 'dev']);
  const r = await mergedInto({ root, branch: 'escadrille/p/J', targets: ['feat/pr', 'dev'], start });
  assert.equal(r.into, 'feat/pr'); assert.equal(r.commit, m); assert.equal(r.by, 'Pilote'); assert.equal(r.base, before); assert.ok(r.at);
});

// 7 November, ARC: merged by the server on the 5th, then woken again, it still waited on its old stop
test('mergedWaitingOver: a waiting row the server merged is over while its branch is in its target, not after a new commit', async () => {
  const { root } = repo();
  const branch = 'escadrille/p/J';
  const row = (extra = {}, wt = {}) => ({ status: 'waiting', ...extra, worktree: { root, branch, base: 'dev', merged: true, mergedInto: 'dev', ...wt } });
  assert.equal(await mergedWaitingOver({ row: row() }), false, 'not in dev yet');
  sh(root, ['merge', '--no-ff', '-q', '-m', 'merge J', branch]);
  assert.equal(await mergedWaitingOver({ row: row() }), true);
  assert.equal(await mergedWaitingOver({ row: row({ status: 'running' }) }), false, 'a session at work is left alone');
  assert.equal(await mergedWaitingOver({ row: row({}, { outside: true }) }), false, 'merged outside: the other path');
  assert.equal(await mergedWaitingOver({ row: row({}, { merged: false }) }), false);
  sh(root, ['checkout', '-q', branch]); commit(root, 'src/more.ts', 'more'); sh(root, ['checkout', '-q', 'dev']);
  assert.equal(await mergedWaitingOver({ row: row() }), false, 'a new commit since the merge: the session goes on');
});

test('staleError: only a merged session that is over drops its old error', () => {
  const row = (status, merged, health = 'error') => ({ status, health, worktree: { merged } });
  assert.equal(staleError(row('done', true)), true);
  assert.equal(staleError(row('done', false)), false, 'not merged: the error stands');
  assert.equal(staleError(row('waiting', true)), false, 'still waiting: the other path closes it first');
  assert.equal(staleError(row('done', true, 'ok')), false);
  assert.deepEqual({ ...HEALTH_CLEARED }, { health: 'ok', why: '' });
  // every close and every merge of server.mjs clears it
  const src = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'server.mjs'), 'utf8');
  assert.ok((src.match(/HEALTH_CLEARED/g) || []).length >= 6, 'the merge, the three closes and the sweep');
});

test('a fast forward: the tip itself, no author', async () => {
  const { root, start } = repo();
  sh(root, ['merge', '--ff-only', '-q', 'escadrille/p/J']); // into dev, checked out
  const r = await mergedInto({ root, branch: 'escadrille/p/J', targets: ['dev'], start });
  assert.equal(r.into, 'dev'); assert.equal(r.commit, sh(root, ['rev-parse', 'escadrille/p/J'])); assert.equal(r.by, null); assert.equal(r.base, null);
});

test('a branch without a commit of its own is never merged, from start or from its reflog', async () => {
  const { root } = repo();
  sh(root, ['branch', 'escadrille/p/N', 'dev']);
  const tip = sh(root, ['rev-parse', 'escadrille/p/N']);
  assert.equal(await mergedInto({ root, branch: 'escadrille/p/N', targets: ['dev'], start: tip }), null);
  assert.equal(await mergedInto({ root, branch: 'escadrille/p/N', targets: ['dev'] }), null, 'the oldest reflog entry is its start');
});

test('an undeclared branch that holds it through a merge commit counts; a copy (checkout -b) or a later session’s branch does not', async () => {
  const { root, start } = repo();
  sh(root, ['branch', 'copie', 'escadrille/p/J']); sh(root, ['branch', 'escadrille/p/K', 'escadrille/p/J']);
  assert.equal(await mergedInto({ root, branch: 'escadrille/p/J', targets: ['dev'], start }), null, 'a copy and a later session hold it without a merge');
  sh(root, ['checkout', '-q', 'feat/pr']); sh(root, ['merge', '--no-ff', '-q', '-m', 'merge J', 'escadrille/p/J']); const m = sh(root, ['rev-parse', 'HEAD']); sh(root, ['checkout', '-q', 'dev']);
  const r = await mergedInto({ root, branch: 'escadrille/p/J', targets: ['dev'], start });
  assert.equal(r.into, 'feat/pr'); assert.equal(r.commit, m);
});

test('the guarded files count against the real target: 17 migrations against dev, none against the PR branch', async () => {
  const { root } = repo();
  const wt = path.join(root, '..', path.basename(root) + '-wt'); sh(root, ['worktree', 'add', '-q', wt, 'escadrille/p/J']);
  sh(wt, ['merge', '-q', '--no-edit', 'feat/pr']); // the session keeps up with its PR branch
  const againstDev = await changedFiles({ cwd: wt, base: 'dev' });
  assert.equal(againstDev.filter((f) => f.includes('migrations/')).length, 17, 'the old count, against worktree.base');
  const target = targetOf({ base: 'feat/pr', sessions: [{ id: 'J' }] }, 'J', { base: 'dev' });
  assert.deepEqual(await changedFiles({ cwd: wt, base: target }), ['src/j.ts']);
});
