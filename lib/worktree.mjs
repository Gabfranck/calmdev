// The git worktree of a launched session. The server creates one per session next to the project
// (<root>/.claude/worktrees/<plan>-<session>, branch calmdev/<plan>/<session>, or its escadrille/… branch when it has one), merges it on the
// developer's say-so, and removes it. Everything goes through execFile with fixed arguments: the
// ids come from the plan on disk, never from the browser.
//
//   gitRoot(path)                           the top of the repository that holds path, or null
//   create({ root, plan, session, path, base? })  → { path, branch, cwd, base }  (cwd: the same subfolder as path, inside the worktree;
//                                              base: the branch it started from, the default base of its PR: the given base (plan.base,
//                                              refused when it does not exist), else the branch open in root, null when detached)
//   merge({ root, branch, rev?, message, memoryFile? })  → { ok: true } | { conflict: true, files }   (refused when a modified tracked file of
//                                              root is also in the branch; an untracked one is set aside and given back, see merge;
//                                              so are the lines only appended to memoryFile, see appendedTail)
//   remove({ root, path })                  → { ok, archived }  deletes the worktree, keeps the branch; its .escadrille/ is
//                                              first copied to <root>/.escadrille/archive/<name>/ (archived: that folder, or null)
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, realpathSync, symlinkSync, lstatSync, copyFileSync, chmodSync, cpSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as names from './names.mjs';

const git = (cwd, args) => new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: 30000, maxBuffer: 4e6 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(out).trim()))));
const safe = (id) => String(id ?? '').replace(/[^\w.-]/g, '_');

export const gitRoot = async (p) => { try { return await git(p, ['rev-parse', '--show-toplevel']); } catch { return null; } };

// Under node --test, never the repository this code lives in: a test works on a throwaway repository under $TMPDIR.
// (On 2026-11-01 at 09:08 the admin entries of three live worktrees vanished: a global prune, run where it could
// not see them, took them; see docs/sessions.md, « La robustesse ».)
const OWN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guard = async (root) => {
  if (!process.env.NODE_TEST_CONTEXT || !root) return;
  const common = async (p) => { try { return realpathSync(await git(p, ['rev-parse', '--path-format=absolute', '--git-common-dir'])); } catch { return null; } };
  const mine = await common(OWN); if (mine && mine === await common(root)) throw new Error('test : refusé sur le dépôt du serveur, utilise un dépôt jetable');
};

export const create = async ({ root, plan, session, path: subdir, base: wanted }) => {
  if (!root || !existsSync(root)) throw new Error('dépôt introuvable');
  await guard(root);
  // A given base (plan.base) must exist: never a silent start from the branch open in root (2026-11-02, backlog l. 57)
  if (wanted) { let ok = !String(wanted).startsWith('-'); if (ok) { try { await git(root, ['rev-parse', '--verify', '--quiet', `${wanted}^{commit}`]); } catch { ok = false; } } if (!ok) throw new Error(`base « ${wanted} » introuvable dans ${root}`); }
  const name = `${safe(plan)}-${safe(session)}`;
  // calmdev/<plan>/<session> for a new session; a session whose escadrille/… branch already exists keeps it (never renamed)
  const legacy = names.legacySessionBranch(safe(plan), safe(session));
  const branch = (await git(root, ['branch', '--list', legacy])) !== '' ? legacy : names.sessionBranch(safe(plan), safe(session));
  const dir = path.join(root, '.claude', 'worktrees', name);
  // .claude/worktrees/ stays out of git status (the EnterWorktree tool of Claude Code does the same); so does
  // .escadrille/, where a session leaves its handoff file (passation.md) for the fresh session that follows it
  const commonDir = await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const exclude = path.join(commonDir, 'info', 'exclude');
  const lines = existsSync(exclude) ? readFileSync(exclude, 'utf8').split('\n') : [];
  const missing = ['.claude/worktrees/', `${names.PROJECT_DIR}/`, `${names.LEGACY_PROJECT_DIR}/`, names.LEGACY_PROJECT_DIR, 'node_modules'].filter((l) => !lines.includes(l));
  if (missing.length) { mkdirSync(path.dirname(exclude), { recursive: true }); appendFileSync(exclude, '\n' + missing.join('\n') + '\n'); }
  let base = wanted ? String(wanted) : null; if (!base) { try { base = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch {} if (base === 'HEAD') base = null; }
  const registered = (await git(root, ['worktree', 'list', '--porcelain'])).split('\n').some((l) => l === 'worktree ' + dir);
  // Never a global 'git worktree prune': it drops every worktree whose folder this process cannot see (a sandbox,
  // another checkout). Only the admin entry of THIS name goes, and only when its gitdir points to this folder.
  if (!registered || !existsSync(path.join(dir, '.git'))) {
    const admin = path.join(commonDir, 'worktrees', name);
    let ours = false; try { ours = path.resolve(readFileSync(path.join(admin, 'gitdir'), 'utf8').trim()) === path.join(dir, '.git'); } catch {}
    if (ours) rmSync(admin, { recursive: true, force: true });
    const exists = (await git(root, ['branch', '--list', branch])) !== '';
    await git(root, exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', dir, '-b', branch, ...(wanted ? [String(wanted)] : [])]);
  }
  // Each tracked package.json whose folder has node_modules in the main checkout but not in the worktree gets a
  // symlink to it (never committed: 'node_modules' is in info/exclude); the linked folders go to the session's addDirs
  const linked = [];
  for (const pj of (await git(root, ['ls-files', '--', 'package.json', '*/package.json'])).split('\n').filter(Boolean)) {
    const rel = path.dirname(pj); const src = path.join(root, rel, 'node_modules'); const dst = path.join(dir, rel, 'node_modules');
    let there = false; try { lstatSync(dst); there = true; } catch {}
    if (!there && existsSync(src) && existsSync(path.dirname(dst))) { try { symlinkSync(src, dst, 'dir'); linked.push(src); } catch {} }
  }
  await copyIgnoredRules({ root, dir });
  // .calmdev/ and its old name as a link: a session still told .escadrille/ (CLAUDE.md) writes into the same folder
  try { names.ensureProjectDir(dir); } catch (e) { console.error(`worktree: ${names.PROJECT_DIR} de ${dir} impossible : ${e.message}`); }
  const rel = subdir ? path.relative(root, subdir) : '';
  const cwd = rel && !rel.startsWith('..') ? path.join(dir, rel) : dir;
  return { path: dir, branch, cwd: existsSync(cwd) ? cwd : dir, base, linked };
};

// The project rules a repository keeps out of git (CLAUDE.md in .gitignore, as Orchard-v2 does) are not in a fresh
// worktree, so the session would not read them. Each of these files that exists in the main checkout, is ignored by
// git and tracked by nobody is copied read-only (444): it stays ignored, hence never committed, and the session
// cannot edit the developer's copy by mistake. A file the branch tracks is the worktree's own: untouched.
const RULE_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];
const copyIgnoredRules = async ({ root, dir }) => {
  const copied = [];
  for (const f of RULE_FILES) {
    const src = path.join(root, f); const dst = path.join(dir, f);
    try {
      if (!lstatSync(src).isFile()) continue;
      if (await git(root, ['ls-files', '--', f]) || await git(dir, ['ls-files', '--', f])) continue;
      if (!await git(root, ['check-ignore', '--', f]).catch(() => '')) continue;
      rmSync(dst, { force: true }); mkdirSync(path.dirname(dst), { recursive: true });
      copyFileSync(src, dst); chmodSync(dst, 0o444); copied.push(f);
    } catch {}
  }
  return copied;
};

// The uncommitted files of the checkout (modified, staged or untracked) that the branch also touches: those
// alone block a merge; work in progress elsewhere in the checkout (an illustrator's files) stays where it is
const lines = (s) => s.split('\n').filter(Boolean);
export const blockingFiles = async ({ root, branch }) => {
  const dirty = new Set([...lines(await git(root, ['diff', '--name-only', 'HEAD'])), ...lines(await git(root, ['ls-files', '--others', '--exclude-standard']))]);
  if (!dirty.size) return [];
  return lines(await git(root, ['diff', '--name-only', `HEAD...${branch}`])).filter((f) => dirty.has(f));
};
// An untracked file of the checkout that the branch also brings (a plan the server wrote in plans/, not committed
// yet) no longer blocks: it is set aside (kept in memory and copied under <git-common-dir>/escadrille-aside/), the
// merge runs, then the file of the disk comes back, as it was (a conflict) or over the merged one when they differ
// (it shows as modified: the server stays the author of its plans). Never a reset nor a clean of the checkout.
const overwritten = (msg) => { const m = /untracked working tree files would be overwritten by merge:\n([\s\S]*?)\n(?:Please|Aborting)/.exec(msg); return m ? lines(m[1]).map((l) => l.trim()) : []; };
// One merge at a time per checkout: two sessions done together would see each other's conflict (and abort it)
const merging = new Map();
export const merge = (args) => {
  const key = path.resolve(String(args.root || ''));
  const run = (merging.get(key) || Promise.resolve()).catch(() => {}).then(() => mergeNow(args));
  merging.set(key, run); run.finally(() => { if (merging.get(key) === run) merging.delete(key); }).catch(() => {});
  return run;
};
// The project's memory file (docs/decisions.md, server.mjs memoryFileOf) gets lines appended by POST /api/memory without a
// commit. When its only change is lines added at the end, it no longer blocks: the tail is set aside (also copied under
// <git-common-dir>/escadrille-aside/), the file goes back to HEAD, the merge runs, then the tail is appended again to
// whatever the file is now (merged, or HEAD after an abort), minus the lines the merge already brought. Never lost.
const appendedTail = async (root, rel) => {
  let head; try { head = await new Promise((res, rej) => execFile('git', ['show', `HEAD:${rel}`], { cwd: root, encoding: 'buffer', maxBuffer: 4e7 }, (e, out) => (e ? rej(e) : res(out)))); } catch { return null; }
  let disk; try { disk = readFileSync(path.join(root, rel)); } catch { return null; }
  if (disk.length < head.length || !disk.subarray(0, head.length).equals(head)) return null;
  return { head, tail: disk.subarray(head.length) };
};
const appendBack = (abs, head, tail) => {
  let now = ''; try { now = readFileSync(abs, 'utf8'); } catch {}
  // only the lines the merge brought count as already there: a tail line equal to an older line of the file stays
  const old = new Set(String(head).split('\n'));
  const have = new Set(now.split('\n').filter((l) => l.trim() && !old.has(l)));
  const keep = String(tail).split('\n').filter((l, i, all) => !(l.trim() && have.has(l)) && !(i === all.length - 1 && l === '')).join('\n');
  if (!keep.trim()) return;
  const sep = now && !now.endsWith('\n') ? '\n' : '';
  mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, now + sep + keep + (String(tail).endsWith('\n') ? '\n' : ''));
};
// rev: the commit to merge (the one a guardrail approval named, docs/autonomy.md), the branch's head by default;
// memoryFile: the absolute path of the project's memory file, whose appended lines never block (see appendedTail)
const mergeNow = async ({ root, branch, rev = null, message, memoryFile = null }) => {
  await guard(root);
  const what = rev || branch;
  const untracked = new Set(lines(await git(root, ['ls-files', '--others', '--exclude-standard'])));
  const blocking = await blockingFiles({ root, branch: what });
  let refused = blocking.filter((f) => !untracked.has(f));
  let memory = null;
  const memRel = memoryFile ? path.relative(root, path.resolve(memoryFile)).split(path.sep).join('/') : null;
  if (memRel && !memRel.startsWith('..') && refused.includes(memRel)) {
    const t = await appendedTail(root, memRel);
    if (t) { memory = { rel: memRel, abs: path.join(root, memRel), ...t }; refused = refused.filter((f) => f !== memRel); }
  }
  if (refused.length) throw new Error(`le dépôt a des changements non commités sur des fichiers de la branche : ${refused.join(', ')} ; commite ou range-les avant de fusionner`);
  if (memory) {
    memory.dir = path.join(await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'escadrille-aside', `memory-${Date.now()}`);
    memory.copy = path.join(memory.dir, memory.rel);
    mkdirSync(path.dirname(memory.copy), { recursive: true }); writeFileSync(memory.copy, Buffer.concat([memory.head, memory.tail]));
    if (await git(root, ['diff', '--cached', '--name-only', '--', memory.rel])) await git(root, ['reset', '-q', '--', memory.rel]);
    writeFileSync(memory.abs, memory.head);
  }
  try { return await mergeAside({ root, branch, what, message, untracked, blocking: blocking.filter((f) => f !== memory?.rel) }); }
  finally {
    if (memory) { try { appendBack(memory.abs, memory.head, memory.tail); rmSync(memory.dir, { recursive: true, force: true }); } catch (e) { console.error(`worktree: lignes de mémoire gardées dans ${memory.copy} : ${e.message}`); } }
  }
};
const mergeAside = async ({ root, branch, what, message, untracked, blocking }) => {
  const aside = new Map(); let backup = null;
  const setAside = async (files) => {
    if (!backup) backup = path.join(await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'escadrille-aside', String(Date.now()));
    for (const f of files) {
      const abs = path.join(root, f); if (aside.has(f) || !existsSync(abs)) continue;
      const data = readFileSync(abs); const copy = path.join(backup, f); mkdirSync(path.dirname(copy), { recursive: true }); writeFileSync(copy, data);
      aside.set(f, data); rmSync(abs);
    }
  };
  const giveBack = () => {
    for (const [f, data] of aside) { const abs = path.join(root, f); let now = null; try { now = readFileSync(abs); } catch {} if (!now || !now.equals(data)) { mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, data); } }
    if (backup) rmSync(backup, { recursive: true, force: true });
  };
  await setAside(blocking);
  try {
    for (let tries = 0; ; tries++) {
      try { await git(root, ['merge', '--no-ff', '-m', message || `Merge ${branch}`, what]); return { ok: true }; } catch (e) {
        const more = overwritten(e.message).filter((f) => untracked.has(f) && !aside.has(f));
        if (more.length && tries < 2) { await setAside(more); continue; }
        let files = [];
        try { files = (await git(root, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean); } catch {}
        try { await git(root, ['merge', '--abort']); } catch {}
        if (!files.length) throw e;
        return { conflict: true, files };
      }
    }
  } finally { giveBack(); }
};

// The .escadrille/ of a worktree (handoff, captures, outputs) is never committed: before the worktree goes, it is
// copied to <root>/.escadrille/archive/<worktree name>/ (a timestamped name when that folder already exists). A copy
// that fails is logged and never stops the removal.
// The archive keeps what helps to resume (handoff, captures, outputs), not copies of the tree: a folder named before,
// *-base*, tri-trees, public-solo* or node_modules, a folder holding a package.json or a server.mjs at its root, and
// any file over 5 MB stay behind. LAISSE.txt, at the top of the archive, says in one line each what was left and why.
const ARCHIVE_MAX_FILE = 5 * 1024 * 1024;
const treeCopyReason = (abs, name) => {
  if (name === 'node_modules') return 'dépendances (node_modules)';
  if (name === 'before' || name === 'tri-trees' || name.startsWith('public-solo') || /-base/.test(name)) return `copie d'arbre (dossier « ${name} »)`;
  for (const marker of ['package.json', 'server.mjs']) if (existsSync(path.join(abs, marker))) return `copie d'arbre (${marker} à sa racine)`;
  return null;
};
const archiveFilter = (src, left) => (p) => {
  const rel = path.relative(src, p);
  if (!rel) return true;
  let st; try { st = lstatSync(p); } catch { return true; }
  let why = null;
  if (st.isDirectory()) why = treeCopyReason(p, path.basename(p));
  else if (st.isFile() && st.size > ARCHIVE_MAX_FILE) why = `fichier de plus de 5 Mo (${(st.size / 1048576).toFixed(1)} Mo)`;
  if (why) left.push(`${rel.split(path.sep).join('/')}${st.isDirectory() ? '/' : ''} : ${why}`);
  return !why;
};

export const archiveEscadrille = ({ root, path: dir, now = new Date() }) => {
  // an empty .calmdev/ (every worktree gets one at its creation) has nothing to keep
  const src = [names.projectDir(dir), names.legacyProjectDir(dir)].find((p) => { try { return readdirSync(p).length > 0; } catch { return false; } });
  if (!src) return null;
  const base = names.projectDir(root, 'archive');
  let dst = path.join(base, path.basename(dir));
  if (existsSync(dst)) { const stamp = now.toISOString().replace(/[:.]/g, '-'); dst = `${dst}-${stamp}`; for (let i = 2; existsSync(dst); i++) dst = `${path.join(base, path.basename(dir))}-${stamp}-${i}`; }
  const left = [];
  try {
    mkdirSync(base, { recursive: true });
    cpSync(src, dst, { recursive: true, errorOnExist: true, force: false, filter: archiveFilter(src, left) });
    if (left.length) { try { writeFileSync(path.join(dst, 'LAISSE.txt'), `Laissé hors de l'archive (copies d'arbre et gros fichiers) :\n${left.join('\n')}\n`); } catch (e) { console.error(`worktree: LAISSE.txt impossible : ${e.message}`); } }
    return dst;
  } catch (e) { console.error(`worktree: archive de ${src} vers ${dst} impossible : ${e.message}`); return null; }
};

export const remove = async ({ root, path: dir }) => {
  await guard(root);
  let archived = null;
  if (dir && existsSync(dir)) { archived = archiveEscadrille({ root, path: dir }); await git(root, ['worktree', 'remove', '--force', dir]); }
  return { ok: true, archived };
};

// Whether a branch still exists in the repository (a merge removes the worktree and keeps the branch)
export const branchExists = async ({ root, branch }) => { try { return (await git(root, ['branch', '--list', branch])) !== ''; } catch { return false; } };
// The branch checked out at root, or null (detached)
export const currentBranch = async (root) => { try { const b = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']); return b === 'HEAD' ? null : b; } catch { return null; } };
