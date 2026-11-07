// The release merges made by the server (lib/release.mjs), on throwaway repositories under the system's temporary
// folder: three clean ticket branches gathered on release/r01, a conflict that writes nothing and names its files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRelease, validateReleases, releaseNote } from '../lib/release.mjs';

const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
let canGit = true; try { sh(tmpdir(), ['--version']); } catch { canGit = false; }
const skip = canGit ? false : 'git ne se lance pas depuis Node ici (bac à sable : spawn EPERM)';

const repo = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-rel-')));
  sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']);
  writeFileSync(path.join(root, 'list.txt'), 'start\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']);
  return root;
};
// A ticket branch from main that writes files, then back on main
const ticket = (root, branch, files) => {
  sh(root, ['checkout', '-q', '-b', branch, 'main']);
  for (const [f, c] of Object.entries(files)) writeFileSync(path.join(root, f), c);
  sh(root, ['add', '.']); sh(root, ['commit', '-qm', branch]); sh(root, ['checkout', '-q', 'main']);
};
const worktrees = (root) => sh(root, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length;

test('three clean branches: release/r01 is built from main with each merge in order, nothing pushed, main untouched', { skip }, async () => {
  const root = repo();
  ticket(root, 'ticket/a', { 'a.txt': 'a\n' }); ticket(root, 'ticket/b', { 'b.txt': 'b\n' }); ticket(root, 'ticket/c', { 'c.txt': 'c\n' });
  const mainBefore = sh(root, ['rev-parse', 'main']);
  const r = await buildRelease({ root, release: 'release/r01', base: 'main', branches: ['ticket/a', 'ticket/b', 'ticket/c'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.merged, ['ticket/a', 'ticket/b', 'ticket/c']); assert.equal(r.created, true);
  assert.equal(sh(root, ['rev-parse', 'release/r01']), r.commit);
  assert.deepEqual(sh(root, ['log', '--merges', '--format=%s', 'release/r01']).split('\n').reverse(), ['Merge ticket/a into release/r01', 'Merge ticket/b into release/r01', 'Merge ticket/c into release/r01']);
  assert.deepEqual(sh(root, ['ls-tree', '--name-only', 'release/r01']).split('\n').sort(), ['a.txt', 'b.txt', 'c.txt', 'list.txt']);
  assert.equal(sh(root, ['rev-parse', 'main']), mainBefore); assert.equal(sh(root, ['branch', '--show-current']), 'main');
  assert.equal(sh(root, ['status', '--porcelain']), '');
  assert.equal(worktrees(root), 1, 'the temporary worktree is gone');
  assert.match(releaseNote(root, r), /3 branche\(s\) fusionnée\(s\) sur main → [0-9a-f]{7}, non poussée/);
  // A rerun with one more ticket merges only what is new, from the existing release
  ticket(root, 'ticket/d', { 'd.txt': 'd\n' });
  const again = await buildRelease({ root, release: 'release/r01', base: 'main', branches: ['ticket/a', 'ticket/b', 'ticket/c', 'ticket/d'] });
  assert.equal(again.ok, true, JSON.stringify(again)); assert.equal(again.created, false);
  assert.equal(sh(root, ['rev-list', '--count', '--merges', 'release/r01']), '4');
});

test('a conflict stops the repository, writes nothing and gives back the conflicting files', { skip }, async () => {
  const root = repo();
  ticket(root, 'ticket/a', { 'a.txt': 'a\n' });
  ticket(root, 'ticket/b', { 'list.txt': 'start\nb\n' });
  ticket(root, 'ticket/c', { 'list.txt': 'start\nc\n', 'c.txt': 'c\n' });
  const refsBefore = sh(root, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const r = await buildRelease({ root, release: 'release/r02', base: 'main', branches: ['ticket/a', 'ticket/b', 'ticket/c'] });
  assert.equal(r.conflict, true, JSON.stringify(r));
  assert.equal(r.branch, 'ticket/c'); assert.deepEqual(r.files, ['list.txt']); assert.deepEqual(r.merged, ['ticket/a', 'ticket/b']);
  assert.equal(sh(root, ['branch', '--list', 'release/r02']), '', 'no release branch written');
  assert.equal(sh(root, ['for-each-ref', '--format=%(refname) %(objectname)']), refsBefore);
  assert.equal(sh(root, ['status', '--porcelain']), ''); assert.equal(worktrees(root), 1);
  assert.match(releaseNote(root, r), /conflit en fusionnant ticket\/c, rien n'est écrit\. Fichiers en conflit : list\.txt/);
  // An existing release stays where it was after a conflict
  const ok = await buildRelease({ root, release: 'release/r02', base: 'main', branches: ['ticket/a'] });
  assert.equal(ok.ok, true);
  const again = await buildRelease({ root, release: 'release/r02', base: 'main', branches: ['ticket/a', 'ticket/b', 'ticket/c'] });
  assert.equal(again.conflict, true); assert.equal(sh(root, ['rev-parse', 'release/r02']), ok.commit);
});

test('refused: a missing branch, a release checked out, the server repository itself', { skip }, async () => {
  const root = repo(); ticket(root, 'ticket/a', { 'a.txt': 'a\n' });
  assert.match((await buildRelease({ root, release: 'release/r03', base: 'main', branches: ['ticket/a', 'ticket/zz'] })).error, /introuvables : ticket\/zz/);
  assert.match((await buildRelease({ root, release: 'release/r03', base: 'nope', branches: ['ticket/a'] })).error, /base introuvable/);
  sh(root, ['branch', 'release/r03', 'main']); sh(root, ['checkout', '-q', 'release/r03']);
  assert.match((await buildRelease({ root, release: 'release/r03', base: 'main', branches: ['ticket/a'] })).error, /branche courante/);
  const own = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  assert.match((await buildRelease({ root: own, release: 'release/x', base: 'main', branches: ['main'] })).error, /dépôt du serveur/);
});

test('validateReleases: the contract of the state block', () => {
  assert.deepEqual(validateReleases([{ release: 'release/r02', base: 'main', branches: ['r02/t1', 'r02/t2'] }]).releases, [{ repo: null, release: 'release/r02', base: 'main', branches: ['r02/t1', 'r02/t2'] }]);
  assert.ok(validateReleases([]).errors);
  assert.ok(validateReleases([{ repo: 'relative/path', release: 'r', base: 'main', branches: ['a'] }]).errors);
  for (const bad of ['-x', '--upload-pack=evil', 'a..b', 'a b', 'HEAD~1', 'x:y', '/abs', 'x.lock']) assert.ok(validateReleases([{ release: 'release/r', base: 'main', branches: [bad] }]).errors, bad);
  assert.ok(validateReleases([{ release: 'release/r', base: 'main', branches: ['a', 'a'] }]).errors);
  assert.ok(validateReleases([{ release: 'release/r', base: 'main', branches: ['release/r'] }]).errors);
  assert.ok(validateReleases([{ release: 'release/r', base: 'main', branches: ['a'] }, { release: 'release/r', base: 'main', branches: ['b'] }]).errors);
});
