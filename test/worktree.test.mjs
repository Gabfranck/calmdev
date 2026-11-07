// The worktrees of the launched sessions, on a throwaway git repository: create, clean merge, conflict, remove.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, realpathSync, rmSync, renameSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gitRoot, create, merge, remove } from '../lib/worktree.mjs';
import * as names from '../lib/names.mjs';

const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const repo = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-wt-')));
  sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']);
  mkdirSync(path.join(root, 'app')); writeFileSync(path.join(root, 'app', 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']);
  return root;
};

test('gitRoot finds the top of the repository, null outside one', async () => {
  const root = repo();
  assert.equal(await gitRoot(path.join(root, 'app')), root);
  assert.equal(await gitRoot(realpathSync(mkdtempSync(path.join(tmpdir(), 'nogit-')))), null);
});

test('create makes the worktree on its branch, excludes the folder, keeps the subfolder; a second call reuses it', async () => {
  const root = repo();
  const w = await create({ root, plan: 'p1', session: 'A', path: path.join(root, 'app') });
  assert.equal(w.path, path.join(root, '.claude', 'worktrees', 'p1-A'));
  assert.equal(w.branch, 'calmdev/p1/A');
  assert.equal(w.cwd, path.join(w.path, 'app'));
  assert.equal(sh(w.path, ['branch', '--show-current']), 'calmdev/p1/A');
  assert.ok(readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8').includes('.claude/worktrees/'));
  assert.equal(sh(root, ['status', '--porcelain']), '');
  const again = await create({ root, plan: 'p1', session: 'A', path: root });
  assert.equal(again.cwd, w.path);
});

test('merge brings the branch back with --no-ff and removes the worktree but keeps the branch', async () => {
  const root = repo();
  const w = await create({ root, plan: 'p1', session: 'A' });
  writeFileSync(path.join(w.path, 'b.txt'), 'deux\n'); sh(w.path, ['add', '.']); sh(w.path, ['commit', '-qm', 'B']);
  assert.deepEqual(await merge({ root, branch: w.branch, message: 'Merge A' }), { ok: true });
  assert.equal(sh(root, ['log', '-1', '--format=%s']), 'Merge A');
  assert.ok(existsSync(path.join(root, 'b.txt')));
  await remove({ root, path: w.path });
  assert.ok(!existsSync(w.path));
  assert.equal(sh(root, ['branch', '--list', w.branch]).trim(), 'calmdev/p1/A');
});

test('a session whose escadrille/… branch exists keeps it, a new one gets calmdev/…; both merge, neither is renamed', async () => {
  const root = repo();
  sh(root, ['branch', 'escadrille/p1/OLD']); // made before the rename (BLK, 7 November)
  const old = await create({ root, plan: 'p1', session: 'OLD' });
  const neu = await create({ root, plan: 'p1', session: 'NEW' });
  assert.equal(old.branch, 'escadrille/p1/OLD'); assert.equal(neu.branch, 'calmdev/p1/NEW');
  assert.equal(sh(old.path, ['branch', '--show-current']), 'escadrille/p1/OLD');
  writeFileSync(path.join(old.path, 'old.txt'), 'o\n'); sh(old.path, ['add', '.']); sh(old.path, ['commit', '-qm', 'old']);
  writeFileSync(path.join(neu.path, 'new.txt'), 'n\n'); sh(neu.path, ['add', '.']); sh(neu.path, ['commit', '-qm', 'new']);
  assert.deepEqual(await merge({ root, branch: old.branch, message: `Merge ${old.branch}: ancienne` }), { ok: true });
  assert.deepEqual(await merge({ root, branch: neu.branch, message: `Merge ${neu.branch}: nouvelle` }), { ok: true });
  assert.ok(existsSync(path.join(root, 'old.txt')) && existsSync(path.join(root, 'new.txt')));
  assert.equal(sh(root, ['branch', '--list', 'calmdev/p1/OLD']), '', 'the old branch is never renamed');
  assert.deepEqual(sh(root, ['branch', '--merged', 'main', '--format=%(refname:short)']).split('\n').filter((b) => names.isSessionBranch(b)).sort(), ['calmdev/p1/NEW', 'escadrille/p1/OLD']);
  // the QA's search of a plan's merges (server.mjs, git log --grep) finds both forms
  const merges = sh(root, ['log', '--format=%s', '--fixed-strings', ...names.BRANCH_PREFIXES.flatMap((b) => ['--grep', `${b}p1/`])]).split('\n');
  assert.deepEqual(merges.sort(), ['Merge calmdev/p1/NEW: nouvelle', 'Merge escadrille/p1/OLD: ancienne']);
});

test('merge goes through uncommitted work on other files, and refuses naming the files the branch also touches', async () => {
  const root = repo();
  const w = await create({ root, plan: 'p1', session: 'A' });
  writeFileSync(path.join(w.path, 'b.txt'), 'deux\n'); writeFileSync(path.join(w.path, 'app', 'a.txt'), 'branche\n'); sh(w.path, ['add', '.']); sh(w.path, ['commit', '-qm', 'B']);
  // an untracked b.txt of the checkout no longer refuses: it is set aside and given back (test/defects8.test.mjs)
  writeFileSync(path.join(root, 'app', 'a.txt'), 'sale\n');
  await assert.rejects(merge({ root, branch: w.branch, message: 'm' }), /app\/a\.txt/);
  writeFileSync(path.join(root, 'app', 'a.txt'), 'un\n');
  writeFileSync(path.join(root, 'dessin.svg'), '<svg/>\n'); mkdirSync(path.join(root, 'illus')); writeFileSync(path.join(root, 'illus', 'x.png'), 'x');
  assert.deepEqual(await merge({ root, branch: w.branch, message: 'Merge A' }), { ok: true });
  assert.equal(readFileSync(path.join(root, 'app', 'a.txt'), 'utf8'), 'branche\n');
  assert.ok(existsSync(path.join(root, 'dessin.svg')) && existsSync(path.join(root, 'illus', 'x.png')), 'the other work stays');
});

test('a conflict aborts the merge and names the files', async () => {
  const root = repo();
  const w = await create({ root, plan: 'p1', session: 'B' });
  writeFileSync(path.join(w.path, 'app', 'a.txt'), 'branche\n'); sh(w.path, ['commit', '-qam', 'B']);
  writeFileSync(path.join(root, 'app', 'a.txt'), 'main\n'); sh(root, ['commit', '-qam', 'main']);
  assert.deepEqual(await merge({ root, branch: w.branch, message: 'm' }), { conflict: true, files: ['app/a.txt'] });
  assert.equal(sh(root, ['status', '--porcelain']), '');
  assert.equal(readFileSync(path.join(root, 'app', 'a.txt'), 'utf8'), 'main\n');
});

test('lines only appended to the memory file (POST /api/memory) never block a merge and are never lost, even in a conflict', async () => {
  const root = repo(); const dec = path.join(root, 'docs', 'decisions.md'); const read = () => readFileSync(dec, 'utf8');
  mkdirSync(path.join(root, 'docs')); writeFileSync(dec, '# Décisions\n- a\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'dec']);
  const w = await create({ root, plan: 'p1', session: 'M' });
  writeFileSync(path.join(w.path, 'docs', 'decisions.md'), '# Décisions\n- a\n- de la branche\n'); sh(w.path, ['commit', '-qam', 'branch line']);
  writeFileSync(dec, '# Décisions\n- a\n- mémoire 1\n- mémoire 2\n');
  // without memoryFile, the refusal as before
  await assert.rejects(merge({ root, branch: w.branch, message: 'm' }), /non commités.*docs\/decisions\.md/);
  assert.equal(read(), '# Décisions\n- a\n- mémoire 1\n- mémoire 2\n');
  assert.deepEqual(await merge({ root, branch: w.branch, message: 'Merge M', memoryFile: dec }), { ok: true });
  assert.equal(sh(root, ['show', 'HEAD:docs/decisions.md']), '# Décisions\n- a\n- de la branche');
  assert.equal(read(), '# Décisions\n- a\n- de la branche\n- mémoire 1\n- mémoire 2\n');
  assert.equal(sh(root, ['status', '--porcelain']), 'M docs/decisions.md');
  // a conflict on the memory file: aborted, the appended lines are back as they were
  sh(root, ['commit', '-qam', 'memory']);
  const c = await create({ root, plan: 'p1', session: 'C' });
  writeFileSync(path.join(c.path, 'docs', 'decisions.md'), '# Décisions\n- réécrit\n'); sh(c.path, ['commit', '-qam', 'rewrite']);
  writeFileSync(dec, read().replace('- a\n', '- a modifié\n')); sh(root, ['commit', '-qam', 'main edit']);
  const before = read(); writeFileSync(dec, before + '- mémoire 3\n');
  assert.deepEqual(await merge({ root, branch: c.branch, message: 'm', memoryFile: dec }), { conflict: true, files: ['docs/decisions.md'] });
  assert.equal(read(), before + '- mémoire 3\n');
  // a change that is not only appended lines, or another dirty file of the branch: refused as before, nothing touched
  writeFileSync(dec, before.replace('- a modifié', '- édité') + '- mémoire 3\n');
  await assert.rejects(merge({ root, branch: c.branch, message: 'm', memoryFile: dec }), /non commités.*docs\/decisions\.md/);
  writeFileSync(dec, before + '- mémoire 3\n');
  const o = await create({ root, plan: 'p1', session: 'O' });
  writeFileSync(path.join(o.path, 'docs', 'decisions.md'), before + '- o\n'); writeFileSync(path.join(o.path, 'app', 'a.txt'), 'o\n'); sh(o.path, ['commit', '-qam', 'o']);
  writeFileSync(path.join(root, 'app', 'a.txt'), 'sale\n');
  await assert.rejects(merge({ root, branch: o.branch, message: 'm', memoryFile: dec }), (e) => /app\/a\.txt/.test(e.message) && !/decisions/.test(e.message));
  assert.equal(read(), before + '- mémoire 3\n');
});

test('create never prunes the other worktrees: only its own stale entry goes; under node --test the server repository is refused', async () => {
  const root = repo(); const admin = (n) => path.join(root, '.git', 'worktrees', n);
  const x = await create({ root, plan: 'p', session: 'X' });
  renameSync(x.path, x.path + '-elsewhere'); // X's folder out of sight, as from a sandbox: a global prune would drop its entry
  mkdirSync(path.join(root, '.claude', 'worktrees', 'p-Y')); // a leftover empty folder, not registered
  const y = await create({ root, plan: 'p', session: 'Y' });
  assert.equal(sh(y.path, ['branch', '--show-current']), 'calmdev/p/Y');
  assert.ok(existsSync(admin('p-X')), "X's admin entry is still there");
  const z = await create({ root, plan: 'p', session: 'Z' });
  rmSync(z.path, { recursive: true, force: true }); // Z's own folder gone: its own stale entry is replaced
  const z2 = await create({ root, plan: 'p', session: 'Z' });
  assert.equal(sh(z2.path, ['branch', '--show-current']), 'calmdev/p/Z');
  assert.ok(existsSync(admin('p-X')), 'still there after Z came back');
  renameSync(x.path + '-elsewhere', x.path);
  assert.equal(sh(x.path, ['branch', '--show-current']), 'calmdev/p/X','X works again once its folder is back');
  assert.ok(process.env.NODE_TEST_CONTEXT, 'node --test sets NODE_TEST_CONTEXT');
  const own = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  await assert.rejects(create({ root: own, plan: 'p', session: 'danger' }), /dépôt du serveur/);
  await assert.rejects(merge({ root: own, branch: 'main', message: 'm' }), /dépôt du serveur/);
  await assert.rejects(remove({ root: own, path: path.join(own, 'nope') }), /dépôt du serveur/);
});

test('create copies the CLAUDE.md files the repository ignores, read-only, never committed; a tracked one is left alone', async () => {
  const root = repo();
  writeFileSync(path.join(root, '.gitignore'), 'CLAUDE.md\nCLAUDE.local.md\n.claude/CLAUDE.md\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'ignore']);
  mkdirSync(path.join(root, '.claude'), { recursive: true });
  writeFileSync(path.join(root, 'CLAUDE.md'), 'rules\n'); writeFileSync(path.join(root, 'CLAUDE.local.md'), 'mine\n'); writeFileSync(path.join(root, '.claude', 'CLAUDE.md'), 'inner\n');
  const w = await create({ root, plan: 'p1', session: 'A' });
  for (const [f, text] of [['CLAUDE.md', 'rules\n'], ['CLAUDE.local.md', 'mine\n'], ['.claude/CLAUDE.md', 'inner\n']]) {
    assert.equal(readFileSync(path.join(w.path, f), 'utf8'), text);
    assert.equal(statSync(path.join(w.path, f)).mode & 0o777, 0o444);
  }
  sh(w.path, ['add', '-A']); assert.equal(sh(w.path, ['status', '--porcelain']), '');
  await create({ root, plan: 'p1', session: 'A' }); // a second call refreshes without failing on the read-only copy
  assert.equal(readFileSync(path.join(w.path, 'CLAUDE.md'), 'utf8'), 'rules\n');
  // a repository that tracks its CLAUDE.md: the worktree has its own checked-out file, writable, untouched
  const tracked = repo(); writeFileSync(path.join(tracked, 'CLAUDE.md'), 'v1\n'); sh(tracked, ['add', '.']); sh(tracked, ['commit', '-qm', 'rules']);
  const w2 = await create({ root: tracked, plan: 'p1', session: 'A' });
  assert.equal(readFileSync(path.join(w2.path, 'CLAUDE.md'), 'utf8'), 'v1\n');
  assert.notEqual(statSync(path.join(w2.path, 'CLAUDE.md')).mode & 0o200, 0);
  // no CLAUDE.md anywhere: nothing appears
  const bare = await create({ root: repo(), plan: 'p1', session: 'A' });
  assert.equal(existsSync(path.join(bare.path, 'CLAUDE.md')), false);
});

test('remove archives the uncommitted .escadrille/ of the worktree before deleting it, never over an older archive', async () => {
  const root = repo();
  const w = await create({ root, plan: 'p1', session: 'A' });
  mkdirSync(path.join(w.path, '.calmdev', 'captures'), { recursive: true });
  writeFileSync(path.join(w.path, '.calmdev', 'passation.md'), 'la suite\n');
  writeFileSync(path.join(w.path, '.calmdev', 'captures', 'a.png'), 'png');
  const r = await remove({ root, path: w.path });
  const arch = path.join(root, '.calmdev', 'archive', 'p1-A');
  assert.equal(existsSync(w.path), false);
  assert.equal(r.archived, arch);
  assert.equal(readFileSync(path.join(arch, 'passation.md'), 'utf8'), 'la suite\n');
  assert.equal(readFileSync(path.join(arch, 'captures', 'a.png'), 'utf8'), 'png');
  // the same worktree again: the first archive stays, the second gets a timestamped folder
  const w2 = await create({ root, plan: 'p1', session: 'A' });
  assert.ok(lstatSync(path.join(w2.path, '.escadrille')).isSymbolicLink(), 'a new worktree has .calmdev/ and the old name as a link');
  mkdirSync(path.join(w2.path, '.calmdev'), { recursive: true }); writeFileSync(path.join(w2.path, '.calmdev', 'passation.md'), 'deuxième\n');
  const r2 = await remove({ root, path: w2.path });
  assert.notEqual(r2.archived, arch); assert.ok(path.basename(r2.archived).startsWith('p1-A-'));
  assert.equal(readFileSync(path.join(arch, 'passation.md'), 'utf8'), 'la suite\n');
  assert.equal(readFileSync(path.join(r2.archived, 'passation.md'), 'utf8'), 'deuxième\n');
  assert.equal(sh(root, ['status', '--porcelain']), '');
  // nothing to archive: removal as before
  const w3 = await create({ root, plan: 'p1', session: 'B' });
  assert.equal((await remove({ root, path: w3.path })).archived, null);
  assert.equal(existsSync(w3.path), false);
});

test('the archive leaves tree copies, node_modules and files over 5 MB, and names them in LAISSE.txt', async () => {
  const root = repo();
  const w = await create({ root, plan: 'p1', session: 'C' });
  const d = path.join(w.path, '.calmdev');
  mkdirSync(path.join(d, 'captures'), { recursive: true });
  writeFileSync(path.join(d, 'passation.md'), 'la suite\n'); writeFileSync(path.join(d, 'captures', 'a.png'), 'png'); writeFileSync(path.join(d, 'test.out'), 'ok\n');
  mkdirSync(path.join(d, 'before', 'node_modules'), { recursive: true });
  writeFileSync(path.join(d, 'before', 'server.mjs'), '//'); writeFileSync(path.join(d, 'before', 'node_modules', 'x.js'), 'x');
  mkdirSync(path.join(d, 'copie')); writeFileSync(path.join(d, 'copie', 'package.json'), '{}');
  mkdirSync(path.join(d, 'tri-trees')); writeFileSync(path.join(d, 'tri-trees', 'a'), 'a');
  writeFileSync(path.join(d, 'gros.bin'), Buffer.alloc(6 * 1024 * 1024)); writeFileSync(path.join(d, 'petit.bin'), Buffer.alloc(4 * 1024 * 1024));
  const r = await remove({ root, path: w.path });
  const arch = r.archived;
  assert.equal(readFileSync(path.join(arch, 'passation.md'), 'utf8'), 'la suite\n');
  assert.equal(readFileSync(path.join(arch, 'captures', 'a.png'), 'utf8'), 'png');
  assert.equal(readFileSync(path.join(arch, 'test.out'), 'utf8'), 'ok\n');
  assert.ok(existsSync(path.join(arch, 'petit.bin')));
  for (const n of ['before', 'copie', 'tri-trees', 'gros.bin']) assert.equal(existsSync(path.join(arch, n)), false, n);
  const laisse = readFileSync(path.join(arch, 'LAISSE.txt'), 'utf8');
  for (const n of ['before/ :', 'copie/ : copie d\'arbre (package.json', 'tri-trees/ :', 'gros.bin : fichier de plus de 5 Mo']) assert.ok(laisse.includes(n), n);
  assert.ok(!laisse.includes('node_modules'), 'before/ is left whole, one line');
  assert.ok(!laisse.includes('server.mjs') || laisse.includes('before/'), 'before/ is named');
  // nothing left behind: no LAISSE.txt
  const w2 = await create({ root, plan: 'p1', session: 'D' });
  writeFileSync(path.join(w2.path, '.calmdev', 'passation.md'), 'x\n');
  const r2 = await remove({ root, path: w2.path });
  assert.equal(existsSync(path.join(r2.archived, 'LAISSE.txt')), false);
});

test('a node_modules alone is named in LAISSE.txt', async () => {
  const root = repo();
  const w = await create({ root, plan: 'p1', session: 'E' });
  mkdirSync(path.join(w.path, '.calmdev', 'node_modules'), { recursive: true }); writeFileSync(path.join(w.path, '.calmdev', 'node_modules', 'x'), 'x');
  writeFileSync(path.join(w.path, '.calmdev', 'passation.md'), 'x\n');
  const r = await remove({ root, path: w.path });
  assert.match(readFileSync(path.join(r.archived, 'LAISSE.txt'), 'utf8'), /node_modules\/ : dépendances/);
});

test('a failed copy still does not stop the removal', async () => {
  const root = repo();
  const w = await create({ root, plan: 'p1', session: 'F' });
  writeFileSync(path.join(w.path, '.calmdev', 'passation.md'), 'x\n');
  mkdirSync(path.join(root, '.calmdev'), { recursive: true }); writeFileSync(path.join(root, '.calmdev', 'archive'), 'un fichier, pas un dossier');
  const r = await remove({ root, path: w.path });
  assert.equal(r.archived, null); assert.equal(existsSync(w.path), false);
});
