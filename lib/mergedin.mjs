// Where a session's branch was merged, when it was merged outside the server (a `git merge` of the pilot or of the
// developer into the branch of a PR, Harbor on 3 November): the server never saw it, the session stayed « à relire » and
// held the next waves. Read only, through git, on the repository the session's worktree belongs to.
//
//   targetOf(plan, sid, wt)  → the branch the session will be merged into: the session's declared base, else the plan's
//                              (plan.base), else the branch its worktree started from (wt.base); null when none is known
//   mergedInto({ root, branch, targets, start, git }) → null | { into, commit, by, at, base }
//       into: the branch that holds the tip; commit: the merge commit that brought it (the tip itself after a fast forward);
//       by: that commit's author (null after a fast forward); at: its date; base: the first parent of the merge (what the
//       target was before it, the base of the diff shown read-only), null after a fast forward.
//
// A branch is merged when its tip is an ancestor of a declared target (git merge-base --is-ancestor), or, failing that,
// when another local branch (never a calmdev/* or escadrille/* one: a later session started from it) holds it through a merge
// commit, which a plain `git checkout -b` from the session's branch never makes. A branch without a commit of its own
// (its tip is still the commit it started from, `start`, else the oldest entry of its reflog) is never « merged »: a
// fresh branch is trivially inside its base.
import { execFile } from 'node:child_process';
import { isSessionBranch } from './names.mjs';

const run = (cwd, args) => new Promise((resolve) => execFile('git', args, { cwd, timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out))));
const BRANCH = /^[\w./-]+$/;
const okRef = (r) => typeof r === 'string' && BRANCH.test(r) && !r.startsWith('-') && !r.includes('..');

export const targetOf = (plan, sid, wt) => {
  const s = plan?.sessions?.find((x) => x.id === sid);
  return [s?.base, plan?.base, wt?.base].find((b) => typeof b === 'string' && b.trim()) || null;
};

const isAncestor = async (git, root, a, b) => (await git(root, ['merge-base', '--is-ancestor', a, b])) !== null;
// The merge commit that brought tip into ref: the first merge on the ancestry path whose first parent did not hold tip yet
const mergeCommitOf = async (git, root, tip, ref) => {
  const merges = String((await git(root, ['rev-list', '--ancestry-path', '--merges', '--reverse', `${tip}..${ref}`])) || '').split('\n').filter(Boolean);
  for (const m of merges) if (!(await isAncestor(git, root, tip, m + '^1'))) return m;
  return null;
};
const describe = async (git, root, into, commit, tip) => {
  if (!commit) {
    const at = String((await git(root, ['log', '-1', '--format=%cI', tip])) || '').trim() || null;
    return { into, commit: tip, by: null, at, base: null };
  }
  const [by, at] = String((await git(root, ['log', '-1', '--format=%an%x09%cI', commit])) || '').trim().split('\t');
  const base = String((await git(root, ['rev-parse', '--verify', '--quiet', commit + '^1'])) || '').trim() || null;
  return { into, commit, by: by || null, at: at || null, base };
};

// A row the server merged, then woken again (ARC, merged on 5 November, still waiting on its old stop on the 7th): over
// when it waits and its branch is still in the branch it was merged into (no new commit since). → bool
export const mergedWaitingOver = async ({ row, git = run }) => {
  const wt = row?.worktree; if (row?.status !== 'waiting' || !wt?.merged || wt.outside || !wt.root) return false;
  const into = wt.mergedInto || wt.base; if (!okRef(wt.branch) || !okRef(into)) return false;
  return isAncestor(git, wt.root, wt.branch, into);
};
// A merged session that is over carries no error (ARC, 7 November: « # fail 0 out of reach in the box », written on the 5th,
// still shown red after its merge and its close); the log keeps the history
export const HEALTH_CLEARED = Object.freeze({ health: 'ok', why: '' });
export const staleError = (row) => row?.status === 'done' && !!row.worktree?.merged && row.health === 'error';
export const mergedInto = async ({ root, branch, targets = [], start = null, git = run }) => {
  if (!root || !okRef(branch)) return null;
  const tip = String((await git(root, ['rev-parse', '--verify', '--quiet', branch + '^{commit}'])) || '').trim(); if (!tip) return null;
  // the commit it started from: given (wt.start, recorded at launch), else the oldest entry of the branch's reflog
  let from = start;
  if (!from) { const log = String((await git(root, ['reflog', 'show', '--format=%H', 'refs/heads/' + branch, '--'])) || '').trim().split('\n').filter(Boolean); from = log.at(-1) || null; }
  if (from && from === tip) return null;
  const seen = new Set();
  for (const t of targets) {
    if (!okRef(t) || seen.has(t) || t === branch) continue; seen.add(t);
    if (!String((await git(root, ['rev-parse', '--verify', '--quiet', t + '^{commit}'])) || '').trim()) continue;
    if (await isAncestor(git, root, tip, t)) return describe(git, root, t, await mergeCommitOf(git, root, tip, t), tip);
  }
  const holders = String((await git(root, ['for-each-ref', '--contains', tip, '--format=%(refname:short)', 'refs/heads/'])) || '').split('\n').map((x) => x.trim())
    .filter((b) => b && b !== branch && !isSessionBranch(b) && !seen.has(b));
  for (const b of holders) { const m = await mergeCommitOf(git, root, tip, b); if (m) return describe(git, root, b, m, tip); }
  return null;
};
