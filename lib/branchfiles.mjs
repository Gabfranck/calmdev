// The files a session's branch brings itself, read in its worktree: what its commits changed since the real merge base
// with its base branch (git diff base...HEAD, three dots, like a pull request), plus what is not committed yet. Used by
// the server to decide whether a branch touched a guarded path (checkGuarded) and to list a session's diff.
//
//   changedFiles({ cwd, base, git })  → sorted unique paths ('' base or an unknown base: only the loose files)
//
// A branch that merged its base on the way (it must, to stay current) inherits its base's commits: the three dots leave
// them out once the merge is committed. While that merge is still in progress (a conflict left for the next turn, a
// `git merge --no-commit`), the index holds every file the base brought, and `git status` lists them as if the session
// had written them; then a loose file counts only if it differs from both sides (HEAD and MERGE_HEAD): the session's own
// hand, not the base's (backlog, 2 November: Z marked « garde-fou touché » for main's own guardrail commits).
import { execFile } from 'node:child_process';

const run = (cwd, args) => new Promise((resolve) => execFile('git', args, { cwd, timeout: 15000, maxBuffer: 64 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out))));
const lines = (out) => String(out || '').split('\n').map((x) => x.trim()).filter(Boolean);

// --no-renames: a `git mv lib/policy.mjs x.mjs` names lib/policy.mjs too (the guardrails, docs/autonomy.md)
export const changedFiles = async ({ cwd, base, git = run }) => {
  const committed = base ? lines(await git(cwd, ['diff', '--name-only', '--no-renames', `${base}...HEAD`])) : [];
  let loose = lines(((await git(cwd, ['status', '--porcelain', '-uall', '--no-renames'])) || '').split('\n').map((l) => l.slice(3).replace(/^.* -> /, '')).join('\n'));
  const merging = (await git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD^{commit}']))?.trim();
  if (merging && loose.length) {
    const theirs = new Set(lines(await git(cwd, ['diff', '--name-only', '--no-renames', `HEAD...${merging}`])));
    const shared = loose.filter((f) => theirs.has(f));
    const fromTheirs = new Set(shared.length ? lines(await git(cwd, ['diff', '--name-only', '--no-renames', merging, '--', ...shared])) : []);
    // A file the base changed is the session's only if its working copy differs from the base's version too (conflict, own edit)
    loose = loose.filter((f) => !theirs.has(f) || fromTheirs.has(f));
  }
  return [...new Set([...committed, ...loose])].sort();
};
