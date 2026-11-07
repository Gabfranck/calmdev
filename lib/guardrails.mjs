// The protected guardrails (docs/autonomy.md, « Garde-fous protégés »; phase 10, session E). When Escadrille develops
// itself, no session may weaken what holds it: the files below are written in code, never in a setting a session could
// reach, and the doc's list is checked against this one by test/guardrails.test.mjs.
//
//   PROTECTED                                 the repository paths of the guardrails
//   isEscadrille(root)                        is this checkout Escadrille itself? (the server's own repository, or a clone of it)
//   protectedTouched(files)                   the protected paths among files (case folded: macOS ignores it)
//   branchFiles(root, rev)                    the paths rev changed since its merge base with root's HEAD, renames split
//                                             into a deletion and an addition (--no-renames: a `git mv` names both sides)
//   sandboxGuard(settings, { root, worktree, base })   the session's settings, with the protected files of its worktree and
//                                             the refs of the base branch unwritable (sandbox and file tools)
//   guardKey / keyFromCookie / guardCookie    the key of the developer's browser: the only one that approves a touched guardrail
//
// A session can reach the server on 127.0.0.1 from its sandbox (verified on 2026-11-02 with curl), so « from the Mac » does
// not mean « a human clicked ». The approval of a touched guardrail asks for a cookie the browser got from a link written in
// ~/.config/escadrille/guard-link, a folder the sessions' sandbox cannot read (lib/planner.mjs, denyRead).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, chmodSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const PROTECTED = Object.freeze([
  'lib/guardrails.mjs', // this list, the detection and the sandbox's refusals
  'lib/policy.mjs', // the local permission rule: what is allowed or refused alone
  'lib/autonomy.mjs', // the modes, what waits for a human, the guarded paths
  'lib/worktree.mjs', // the worktree and the merge
  'lib/planner.mjs', // the sandbox settings, --max-budget-usd, the refusal of a session that cannot be sandboxed
  'lib/limits.mjs', // the soft and hard thresholds of the limits
  'lib/review.mjs', // the review level, mergeAllowed
  'server.mjs', // the caps, the merge gate, the routes that approve
  'docs/autonomy.md', // the written list of these files
  'test/guardrails.test.mjs', // the tests that try to get around them
  'CLAUDE.md', // the rules every session reads (no push, no production)
]);

const OWN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (cwd, args) => execFileSync('git', args, { cwd, timeout: 15000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const commonDir = (p) => { try { return realpathSync(git(p, ['rev-parse', '--path-format=absolute', '--git-common-dir'])); } catch { return null; } };

// Escadrille itself: the repository this server runs from (any of its worktrees), or a checkout that holds this file
// (a clone, a test repository). Read on the main checkout, never on a branch: a branch that drops the file touches it.
// The git answer is kept a minute per folder (GET /api/plan asks it for each session); the file test is never cached.
const known = new Map();
export const isEscadrille = (root, { own = OWN } = {}) => {
  if (!root || !existsSync(root)) return false;
  if (existsSync(path.join(root, 'lib', 'guardrails.mjs')) && existsSync(path.join(root, 'server.mjs'))) return true;
  const k = `${own}\n${root}`; const hit = known.get(k); if (hit && Date.now() - hit.at < 60000) return hit.yes;
  const mine = commonDir(own); const yes = !!mine && mine === commonDir(root);
  known.set(k, { yes, at: Date.now() }); return yes;
};

const norm = (f) => String(f || '').trim().replace(/^\.\//, '').replace(/\\/g, '/');
// The merge waits for the developer's key only for the files that define the guardrails (Dev, 2026-11-02 04:00: « les
// revues design uniquement »): the other protected files (server.mjs, lib/…) merge on green tests in the box and the
// pilot's review; the five below cannot even be written by a session (WRITE_DENIED), so a branch touching one is a red flag.
const KEY_GATED = ['lib/guardrails.mjs', 'lib/policy.mjs', 'docs/autonomy.md', 'test/guardrails.test.mjs', 'CLAUDE.md'];
const LOWER = new Set(KEY_GATED.map((p) => p.toLowerCase()));
export const protectedTouched = (files) => [...new Set((files || []).map(norm).filter((f) => LOWER.has(f.toLowerCase())))].sort();

export const branchFiles = (root, rev) => git(root, ['diff', '--name-only', '--no-renames', `HEAD...${rev}`]).split('\n').map(norm).filter(Boolean);

// The writes a session of Escadrille may not make: its worktree's protected files (and their lock or swap neighbours
// are not needed: an editor writes the file itself), and the refs that would move the base branch without the server
// (git update-ref, branch -f, push .): refs/heads/<base>, packed-refs and HEAD of the shared git folder, with their .lock.
// .git/hooks and .git/config are already refused by Claude Code's sandbox (verified on 2026-11-02).
// The files a session may not even write (decided by Dev, 2026-11-02 01:00): those that define the guardrails
// themselves. The other protected files (server.mjs, lib/worktree.mjs, lib/limits.mjs…) carry most of the product: a
// session may edit them, and their merge still waits for the developer's review (protectedTouched, the merge gate).
// Denying their writes stopped every feature that touches the server.
export const WRITE_DENIED = Object.freeze(['lib/guardrails.mjs', 'lib/policy.mjs', 'docs/autonomy.md', 'test/guardrails.test.mjs', 'CLAUDE.md']);
export const guardWrites = ({ root, worktree, base }) => {
  const files = worktree ? WRITE_DENIED.map((f) => path.join(worktree, f)) : [];
  const common = root ? commonDir(root) : null; const refs = [];
  if (common) {
    if (base && /^[\w./-]+$/.test(base) && !base.includes('..')) refs.push(path.join(common, 'refs', 'heads', base));
    refs.push(path.join(common, 'packed-refs'), path.join(common, 'HEAD'));
  }
  return { files, refs: refs.flatMap((r) => [r, r + '.lock']) };
};
export const sandboxGuard = (settings, where) => {
  const { files, refs } = guardWrites(where); const all = [...files, ...refs];
  const sb = settings.sandbox || {}; const fs = sb.filesystem || {}; const perms = settings.permissions || {};
  return {
    ...settings,
    sandbox: { ...sb, filesystem: { ...fs, denyWrite: [...new Set([...(fs.denyWrite || []), ...all])] } },
    // Edit rules hold every file tool (Edit, Write, NotebookEdit); '//' starts an absolute path
    permissions: { ...perms, deny: [...new Set([...(perms.deny || []), ...all.map((p) => `Edit(/${p})`)])] },
  };
};

// The line every session of Escadrille reads at the end of its prompt
export const instruction = () => `\n\nGarde-fous protégés (docs/autonomy.md) : ${PROTECTED.join(', ')}. Le bac à sable refuse de les écrire dans ton worktree, et une branche qui en touche un n'est fusionnée qu'après la revue de Dev. Si ta tâche demande d'en changer un, ne contourne pas (ni git, ni renommage, ni copie) : dis-le dans why avec health "error", et arrête-toi.`;

// The key: 32 random bytes in hex, in ~/.config/escadrille/guard-key (0600, folder 0700), ESCADRILLE_GUARD_DIR for the tests.
// guard-link next to it holds the link that hands it to the browser as a cookie.
export const COOKIE = 'escadrille_guard';
export const dirOf = (env = process.env) => env.ESCADRILLE_GUARD_DIR || path.join(homedir(), '.config', 'escadrille');
// A test server (NODE_TEST_CONTEXT without ESCADRILLE_GUARD_DIR) or a folder it cannot write (a sandbox) keeps a key in memory:
// never the developer's link overwritten by a spare port, never a server that fails to start.
export const guardKey = ({ env = process.env, port = null } = {}) => {
  if (env.NODE_TEST_CONTEXT && !env.ESCADRILLE_GUARD_DIR) return randomBytes(32).toString('hex');
  const dir = dirOf(env); const file = path.join(dir, 'guard-key');
  let key = null; try { key = readFileSync(file, 'utf8').trim(); } catch {}
  try {
    if (!/^[0-9a-f]{64}$/.test(key || '')) { mkdirSync(dir, { recursive: true, mode: 0o700 }); key = randomBytes(32).toString('hex'); writeFileSync(file, key + '\n', { mode: 0o600 }); }
    chmodSync(file, 0o600);
    if (port) writeFileSync(path.join(dir, 'guard-link'), `http://localhost:${port}/guard?k=${key}\n`, { mode: 0o600 });
  } catch (e) { console.error(`guard-key: ${e.message} (approving a touched guardrail works until the server stops)`); }
  return /^[0-9a-f]{64}$/.test(key || '') ? key : randomBytes(32).toString('hex');
};
const same = (a, b) => { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); };
export const keyMatches = (given, key) => same(given, key);
export const keyFromCookie = (header) => { for (const part of String(header || '').split(';')) { const [k, ...v] = part.trim().split('='); if (k === COOKIE) return v.join('='); } return null; };
export const guardCookie = (key) => `${COOKIE}=${key}; Path=/; HttpOnly; SameSite=Strict; Max-Age=315360000`;
