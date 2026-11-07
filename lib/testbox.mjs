// The tests of a finished session, run by the server before an automatic merge (phase 10, session A; docs/autonomy.md).
// The branch is merged dry into a throwaway verification worktree made from the project's current head; the
// project's testCommand runs there inside a sandbox with the restrictions of a session: no network but localhost,
// writes held to that worktree, the repository's git folder and a private temp folder, the developer's keys
// unreadable, a short PATH (git refuses the long one under the sandbox), the secrets out of the environment. Code a
// session wrote never runs outside a sandbox: when no sandbox can be applied, the caller falls back to the click.
// A test file that fails is run again alone, once, before the red is believed (the suite under load, docs/terrain.md).
// One verification at a time on the whole Mac (phase 12, TB): the calls of one process queue on a promise chain, and
// the servers of one machine (the developer's on 3078, the test servers) share a lock file in os.tmpdir() holding the
// owner's pid; a lock whose pid is dead is taken over at once, one held longer than VERIFY_LOCK_MAX_WAIT_MS is judged
// stale and taken over, and the output says so. A node --test command gets --test-concurrency=TEST_CONCURRENCY
// unless it says its own; any other command is run as written.
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, existsSync, statSync, symlinkSync, openSync, writeSync, closeSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { SANDBOX_SETTINGS, safeEnv } from './planner.mjs';
import { vars, isOurVar } from './names.mjs';

export const DEFAULT_SELF_TEST = 'node --test test/*.test.mjs';
const home = os.homedir();
const expand = (p) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const sbStr = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const DENY_READ = () => SANDBOX_SETTINGS.sandbox.filesystem.denyRead.map(expand);

// The Seatbelt profile (macOS): everything a session may do, nothing more on the network or the disk
// readOnly: inside a writable folder, what the tests must not change (the shared git folder's hooks, config and refs:
// a hook written there would run later outside any box, at the next git command of the server or the developer)
export const seatbeltProfile = ({ writable, readOnly = [], denyRead = DENY_READ() }) => [
  '(version 1)',
  '(allow default)',
  '(deny network*)',
  '(allow network-bind (local ip "localhost:*"))',
  '(allow network-inbound (local ip "localhost:*"))',
  '(allow network-outbound (remote ip "localhost:*"))',
  `(allow network-outbound (remote unix-socket ${writable.map((w) => `(subpath ${sbStr(w)})`).join(' ')}))`,
  '(deny file-write*)',
  `(allow file-write* ${writable.map((w) => `(subpath ${sbStr(w)})`).join(' ')} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
  ...(readOnly.length ? [`(deny file-write* ${readOnly.map((w) => `(subpath ${sbStr(w)})`).join(' ')})`] : []),
  `(deny file-read* ${denyRead.map((d) => `(subpath ${sbStr(d)})`).join(' ')} (regex #"/\\.env(\\.[^/]*)?$"))`,
].join('\n');

// The command line that runs `sh -c cmd` boxed: sandbox-exec on macOS, bubblewrap on Linux (unverified on a real
// Linux), else null. ESCADRILLE_TESTBOX replaces it: 'none' says no box (the click stays), a path is a wrapper run as
// `<path> sh -c cmd` (the tests of the server, themselves inside a session's sandbox, where Seatbelt cannot nest)
export const boxCommand = ({ cmd, writable, readOnly = [], platform = process.platform, box = vars.TESTBOX }) => {
  if (box === 'none') return null;
  if (box) return { file: box, args: ['sh', '-c', cmd] };
  if (platform === 'darwin') return { file: '/usr/bin/sandbox-exec', args: ['-p', seatbeltProfile({ writable, readOnly }), '/bin/sh', '-c', cmd] };
  if (platform === 'linux') {
    const isDir = (d) => { try { return statSync(d).isDirectory(); } catch { return false; } };
    const hide = DENY_READ().filter((d) => existsSync(d)).flatMap((d) => (isDir(d) ? ['--tmpfs', d] : ['--ro-bind', '/dev/null', d]));
    return { file: 'bwrap', args: ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', ...writable.flatMap((w) => ['--bind', w, w]), ...readOnly.filter((r) => existsSync(r)).flatMap((r) => ['--ro-bind', r, r]), ...hide, '--unshare-net', '--die-with-parent', '/bin/sh', '-c', cmd] };
  }
  return null;
};

// The short PATH: the server's own Node first, then the system's
export const shortPath = () => [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
const BOX_FAILED = /^(sandbox-exec|bwrap): /m;

// → { code, out, killed, boxError }: boxError when the sandbox itself refused to start (never a red)
export const runBoxed = ({ cmd, cwd, writable, readOnly = [], tmp, timeoutMs = 600000, box }) => new Promise((resolve) => {
  const c = boxCommand({ cmd, writable, readOnly, box });
  if (!c) { resolve({ code: null, out: '', boxError: 'pas de bac à sable pour les tests sur ' + process.platform }); return; }
  // The server's own settings (its port, base, the box) never reach the tests
  const env = { ...safeEnv(process.env), PATH: shortPath(), TMPDIR: tmp };
  for (const k of Object.keys(env)) if (isOurVar(k) || k === 'PORT' || k === 'NODE_TEST_CONTEXT') delete env[k]; // NODE_TEST_CONTEXT: a server under node --test would turn the suite's TAP into its own protocol
  execFile(c.file, c.args, { cwd, env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, out, errOut) => {
    const all = `${out || ''}${errOut || ''}`; const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
    const boxError = err && (err.code === 'ENOENT' || err.code === 'EACCES' || (BOX_FAILED.test(errOut || '') && !out)) ? (all.trim().split('\n')[0] || String(err.message)) : null;
    resolve({ code, out: all, killed: !!err?.killed, boxError });
  });
});

// The ceiling on the test files node --test runs at once during a verification. Half the cores: the other half stays
// with the sessions still working and the developer's server. At least 2, so the files that mostly wait on a server
// still overlap. At most 4: each file of this suite starts a server, a fake claude and git, and the reds of 2 November
// came from a dozen of those at once. ESCADRILLE_TEST_CONCURRENCY (a whole number ≥ 1), read when the server starts,
// replaces it.
const envConcurrency = Number(vars.TEST_CONCURRENCY);
export const TEST_CONCURRENCY = Number.isInteger(envConcurrency) && envConcurrency >= 1 ? envConcurrency : Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2)));
// node --test (node by name or by path, quoted or not, other flags before --test allowed) gets the ceiling; a command
// that already says --test-concurrency, or that runs no node --test, is returned as written
const NODE_TEST = /(^|[\s;&|(])((?:"[^"]*\/node"|'[^']*\/node'|(?:\S*\/)?node)(?:\s+--?[\w-]+(?:=\S+)?)*?\s+--test)(?=\s|$)/g;
export const capConcurrency = (cmd, n = TEST_CONCURRENCY) => (/--test-concurrency\b/.test(cmd) ? cmd : String(cmd).replace(NODE_TEST, `$1$2 --test-concurrency=${n}`));

// The machine-wide lock of the verifications: a file created exclusively, « pid token » inside
export const VERIFY_LOCK_MAX_WAIT_MS = 10 * 60 * 1000;
export const verifyLockPath = () => path.join(os.tmpdir(), 'escadrille-verify.lock');
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readLock = (file) => { try { const [pid, token] = readFileSync(file, 'utf8').trim().split(/\s+/); return { pid: Number(pid) || 0, token: token || '' }; } catch { return null; } };
const createLock = (file, token) => { let fd; try { fd = openSync(file, 'wx'); } catch (e) { if (e.code === 'EEXIST') return false; throw e; } try { writeSync(fd, `${process.pid} ${token}\n`); } finally { closeSync(fd); } return true; };
// → { note }: the lock taken; note says when a stale lock was taken over (a dead pid, or the wait cap reached)
export const acquireVerifyLock = async ({ file = verifyLockPath(), token, maxWaitMs = VERIFY_LOCK_MAX_WAIT_MS, pollMs = 500 } = {}) => {
  const t0 = Date.now();
  for (;;) {
    if (createLock(file, token)) return { note: '' };
    const cur = readLock(file);
    if (!cur) continue; // released between the two calls (or still being written: the next turn reads it)
    if (cur.pid && !pidAlive(cur.pid)) { rmSync(file, { force: true }); if (createLock(file, token)) return { note: `# verrou de vérification repris : son processus ${cur.pid} est mort\n` }; continue; }
    if (Date.now() - t0 >= maxWaitMs) { rmSync(file, { force: true }); if (createLock(file, token)) return { note: `# verrou de vérification jugé périmé après ${Math.round(maxWaitMs / 1000)} s d'attente (processus ${cur.pid || '?'}) : repris\n` }; continue; }
    await new Promise((r) => setTimeout(r, pollMs));
  }
};
// Released only by its owner: a lock taken over meanwhile belongs to another
export const releaseVerifyLock = ({ file = verifyLockPath(), token }) => { const cur = readLock(file); if (cur && cur.pid === process.pid && cur.token === token) rmSync(file, { force: true }); };
// The queue of this process, then the lock of the machine; the note goes at the head of the result's output
let verifyQueue = Promise.resolve();
export const withVerifyLock = (fn, { file, maxWaitMs, pollMs } = {}) => {
  const run = verifyQueue.then(async () => {
    const token = randomBytes(8).toString('hex');
    const { note } = await acquireVerifyLock({ file, token, maxWaitMs, pollMs });
    try { const r = await fn(); if (note && r && typeof r === 'object') r.out = note + (r.out || ''); return r; } finally { releaseVerifyLock({ file, token }); }
  });
  verifyQueue = run.catch(() => {});
  return run;
};

// The test files that failed, read from node --test (TAP: the location under « not ok »; spec: « test at »), relative to cwd
export const failingFiles = (out, cwd = '') => {
  const files = []; let inFail = false;
  const add = (p) => { let f = p.replace(/^file:\/\//, ''); if (cwd && path.isAbsolute(f)) { const r = path.relative(cwd, f); const r2 = path.relative(real(cwd), f); f = !r.startsWith('..') ? r : !r2.startsWith('..') ? r2 : f; } if (!files.includes(f)) files.push(f); };
  for (const line of String(out).split('\n')) {
    if (/^\s*not ok \d+ /.test(line)) { inFail = true; continue; }
    if (/^\s*ok \d+ /.test(line)) { inFail = false; continue; }
    const loc = inFail && /^\s*location: '(.+?):\d+:\d+'/.exec(line); if (loc) { add(loc[1]); inFail = false; continue; }
    const spec = /test at (\S+?):\d+:\d+/.exec(line); if (spec) add(spec[1]);
  }
  return files;
};
// The command that runs one file alone: the glob of the command (test/*.test.mjs) replaced by that file, else null
const quote = (s) => (/^[\w./@+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
export const rerunCommand = (cmd, file) => { const m = /(^|\s)(\S*\*\S*)(?=\s|$)/.exec(cmd); return m ? cmd.slice(0, m.index + m[1].length) + quote(file) + cmd.slice(m.index + m[0].length) : null; };

// The failures, short enough to be sent to the session: the failing tests and the end of the output
export const failureSummary = (out, max = 3000) => {
  const lines = String(out).split('\n');
  const names = lines.filter((l) => /^\s*not ok \d+ - /.test(l) || /^\s*✖ /.test(l)).map((l) => l.trim()).filter((l, i, a) => a.indexOf(l) === i).slice(0, 30);
  const errors = lines.filter((l) => /^\s*(error|expected|actual): /.test(l)).map((l) => l.trim()).slice(0, 20);
  const end = lines.filter((l) => l.trim()).slice(-15).join('\n');
  const text = [names.length ? names.join('\n') : '', errors.length ? errors.join('\n') : '', end].filter(Boolean).join('\n…\n');
  return text.length > max ? '…' + text.slice(-max) : text;
};

// The dry merge and its tests: → { code, out, flaky: [files green alone], failed: [files], conflict?, files?, boxError? }
// git runs here, in the server, on the repository (never the session's code: hooks off); the tests run boxed.
// links: [{ at, to }] folders of the repository's checkout the fresh worktree lacks (node_modules), linked into it at `at`
// and writable (a cache); siblings: [{ rel, to }] folders beside the repository (a `file:../x` dependency), linked under the
// same relative path beside the worktree, readable only (docs/devenv.md, « Les tests d'un dépôt »)
const gitRun = (cwd, args) => new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(out).trim()))));
// lockFile, lockMaxWaitMs: the machine-wide lock (verifyLockPath(), VERIFY_LOCK_MAX_WAIT_MS), moved by the tests
export const verifyMerge = (o) => {
  // No box here: nothing is done, the click of « À faire » stays (the dry merge is not even tried, nor queued)
  if (!boxCommand({ cmd: o.cmd, writable: [], box: o.box })) return Promise.resolve({ boxError: 'pas de bac à sable pour les tests sur ' + process.platform, code: null, out: '' });
  return withVerifyLock(() => verifyMergeNow({ ...o, cmd: capConcurrency(o.cmd) }), { file: o.lockFile, maxWaitMs: o.lockMaxWaitMs });
};
const verifyMergeNow = async ({ root, branch, cmd, git = gitRun, timeoutMs, box, links = [], siblings = [] }) => {
  const base = real(os.tmpdir());
  const top = real(mkdtempSync(path.join(base, 'escadrille-verify-')));
  // two levels down, so that a sibling's path (../x, ../../x) stays inside the throwaway folder
  const dir = path.join(top, 'a', 'b', path.basename(real(root)) || 'wt');
  mkdirSync(path.dirname(dir), { recursive: true });
  const tmp = real(mkdtempSync(path.join(base, 'escadrille-verify-tmp-')));
  const G = (cwd, args) => git(cwd, ['-c', 'core.hooksPath=/dev/null', ...args]);
  await G(root, ['worktree', 'add', '--detach', dir, 'HEAD']);
  try {
    try { await G(dir, ['-c', 'user.name=Escadrille', '-c', 'user.email=escadrille@localhost', 'merge', '--no-ff', '--no-edit', branch]); } catch (e) {
      let files = []; try { files = (await G(dir, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean); } catch {}
      if (files.length) return { conflict: true, files };
      throw e;
    }
    const linked = [];
    for (const l of links) { const at = path.resolve(dir, l.at); if (!at.startsWith(dir + path.sep) || existsSync(at)) continue; mkdirSync(path.dirname(at), { recursive: true }); symlinkSync(l.to, at); linked.push(real(l.to)); }
    for (const s of siblings) { const at = path.resolve(dir, s.rel); if (!at.startsWith(top + path.sep) || at.startsWith(dir + path.sep) || existsSync(at)) continue; mkdirSync(path.dirname(at), { recursive: true }); symlinkSync(s.to, at); }
    const common = real(await G(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const writable = [dir, tmp, common, ...linked];
    const readOnly = ['hooks', 'config', 'refs', 'packed-refs', 'HEAD', 'info'].map((p) => path.join(common, p));
    const run = (c) => runBoxed({ cmd: c, cwd: dir, writable, readOnly, tmp, timeoutMs, box });
    const first = await run(cmd);
    if (first.boxError) return { boxError: first.boxError, code: null, out: first.out };
    if (first.code === 0) return { code: 0, out: first.out, flaky: [], failed: [] };
    // Believed only after a second look: each failing file alone, or the whole command again when no file is named
    const files = failingFiles(first.out, dir); const reruns = files.map((f) => [f, rerunCommand(cmd, f)]);
    if (!first.killed && files.length && reruns.every(([, c]) => c)) {
      const failed = []; let out = first.out;
      for (const [f, c] of reruns) { const r = await run(c); out += `\n# ${c} → ${r.code}\n` + r.out; if (r.code !== 0) failed.push(f); }
      return failed.length ? { code: first.code, out, flaky: [], failed, firstOut: first.out } : { code: 0, out, flaky: files, failed: [] };
    }
    if (!first.killed) { const again = await run(cmd); if (again.code === 0) return { code: 0, out: again.out, flaky: ['*'], failed: [] }; return { code: again.code, out: again.out, flaky: [], failed: failingFiles(again.out, dir), killed: again.killed }; }
    return { code: first.code, out: first.out, flaky: [], failed: files, killed: true };
  } finally {
    try { await G(root, ['worktree', 'remove', '--force', dir]); } catch {}
    rmSync(top, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }); // rmSync removes the links, never what they point to
  }
};
