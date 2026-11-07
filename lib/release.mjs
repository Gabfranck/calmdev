// The release merges of a sprint delivered as a kit (docs/sessions.md, « Les fusions de release »). A release session
// cannot write in .git from its sandbox; it writes the list of merges in its escadrille:state block and the server,
// outside the sandbox, makes them here. git only, fixed arguments, never a push, never a command of the session.
//
//   validateReleases(list)                    → { releases: [{ repo, release, base, branches }] } | { errors }
//   buildRelease({ root, release, base, branches })
//     → { ok: true, release, base, merged, commit, created }       the release branch points to the merged commit
//     | { conflict: true, release, branch, files }                 nothing written: the release branch is as it was
//     | { error, release }                                         a missing branch, a release checked out somewhere…
//
// The merges run in a temporary detached worktree (under the system's temporary folder), from the tip of the release
// branch when it exists (a rerun merges only what is new), else from base. Only when every branch is merged does the
// release ref move, by an update-ref that checks its old value. The temporary worktree is removed by its own path in
// every case (never a global 'git worktree prune').
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const git = (cwd, args) => new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: 60000, maxBuffer: 4e6 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(out).trim()))));
const lines = (s) => s.split('\n').filter(Boolean);

// A branch name the session gives: refused when git would read it as an option or a range, or check-ref-format does not
// accept it (checked again by git at run time)
const NAME = /^(?!-)(?!.*\.\.)(?!.*[\s~^:?*[\\])[\w./@+-]{1,200}$/;
export const validName = (n) => typeof n === 'string' && NAME.test(n) && !n.endsWith('/') && !n.endsWith('.lock') && !n.startsWith('/');

export const validateReleases = (list) => {
  if (!Array.isArray(list) || !list.length) return { errors: ['releases : un tableau non vide'] };
  if (list.length > 20) return { errors: ['releases : 20 dépôts au plus'] };
  const errors = []; const releases = [];
  list.forEach((r, i) => {
    const at = `releases[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) { errors.push(`${at} : un objet`); return; }
    const repo = r.repo === undefined || r.repo === null || r.repo === '' ? null : r.repo;
    if (repo !== null && (typeof repo !== 'string' || !path.isAbsolute(repo))) errors.push(`${at}.repo : un chemin absolu (ou rien : le dépôt de la session)`);
    if (!validName(r.release)) errors.push(`${at}.release : un nom de branche`);
    if (!validName(r.base)) errors.push(`${at}.base : un nom de branche`);
    const branches = Array.isArray(r.branches) ? r.branches : null;
    if (!branches || !branches.length || branches.length > 50 || !branches.every(validName)) errors.push(`${at}.branches : de 1 à 50 noms de branche, dans l'ordre`);
    else if (new Set(branches).size !== branches.length) errors.push(`${at}.branches : une branche en double`);
    else if (branches.includes(r.release)) errors.push(`${at}.branches : la branche release elle-même`);
    releases.push({ repo, release: r.release, base: r.base, branches: branches || [] });
  });
  const seen = new Set();
  for (const r of releases) { const k = `${r.repo ?? ''}|${r.release}`; if (seen.has(k)) errors.push(`releases : ${r.release} deux fois dans le même dépôt`); seen.add(k); }
  return errors.length ? { errors } : { releases };
};

// Under node --test, never the repository this code lives in (the same guard as lib/worktree.mjs)
const OWN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guard = async (root) => {
  if (!process.env.NODE_TEST_CONTEXT) return;
  const common = async (p) => { try { return realpathSync(await git(p, ['rev-parse', '--path-format=absolute', '--git-common-dir'])); } catch { return null; } };
  const mine = await common(OWN); if (mine && mine === await common(root)) throw new Error('test : refusé sur le dépôt du serveur, utilise un dépôt jetable');
};

const commitOf = async (root, ref) => { try { return await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]); } catch { return null; } };

// One release build at a time per repository
const running = new Map();
export const buildRelease = (args) => {
  const key = path.resolve(String(args.root || ''));
  const run = (running.get(key) || Promise.resolve()).catch(() => {}).then(() => buildNow(args));
  running.set(key, run); run.finally(() => { if (running.get(key) === run) running.delete(key); }).catch(() => {});
  return run;
};

const buildNow = async ({ root, release, base, branches }) => {
  const fail = (error) => ({ error, release });
  if (!root || !existsSync(root)) return fail('dépôt introuvable');
  if (![release, base, ...(branches || [])].every(validName) || !branches?.length) return fail('noms de branche invalides');
  try { await guard(root); } catch (e) { return fail(e.message); }
  try { await git(root, ['check-ref-format', '--branch', release]); } catch { return fail(`${release} : nom de branche refusé par git`); }
  const ref = `refs/heads/${release}`;
  const old = await commitOf(root, ref);
  // A release branch checked out in a worktree (the main checkout included) would see its files go stale under it
  const out = lines(await git(root, ['worktree', 'list', '--porcelain']).catch(() => ''));
  const at = out.findIndex((l) => l === `branch ${ref}`);
  if (at >= 0) { let w = ''; for (let i = at; i >= 0; i--) if (out[i].startsWith('worktree ')) { w = out[i].slice(9); break; } return fail(`${release} est la branche courante de ${w} : change de branche là-bas, puis relance`); }
  const start = old || await commitOf(root, `refs/heads/${base}`);
  if (!start) return fail(`branche de base introuvable : ${base}`);
  const missing = []; for (const b of branches) if (!await commitOf(root, `refs/heads/${b}`)) missing.push(b);
  if (missing.length) return fail(`branches introuvables : ${missing.join(', ')}`);

  const dir = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-release-'))), 'w');
  let added = false;
  try {
    await git(root, ['worktree', 'add', '--detach', '--quiet', dir, start]); added = true;
    const merged = [];
    for (const b of branches) {
      try { await git(dir, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${b} into ${release}`, `refs/heads/${b}`]); merged.push(b); } catch (e) {
        let files = []; try { files = lines(await git(dir, ['diff', '--name-only', '--diff-filter=U'])); } catch {}
        try { await git(dir, ['merge', '--abort']); } catch {}
        if (!files.length) return fail(`fusion de ${b} impossible : ${e.message.split('\n')[0]}`);
        return { conflict: true, release, branch: b, merged, files };
      }
    }
    const commit = await git(dir, ['rev-parse', 'HEAD']);
    // The old value is checked: a release that moved in the meantime is not overwritten
    await git(root, ['update-ref', '-m', `escadrille: release ${release}`, ref, commit, old || '0'.repeat(commit.length)]);
    return { ok: true, release, base, merged, commit, created: !old };
  } catch (e) { return fail(e.message.split('\n')[0]); }
  finally {
    if (added) { try { await git(root, ['worktree', 'remove', '--force', dir]); } catch {} }
    rmSync(path.dirname(dir), { recursive: true, force: true });
  }
};

// The line handed back to the session (and shown in the page) for one result
export const releaseNote = (repo, r) => {
  const where = path.basename(repo || '') || repo;
  if (r.ok) return `Release ${r.release} (${where}) : ${r.merged.length} branche(s) fusionnée(s) sur ${r.created ? r.base : 'la release existante'} → ${r.commit.slice(0, 7)}, non poussée.`;
  if (r.conflict) return `Release ${r.release} (${where}) : conflit en fusionnant ${r.branch}, rien n'est écrit. Fichiers en conflit : ${r.files.join(', ')}. Résous-le sur ${r.branch} (ou une branche de résolution placée avant), commite, puis renvoie la liste.`;
  return `Release ${r.release} (${where}) : non construite, ${r.error}.`;
};
