// What runs on the Mac (docs/sessions.md, « La garde du Mac »): what this server started, and the other
// Claude Code processes it did not. Read only for the others: nothing here ever kills a process it did
// not start.
//
//   ours({ sessions, rows, devservers, devenvs }) → [{ kind: 'session' | 'devserver' | 'worktree' | 'devenv', plan, session, pid, cwd, url, since }]
//                                            sessions: the live claude processes [{ plan, session, pid, cwd, since }];
//                                            rows: the state rows of every plan ({ plan, id, worktree }), a worktree not merged
//                                            and still on disk counts; devservers: devServers() below; devenvs: devEnvs() below
//   markDevEnv({ project, plan, session, cwd, url }) / unmarkDevEnv(project) / devEnvs() / devEnvOf(project)
//                                            the dev environments `ENV: up` started (lib/devenv.mjs), until `ENV: down` or the
//                                            developer's « Arrêter »; in memory only: a server restarted lists them again at the next up
//   others({ exclude, parents, run })      → [{ pid, cwd, since, args }]: every claude process of the Mac (ps), minus the pids
//                                            in exclude and the children of the pids in parents; cwd read by lsof
//   parsePs(text), parseLsof(text), isClaude(args)   the parsers, exported for the tests
//
//   startDevServer({ plan, session, cwd, env, npm, timeoutMs, onChange, onLine })  → Promise<{ url }>: `npm run dev` in cwd,
//                                            the first http://localhost:<port> or http://127.0.0.1:<port> on its output within
//                                            timeoutMs (else url null); one per session; onChange on start, url and exit
//   stopDevServer(plan, session)           SIGTERM to its process group, SIGKILL after 3 s → Promise<boolean>
//   devServers()                           [{ plan, session, pid, cwd, url, since }]
//   stopAllDevServers()                    every one of them, for the shutdown
import { spawn, execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- what this server started
const bornOf = (p) => { try { const s = statSync(p); return (s.birthtimeMs ? s.birthtime : s.mtime).toISOString(); } catch { return null; } };
export const ours = ({ sessions = [], rows = [], devservers = [], devenvs = [], exists = existsSync, born = bornOf } = {}) => [
  ...sessions.map((s) => ({ kind: 'session', plan: s.plan, session: s.session, pid: s.pid ?? null, cwd: s.cwd ?? null, url: null, since: s.since ?? null })),
  ...devservers.map((d) => ({ kind: 'devserver', plan: d.plan, session: d.session, pid: d.pid ?? null, cwd: d.cwd ?? null, url: d.url ?? null, since: d.since ?? null })),
  ...devenvs.map((d) => ({ kind: 'devenv', plan: d.plan, session: d.session, pid: null, cwd: d.cwd ?? d.project ?? null, url: d.url ?? null, since: d.since ?? null })),
  ...rows.filter((r) => r.worktree && !r.worktree.merged && r.worktree.path && exists(r.worktree.path))
    .map((r) => ({ kind: 'worktree', plan: r.plan, session: r.id, pid: null, cwd: r.worktree.cwd || r.worktree.path, url: null, since: born(r.worktree.path) })),
];

// ---------------------------------------------------------------- a session said running with no process behind it
// After a restart, a 'running' row whose process is gone (no session_id to resume, a start that failed) stayed running
// for hours (PX, 2026-11-02, 04:52 to 06:55). rows: [{ plan, id, status, mode }]; alive(plan, id): a live process.
// Those returned go back to 'waiting' with a line for the pilot (never for the developer), and resume alone when they
// have a session_id (the server does both).
export const orphans = (rows = [], alive = () => false) => rows.filter((r) => r && r.status === 'running' && r.mode !== 'terminal' && !alive(r.plan, r.id));
// ---------------------------------------------------------------- the dev environments ENV: up started (docs/devenv.md)
// One per project (the environment is the project's, whichever session asked for it); the plan and session kept are
// the ones of the last `up`. Docker (or whatever the declared command runs) is not a child of this server: nothing here
// is killed, the declared `down` command is what stops it (the server runs it on « Arrêter »).
const ENVS = new Map(); // project -> { project, plan, session, cwd, url, since }
export const markDevEnv = ({ project, plan = null, session = null, cwd = null, url = null, since = new Date().toISOString() }) => { const d = { project, plan, session, cwd: cwd || project, url, since }; ENVS.set(project, d); return d; };
export const unmarkDevEnv = (project) => ENVS.delete(project);
export const devEnvs = () => [...ENVS.values()];
export const devEnvOf = (project) => ENVS.get(project) || null;

// ---------------------------------------------------------------- the other claude processes of the Mac
// `ps -axo pid=,ppid=,lstart=,command=`: "  812     1 Sun Nov  1 04:15:23 2026     claude -p …"
// others() runs ps with LC_ALL=C ("Sun Nov  1 04:15:23 2026"); a French ps ("dim.  1 nov. 04:15:23 2026") is read too
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  janv: 0, 'févr': 1, fevr: 1, mars: 2, avr: 3, mai: 4, juin: 5, juil: 6, 'août': 7, aout: 7, sept: 8, 'déc': 11 };
const W = '[^\\s\\d]+\\.?'; // a weekday or a month, with or without its dot
const PS_LINE = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+${W}\\s+(?:(${W})\\s+(\\d{1,2})|(\\d{1,2})\\s+(${W}))\\s+(\\d{2}):(\\d{2}):(\\d{2})\\s+(\\d{4})\\s+(.+)$`, 'u');
export const parsePs = (text) => String(text || '').split('\n').map((line) => {
  const m = PS_LINE.exec(line); if (!m) return null;
  const mon = MONTHS[(m[3] || m[6]).replace(/\.$/, '').toLowerCase()]; const day = Number(m[4] || m[5]);
  if (mon === undefined) return null;
  const since = new Date(Number(m[10]), mon, day, Number(m[7]), Number(m[8]), Number(m[9])); // local time, as ps prints it
  return { pid: Number(m[1]), ppid: Number(m[2]), since: since.toISOString(), args: m[11].trim() };
}).filter(Boolean);
// `lsof -a -p <pid,pid…> -d cwd -Fn`: "p812\nfcwd\nn~/Dev/x\n…" → Map pid → cwd
export const parseLsof = (text) => {
  const out = new Map(); let pid = null;
  for (const line of String(text || '').split('\n')) { if (line[0] === 'p') pid = Number(line.slice(1)); else if (line[0] === 'n' && pid !== null && !out.has(pid)) out.set(pid, line.slice(1)); }
  return out;
};
// A Claude Code process: `claude …` (the native install) or `node …/claude …` (npm); not the desktop app (Claude.app, capital C)
const CLAUDE_BIN = (t) => path.basename(t || '') === 'claude' || /@anthropic-ai\/claude-code\/cli\.m?js$/.test(t || '');
// (`claude --chrome-native-host` is the bridge of the Chrome extension, not a session: left out)
// A test's stand-in (test/fake-claude.mjs writes <tmpdir>/escadrille-<random>/claude; fixtures live in test/fixtures/) is not a
// Claude Code process: never counted.
const FAKE_DIR = /\/escadrille-[^/\s]*\/|\/test\/fixtures\//;
export const isFakeClaude = (args) => { const [a0, a1] = String(args || '').trim().split(/\s+/); const bin = path.basename(a0 || '') === 'claude' ? a0 : a1; return FAKE_DIR.test(bin || ''); };
export const isClaude = (args) => { const [a0, a1] = String(args || '').trim().split(/\s+/); return !/\s--chrome-native-host\b/.test(args) && (CLAUDE_BIN(a0) || (/^(node|bun)$/.test(path.basename(a0 || '')) && CLAUDE_BIN(a1))) && !isFakeClaude(args); };
const execOut = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 5000, maxBuffer: 8e6, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }, (err, out) => (err && !String(out || '').trim() ? reject(err) : resolve(String(out || '')))));
const clip = (s, n = 300) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export const others = async ({ exclude = new Set(), parents = new Set(), run = execOut } = {}) => {
  const procs = parsePs(await run('ps', ['-axo', 'pid=,ppid=,lstart=,command='])).filter((p) => isClaude(p.args) && !exclude.has(p.pid) && !parents.has(p.ppid));
  if (!procs.length) return [];
  let cwds = new Map();
  try { cwds = parseLsof(await run('lsof', ['-a', '-p', procs.map((p) => p.pid).join(','), '-d', 'cwd', '-Fn'])); } catch {} // lsof missing or refused: the cwd stays null
  return procs.map((p) => ({ pid: p.pid, cwd: cwds.get(p.pid) ?? null, since: p.since, args: clip(p.args) }));
};

// ---------------------------------------------------------------- the dev servers this server started
// `npm run dev` runs in its own process group (detached): a stop reaches npm, its shell and the server it runs.
// It is not Claude Code's sandbox: its env is safeEnv (no secrets), but nothing keeps it off the network.
const DEV = new Map(); // "plan/session" -> { plan, session, pid, cwd, url, since, child, exited }
const dkey = (plan, session) => `${plan}/${session}`;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?/;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const pub = ({ plan, session, pid, cwd, url, since }) => ({ plan, session, pid, cwd, url, since });
export const devServers = () => [...DEV.values()].filter((d) => !d.exited).map(pub);
export const devServerOf = (plan, session) => { const d = DEV.get(dkey(plan, session)); return d && !d.exited ? pub(d) : null; };

export const startDevServer = ({ plan, session, cwd, env = process.env, npm = 'npm', timeoutMs = 20000, onChange = () => {}, onLine = () => {} }) => {
  const cur = DEV.get(dkey(plan, session));
  if (cur && !cur.exited) return cur.ready;
  if (!cwd || !existsSync(path.join(cwd, 'package.json'))) return Promise.reject(new Error('pas de package.json dans ' + cwd));
  const child = spawn(npm, ['run', 'dev'], { cwd, env: { ...env, NO_COLOR: '1', FORCE_COLOR: '0', BROWSER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const d = { plan, session, pid: child.pid, cwd, url: null, since: new Date().toISOString(), child, exited: false };
  DEV.set(dkey(plan, session), d);
  d.ready = new Promise((resolve, reject) => {
    let settled = false; let buf = '';
    const settle = (v, err) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(v); };
    const timer = setTimeout(() => settle({ url: null }), timeoutMs);
    const read = (chunk) => {
      if (d.url) return; buf = (buf + chunk).replace(ANSI, '').slice(-8000);
      for (const line of String(chunk).replace(ANSI, '').split('\n')) if (line.trim()) onLine(line);
      const m = URL_RE.exec(buf); if (m) { d.url = m[0].replace(/\/$/, ''); onChange(); settle({ url: d.url }); }
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.on('error', (e) => { d.exited = true; onChange(); settle(null, new Error('npm run dev : ' + e.message)); });
    child.on('exit', (code) => { d.exited = true; onChange(code); settle({ url: null, exited: code }); });
  });
  onChange();
  return d.ready;
};
const killGroup = (pid, sig) => { try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} } };
export const stopDevServer = (plan, session) => {
  const d = DEV.get(dkey(plan, session)); if (!d || d.exited) return Promise.resolve(false);
  return new Promise((resolve) => {
    const t = setTimeout(() => { killGroup(d.pid, 'SIGKILL'); }, 3000); t.unref();
    d.child.once('exit', () => { clearTimeout(t); killGroup(d.pid, 'SIGKILL'); resolve(true); }); // the group's last members, if npm went first
    killGroup(d.pid, 'SIGTERM');
  });
};
export const stopAllDevServers = () => Promise.all([...DEV.values()].filter((d) => !d.exited).map((d) => stopDevServer(d.plan, d.session)));
