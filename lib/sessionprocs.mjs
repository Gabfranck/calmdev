// The servers of a session die with it (docs/sessions.md, « Les serveurs des sessions meurent avec elles », 2026-11-07).
// Nothing runs without a master, and nothing the developer started himself dies without his click.
//
//   ensure(db)                               creates the table session_procs (plan, session, pid, started, port, command, cwd)
//   snapshot({ run })                        → { ps: [{ pid, ppid, since, args }], listeners: [{ pid, port, command, args, cwd, since }] }
//                                              one ps, one lsof for the listening TCP servers, one lsof for their cwd
//   claim({ snap, sessions })                → the rows to record: a listener descending from the session's claude process, or
//                                              whose cwd is inside the session's worktree (never the project root alone)
//   record(db, rows), rowsOf(db, plan, session), forget(db, plan, session)
//   alive(row, ps)                           same pid and same start time: a reused pid belongs to nobody
//   closeTargets({ db, plan, session, snap, worktree, self, selfPort }) → what to stop at the closure
//   stop(targets, { kill, waitMs, sleep })   SIGTERM, SIGKILL after 3 s to those still there; → the targets signalled
//   listLine(stopped)                        ":3190 (node demo.mjs), :8082 (expo start)"
//   classify({ listeners, rows, sessions, envs, roots, self, selfPort }) → each listener with { orphan, reason, plan?, session? }
// ps and lsof are injected (`run`) as in lib/running.mjs, so the tests never read the Mac.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { parsePs, parseLsof } from './running.mjs';
import { parseListen } from './vitals.mjs';
import * as testapps from './testapps.mjs';

export const KILL_AFTER_MS = 3000;
export const LIVE = new Set(['running', 'waiting', 'paused']);
const CMD_MAX = 300;

const execOut = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 5000, maxBuffer: 8e6, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }, (err, out) => (err && !String(out || '').trim() ? reject(err) : resolve(String(out || '')))));
const clean = (p) => String(p || '').replace(/\/+$/, '');
export const inside = (cwd, dir) => { const c = clean(cwd); const d = clean(dir); return !!c && !!d && (c === d || c.startsWith(d + '/')); };
const key = (pid, since) => `${pid}@${since}`;

export const ensure = (db) => db.exec('create table if not exists session_procs (plan text, session text, pid integer, started text, port integer, command text, cwd text, primary key (pid, started))');

export const psList = async ({ run = execOut } = {}) => parsePs(await run('ps', ['-axo', 'pid=,ppid=,lstart=,command=']));
// The page's servers (lib/vitals.mjs listeners) with their start time and full command from ps
export const withPs = (listeners = [], ps = []) => { const byPid = new Map(ps.map((p) => [p.pid, p])); return listeners.map((l) => ({ ...l, command: (byPid.get(l.pid)?.args || l.command || '').slice(0, CMD_MAX), since: byPid.get(l.pid)?.since ?? null, parentDead: parentDead(byPid.get(l.pid), byPid) })); };
// The parent is gone: ppid 1 (launchd took it over) or a pid ps no longer lists. Unknown process: false (never guess a death)
export const parentDead = (p, byPid) => !!p && (p.ppid <= 1 || !byPid.has(p.ppid));

export const snapshot = async ({ run = execOut } = {}) => {
  const ps = await psList({ run });
  const byPid = new Map(ps.map((p) => [p.pid, p]));
  let listen = [];
  try { listen = parseListen(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'])); } catch { listen = []; }
  let cwds = new Map();
  if (listen.length) { try { cwds = parseLsof(await run('lsof', ['-a', '-p', [...new Set(listen.map((l) => l.pid))].join(','), '-d', 'cwd', '-Fn'])); } catch {} }
  const listeners = listen.map((l) => ({ pid: l.pid, port: l.port, command: (byPid.get(l.pid)?.args || l.command || '').slice(0, CMD_MAX), cwd: cwds.get(l.pid) ?? null, since: byPid.get(l.pid)?.since ?? null, parentDead: parentDead(byPid.get(l.pid), byPid) }));
  return { ps, listeners };
};

export const ancestors = (pid, ps = []) => {
  const parent = new Map(ps.map((p) => [p.pid, p.ppid])); const out = []; let cur = parent.get(pid);
  for (let i = 0; cur && cur > 1 && i < 64; i++) { out.push(cur); cur = parent.get(cur); }
  return out;
};

// sessions: [{ plan, session, pid /* its claude process, or null */, worktree /* path, or null */ }]
export const claim = ({ snap, sessions = [] }) => {
  const out = [];
  for (const l of snap?.listeners || []) {
    if (!l.since) continue; // no start time read: nothing to tell a reused pid from
    const up = ancestors(l.pid, snap.ps);
    const s = sessions.find((x) => (x.pid && up.includes(x.pid)) || (x.worktree && inside(l.cwd, x.worktree)));
    if (s) out.push({ plan: s.plan, session: s.session, pid: l.pid, started: l.since, port: l.port ?? null, command: l.command || '', cwd: l.cwd ?? null });
  }
  return out;
};

// The first owner keeps it: a pid and its start time belong to one session
export const record = (db, rows = []) => {
  const st = db.prepare('insert or ignore into session_procs (plan, session, pid, started, port, command, cwd) values (?, ?, ?, ?, ?, ?, ?)');
  for (const r of rows) st.run(r.plan, r.session, r.pid, r.started, r.port ?? null, r.command ?? '', r.cwd ?? null);
  return rows.length;
};
export const rowsOf = (db, plan, session) => db.prepare('select * from session_procs where plan = ? and session = ?').all(plan, session);
export const allRows = (db) => db.prepare('select * from session_procs').all();
export const forget = (db, plan, session) => db.prepare('delete from session_procs where plan = ? and session = ?').run(plan, session);

export const alive = (row, ps = []) => !!row && ps.some((p) => p.pid === Number(row.pid) && p.since === row.started);

// What dies at the closure: the session's recorded rows still alive (same pid and same start), and, unless `worktree` is null
// (a test server kills only what it recorded), every listener whose cwd is in the session's worktree. Never this server.
export const closeTargets = ({ db, plan, session, snap, worktree = null, self = process.pid, selfPort = null }) => {
  const out = new Map(); const ps = snap?.ps || [];
  const listening = new Map((snap?.listeners || []).map((l) => [l.pid, l]));
  for (const r of rowsOf(db, plan, session)) {
    if (!alive(r, ps)) continue;
    const l = listening.get(Number(r.pid));
    out.set(Number(r.pid), { pid: Number(r.pid), port: l?.port ?? r.port ?? null, command: r.command || l?.command || '', cwd: r.cwd ?? l?.cwd ?? null });
  }
  if (worktree) { // the test apps' own rule (lib/testapps.mjs ownerOf), called, not copied
    const mine = [{ plan, id: session, worktree: { path: worktree } }];
    for (const l of snap?.listeners || []) if (testapps.ownerOf(l.cwd, mine) && !out.has(l.pid)) out.set(l.pid, { pid: l.pid, port: l.port ?? null, command: l.command || '', cwd: l.cwd });
  }
  return [...out.values()].filter((t) => t.pid !== self && t.pid > 1 && !(selfPort && Number(t.port) === Number(selfPort)));
};

// The processes of a dead verification suite (<tmpdir>/escadrille-verify-*): their command names that folder and their parent is
// gone. A suite still running keeps its processes (its parent lives). Never this server, never pid 1.
export const verifyOrphans = ({ ps = [], self = process.pid } = {}) => {
  const byPid = new Map(ps.map((p) => [p.pid, p]));
  return ps.filter((p) => p.pid !== self && p.pid > 1 && testapps.isVerify({ command: p.args }) && parentDead(p, byPid))
    .map((p) => ({ pid: p.pid, port: null, command: String(p.args).slice(0, CMD_MAX), cwd: null }));
};

const isUp = (kill) => (pid) => { try { kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export const stop = async (targets = [], { kill = process.kill.bind(process), waitMs = KILL_AFTER_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) => {
  const sent = [];
  for (const t of targets) { try { kill(t.pid, 'SIGTERM'); sent.push(t); } catch {} }
  if (!sent.length) return sent;
  await sleep(waitMs);
  const up = isUp(kill);
  for (const t of sent) if (up(t.pid)) { try { kill(t.pid, 'SIGKILL'); } catch {} }
  return sent;
};

const short = (command) => {
  const parts = String(command || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const name = (p) => (p.includes('/') ? path.basename(p) : p);
  const [bin, ...rest] = parts; const b = name(bin);
  // `node …/node_modules/.bin/expo start` reads « expo start »
  const args = /^(node|bun|deno)$/.test(b) && rest[0] && /node_modules\/\.bin\//.test(rest[0]) ? rest.map(name) : [b, ...rest.map(name)];
  return args.slice(0, 3).join(' ').slice(0, 60);
};
export const listLine = (stopped = []) => stopped.map((t) => `${t.port ? ':' + t.port : 'pid ' + t.pid} (${short(t.command)})`).join(', ');

// An orphan: a listener whose cwd is in a registered project root, owned neither by a live session (running, waiting, paused)
// nor by an environment `ENV: up` marked, and that is not calmdev. Outside every root: neither orphan nor touched, ever.
//   rows: session_procs; sessions: [{ plan, id, status, worktree: { path } }]; envs: [{ project }]; roots: [path]
export const classify = ({ listeners = [], rows = [], sessions = [], envs = [], roots = [], self = process.pid, selfPort = null }) => {
  const owned = new Map(rows.map((r) => [key(Number(r.pid), r.started), r]));
  const sessionOf = (plan, id) => sessions.find((s) => s.plan === plan && s.id === id) || null;
  return listeners.map((l) => {
    const base = { ...l, command: String(l.command || '').slice(0, CMD_MAX) };
    if (l.pid === self || (selfPort && Number(l.port) === Number(selfPort))) return { ...base, orphan: false, reason: 'calmdev itself' };
    // a verification suite's server (<tmpdir>/escadrille-verify-*) is calmdev's: an orphan once its parent is dead, else its suite's
    if (testapps.isVerify(l)) return l.parentDead ? { ...base, orphan: true, reason: 'orphan' } : { ...base, orphan: false, reason: 'owned by a running suite' };
    const r = l.since ? owned.get(key(l.pid, l.since)) : null;    const byCwd = r ? null : sessions.find((s) => s.worktree?.path && !s.worktree.merged && inside(l.cwd, s.worktree.path));
    const owner = r ? { plan: r.plan, session: r.session, row: sessionOf(r.plan, r.session) } : byCwd ? { plan: byCwd.plan, session: byCwd.id, row: byCwd } : null;
    const tag = owner ? { plan: owner.plan, session: owner.session } : {};
    if (owner && owner.row && LIVE.has(owner.row.status)) return { ...base, ...tag, orphan: false, reason: `owned by ${owner.plan}/${owner.session}` };
    if (r && l.parentDead) return { ...base, ...tag, orphan: true, reason: 'orphan' }; // recorded as a session's, its session over and its parent dead: calmdev's, outside the roots too
    if (!roots.some((root) => inside(l.cwd, root))) return { ...base, ...tag, orphan: false, reason: 'outside every project' };
    if (envs.some((e) => e.project && inside(l.cwd, e.project) && !testapps.isTestCwd(l.cwd, [e.project]))) return { ...base, ...tag, orphan: false, reason: 'owned by ENV: up' };
    return { ...base, ...tag, orphan: true, reason: 'orphan' };
  });
};
