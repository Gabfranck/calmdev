// A branch that merged main on the way is not « garde-fou touché » for main's own commits (backlog, 2 November, session Z):
// only the lines the branch brings itself count, committed or not, merge done or still in progress.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { changedFiles } from '../lib/branchfiles.mjs';
import { protectedTouched } from '../lib/guardrails.mjs';
import { testEnv } from './test-env.mjs';

const ENV = { ...testEnv(), ESCADRILLE_GATE: 'off', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const put = (dir, file, text) => { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text); };

// A throwaway repository: main with a guardrail file, a worktree on its branch started from main
const repo = (t) => {
  const root = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'guard-mb-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, 'main'); mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  put(main, 'lib/guardrails.mjs', 'export const a = 1;\n'); put(main, 'README.md', 'hello\n'); put(main, 'app.js', 'x\n');
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'seed');
  const wt = path.join(root, 'wt'); git(main, 'worktree', 'add', '-q', '-b', 'session', wt, 'main');
  return { main, wt };
};
// Main tightens a guardrail after the session started
const mainTightens = (main) => { put(main, 'lib/guardrails.mjs', 'export const a = 2;\n'); git(main, 'commit', '-qam', 'tighten'); };
const files = async (wt, base = 'main') => changedFiles({ cwd: wt, base });

test('a branch that merged main, then changed an ordinary file, touches no guardrail', async (t) => {
  const { main, wt } = repo(t);
  put(wt, 'app.js', 'y\n'); git(wt, 'commit', '-qam', 'own work');
  mainTightens(main);
  git(wt, 'merge', '-q', '--no-edit', 'main');
  put(wt, 'README.md', 'hello again\n'); git(wt, 'commit', '-qam', 'more own work');
  const got = await files(wt);
  assert.deepEqual(got, ['README.md', 'app.js']);
  assert.deepEqual(protectedTouched(got), []);
});

test('a merge of main still in progress (conflict left for the next turn) does not lend main\'s files to the branch', async (t) => {
  const { main, wt } = repo(t);
  put(wt, 'app.js', 'mine\n'); git(wt, 'commit', '-qam', 'own work');
  mainTightens(main); put(main, 'app.js', 'theirs\n'); git(main, 'commit', '-qam', 'main app');
  assert.throws(() => git(wt, 'merge', '--no-edit', 'main')); // conflict on app.js; lib/guardrails.mjs staged from main
  assert.match(git(wt, 'status', '--porcelain'), /^M {2}lib\/guardrails\.mjs$/m);
  const got = await files(wt);
  assert.deepEqual(protectedTouched(got), []);
  assert.ok(got.includes('app.js'));
  // The server's reading before this fix (base...HEAD plus git status, merge in progress ignored) lent it main's guardrail
  const blind = (cwd, args) => args[0] === 'rev-parse' ? Promise.resolve(null) : Promise.resolve(execFileSync('git', args, { cwd, env: ENV }).toString());
  assert.deepEqual(protectedTouched(await changedFiles({ cwd: wt, base: 'main', git: blind })), ['lib/guardrails.mjs']);
});

test('the same branch that changes a guardrail itself is flagged, committed or loose, merged main or not', async (t) => {
  const { main, wt } = repo(t);
  mainTightens(main);
  git(wt, 'merge', '-q', '--no-edit', 'main');
  put(wt, 'lib/guardrails.mjs', 'export const a = 3;\n'); git(wt, 'commit', '-qam', 'loosen');
  assert.deepEqual(protectedTouched(await files(wt)), ['lib/guardrails.mjs']);
  put(wt, 'CLAUDE.md', 'rules\n');
  assert.deepEqual(protectedTouched(await files(wt)), ['CLAUDE.md', 'lib/guardrails.mjs']);
});

test('during a merge in progress, a guardrail the session edits by hand on top of main\'s version still counts', async (t) => {
  const { main, wt } = repo(t);
  put(wt, 'app.js', 'mine\n'); git(wt, 'commit', '-qam', 'own work');
  mainTightens(main); put(main, 'app.js', 'theirs\n'); git(main, 'commit', '-qam', 'main app');
  assert.throws(() => git(wt, 'merge', '--no-edit', 'main'));
  put(wt, 'lib/guardrails.mjs', 'export const a = 0;\n');
  assert.deepEqual(protectedTouched(await files(wt)), ['lib/guardrails.mjs']);
});

test('a rebase onto main and a worktree without a known base keep the current behaviour', async (t) => {
  const { main, wt } = repo(t);
  put(wt, 'app.js', 'y\n'); git(wt, 'commit', '-qam', 'own work');
  mainTightens(main);
  git(wt, 'rebase', '-q', 'main');
  assert.deepEqual(await files(wt), ['app.js']);
  // No base: only what is not committed yet, as before
  put(wt, 'README.md', 'loose\n');
  assert.deepEqual(await files(wt, null), ['README.md']);
  // An unknown base: the diff fails, the loose files remain
  assert.deepEqual(await files(wt, 'no-such-branch'), ['README.md']);
});
