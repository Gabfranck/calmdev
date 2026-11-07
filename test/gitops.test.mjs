// lib/gitops.mjs (docs/gitops.md): the GIT: lines of a session, in a throwaway repository with a submodule
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tokenize, parseGit, plan, repoOf, gitRun, gitNote, createGitOps, INSTRUCTION, MAX_PER_TURN } from '../lib/gitops.mjs';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ident = (dir) => { sh(dir, 'config', 'user.name', 'Test'); sh(dir, 'config', 'user.email', 'test@example.invalid'); };

const setup = () => {
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'gitops-')));
  const src = path.join(tmp, 'src'); const wt = path.join(tmp, 'wt'); const outside = path.join(tmp, 'outside');
  for (const [dir, file] of [[src, 'a.txt'], [wt, 'readme.txt'], [outside, 'x.txt']]) {
    execFileSync('mkdir', ['-p', dir]); sh(dir, 'init', '-q', '-b', 'main'); ident(dir);
    writeFileSync(path.join(dir, file), 'one\n'); sh(dir, 'add', '.'); sh(dir, 'commit', '-q', '-m', 'init');
  }
  sh(wt, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', src, 'backend'); sh(wt, 'commit', '-q', '-m', 'sub');
  sh(wt, 'switch', '-q', '-c', 'work');
  const sub = path.join(wt, 'backend'); ident(sub); sh(sub, 'switch', '-q', '-c', 'dev');
  symlinkSync(outside, path.join(wt, 'escape'));
  return { tmp, wt, sub, outside };
};

test('tokenize keeps quoted messages whole', () => {
  assert.deepEqual(tokenize('commit -m "fix: le \\"bug\\"" a.txt').words, ['commit', '-m', 'fix: le "bug"', 'a.txt']);
  assert.ok(tokenize('commit -m "open').error);
});

test('parseGit: lines alone on their line, unique, at most MAX_PER_TURN', () => {
  const text = 'Je fusionne.\nGIT: -C backend commit -a -m "x"\n> GIT: branch feat\nvoir GIT: push\nGIT: branch feat\n' + Array.from({ length: 6 }, (_, i) => `GIT: branch b${i}`).join('\n');
  const got = parseGit(text, { claude: 'GIT: switch dev' });
  assert.equal(got.length, MAX_PER_TURN);
  assert.deepEqual(got.slice(0, 2), ['-C backend commit -a -m "x"', 'branch feat']);
  assert.ok(!INSTRUCTION.includes('\n') && INSTRUCTION.split(/[.!?](\s|$)/).filter((s) => s && s.trim()).length === 1);
});

test('plan refuses with a one-line reason', () => {
  const no = (line) => { const r = plan(tokenize(line).words); assert.ok(r.error, line); assert.ok(!r.error.includes('\n')); return r.error; };
  for (const v of ['push origin dev', 'fetch', 'pull', 'remote add x y', 'reset --hard', 'clean -fd', 'rebase main', 'worktree prune']) assert.match(no(v), /refusé/);
  no('merge main'); no('merge --squash feat'); no('branch -D feat'); no('commit --amend -m x'); no('commit -m "x" --no-verify');
  no('switch main'); no('branch master'); no('commit -m "x" ../out.txt'); no('commit -m "x" /etc/passwd'); no('switch -feat');
  no('commit -a -m "x" a.txt'); no('-C backend');
  assert.deepEqual(plan(tokenize('commit -m "feat: x Co-Authored-By: Claude <c@x>"').words).steps, [['commit', '-m', 'feat: x']]);
  assert.deepEqual(plan(tokenize('merge --no-ff feat').words).steps, [['merge', '--no-ff', '--no-edit', 'feat']]);
});

test('repoOf: realpath inside the worktree, root of a repo', () => {
  const { wt, sub } = setup();
  assert.equal(repoOf(wt, 'backend').dir, sub);
  assert.equal(repoOf(wt, '.').repo, '.');
  assert.match(repoOf(wt, '../outside').error, /sort du worktree/);
  assert.match(repoOf(wt, 'escape').error, /sort du worktree/);
  assert.match(repoOf(wt, '/tmp').error, /relatif/);
  assert.match(repoOf(null, '.').error, /aucun worktree/);
});

test('in a repo with a submodule: commit, branch, merge --no-ff and fast-forward succeed; push, outside and worktree prune are refused', async () => {
  const { wt, sub, outside } = setup();
  const go = (line) => gitRun({ line, worktree: wt });
  // submodule: a ticket branch, a commit of a new file, merged --no-ff into dev
  assert.equal((await go('-C backend branch ticket-12')).ok, true);
  assert.equal((await go('-C backend switch ticket-12')).ok, true);
  writeFileSync(path.join(sub, 'new.txt'), 'n\n');
  const c = await go('-C backend commit -m "feat: new Co-Authored-By: Claude <c@x>" new.txt');
  assert.equal(c.ok, true, gitNote(c)); assert.equal(c.repo, 'backend');
  assert.equal(sh(sub, 'log', '-1', '--format=%B'), 'feat: new');
  assert.equal((await go('-C backend switch dev')).ok, true);
  const m = await go('-C backend merge --no-ff ticket-12');
  assert.equal(m.ok, true, gitNote(m));
  assert.equal(sh(sub, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3); // a merge commit
  // worktree root: a branch, a commit -a, a fast-forward
  assert.equal((await go('branch topic')).ok, true);
  assert.equal((await go('switch topic')).ok, true);
  writeFileSync(path.join(wt, 'readme.txt'), 'two\n');
  assert.equal((await go('commit -a -m "docs: two"')).ok, true);
  assert.equal((await go('switch work')).ok, true);
  const ff = await go('merge --ff-only topic');
  assert.equal(ff.ok, true, gitNote(ff)); assert.equal(sh(wt, 'rev-parse', 'work'), sh(wt, 'rev-parse', 'topic'));
  // refused, nothing run
  const head = sh(wt, 'rev-parse', 'HEAD');
  for (const line of ['push origin work', '-C ../outside commit -a -m "x"', '-C escape branch evil', 'worktree prune']) {
    const r = await go(line); assert.equal(r.ok, false, line); assert.equal(r.refused, true, line); assert.match(gitNote(r), /refusé : /);
  }
  assert.equal(sh(outside, 'branch', '--list', 'evil'), '');
  // main is refused everywhere, the submodule included
  sh(sub, 'switch', '-q', 'main');
  assert.match((await go('-C backend merge --no-ff dev')).error, /main et master/);
  assert.match((await go('-C backend commit -a -m "x"')).error, /main et master/);
  assert.equal(sh(wt, 'rev-parse', 'HEAD'), head);
  // a filter in the repository's own config: refused before anything runs
  sh(sub, 'switch', '-q', 'dev'); sh(sub, 'config', 'filter.evil.clean', 'touch pwned');
  assert.match((await go('-C backend branch other')).error, /config du dépôt/);
});

test('createGitOps: one log line per gesture, the note to the session, idle once done', async () => {
  const { wt } = setup();
  const logs = []; const notes = []; let idle = 0;
  const ops = createGitOps({ record: (r) => logs.push(r), onNote: (p, s, line) => notes.push(line), onIdle: () => { idle++; }, projectOfPlan: () => '/p' });
  assert.equal(ops.ofTurn('plan', 'GIT', 'Fait.\nGIT: branch ticket-1\nGIT: push origin work\n', null, wt), 2);
  await new Promise((r) => { const t = setInterval(() => { if (notes.length === 2) { clearInterval(t); r(); } }, 20); });
  assert.equal(logs.length, 2); assert.equal(idle, 1);
  assert.match(logs[0].text, /session GIT, dépôt \.\) : git branch ticket-1 → code 0/);
  assert.match(logs[1].text, /refusé/);
  assert.match(notes[0], /^GIT branch ticket-1 \(\.\) : ok \(code 0\)/);
  assert.equal(ops.ofTurn('plan', 'GIT', 'rien', null, wt), 0);
});
