// The servers of a session die with it (lib/sessionprocs.mjs, docs/sessions.md 2026-11-07): ownership, closure, orphans,
// on injected ps and lsof outputs and an in-memory base. Nothing reads the Mac, nothing is killed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as sp from '../lib/sessionprocs.mjs';
import { classify as gateClassify, refusal } from '../lib/gate.mjs';

const ROOT = '/work/proj';
const WT = `${ROOT}/.claude/worktrees/p-A`;
const PS = `    1     0 Sat Oct 31 21:02:11 2026     /sbin/launchd
  500     1 Sat Nov  7 09:00:00 2026     node server.mjs
  812   500 Sat Nov  7 10:00:00 2026     claude -p --input-format stream-json
  820   812 Sat Nov  7 10:01:00 2026     /bin/zsh -c node demo.mjs
  821   820 Sat Nov  7 10:01:01 2026     /usr/local/bin/node demo.mjs
  830     1 Sat Nov  7 10:02:00 2026     node ${ROOT}/node_modules/.bin/expo start
  840     1 Sat Nov  7 08:00:00 2026     node vite
  850     1 Sat Nov  7 08:00:00 2026     python3 -m http.server 9000
`;
const LISTEN = `p821\ncnode\nf20\nn*:3190\np830\ncnode\nf21\nn127.0.0.1:8082\np840\ncnode\nf22\nn*:5173\np850\ncPython\nf23\nn*:9000\np500\ncnode\nf24\nn*:3078\n`;
const CWD = `p821\nfcwd\n${'n' + ROOT}/demo\np830\nfcwd\nn${WT}/app\np840\nfcwd\nn${ROOT}\np850\nfcwd\nn/elsewhere\np500\nfcwd\nn/opt/calmdev\n`;
const run = async (cmd, args) => (cmd === 'ps' ? PS : args.includes('cwd') ? CWD : LISTEN);
const fresh = () => { const db = new DatabaseSync(':memory:'); sp.ensure(db); return db; };

test('snapshot: one ps, the listeners with cwd, the start time and the full command', async () => {
  const snap = await sp.snapshot({ run });
  const l = snap.listeners.find((x) => x.port === 3190);
  assert.equal(l.pid, 821); assert.equal(l.cwd, `${ROOT}/demo`); assert.equal(l.command, '/usr/local/bin/node demo.mjs');
  assert.equal(l.since, new Date(2026, 10, 7, 10, 1, 1).toISOString());
});

test('claim: a descendant of the claude process or a cwd in the worktree; the project root alone never', async () => {
  const snap = await sp.snapshot({ run });
  const rows = sp.claim({ snap, sessions: [{ plan: 'p', session: 'A', pid: 812, worktree: WT }] });
  assert.deepEqual(rows.map((r) => r.pid).sort(), [821, 830], '821 by descent (cwd in the root), 830 by its worktree');
  assert.ok(!rows.some((r) => r.pid === 840), 'a server in the project root is nobody\'s');
});

test('record keeps the first owner; a reused pid (other start) is not alive', async () => {
  const db = fresh(); const snap = await sp.snapshot({ run });
  sp.record(db, sp.claim({ snap, sessions: [{ plan: 'p', session: 'A', pid: 812, worktree: WT }] }));
  sp.record(db, sp.claim({ snap, sessions: [{ plan: 'q', session: 'B', pid: 812, worktree: null }] }));
  assert.deepEqual(sp.rowsOf(db, 'q', 'B'), []);
  const row = sp.rowsOf(db, 'p', 'A').find((r) => r.pid === 821);
  assert.equal(sp.alive(row, snap.ps), true);
  assert.equal(sp.alive({ ...row, started: new Date(2026, 0, 1).toISOString() }, snap.ps), false);
});

test('closeTargets: its live rows and its worktree listeners, never calmdev; worktree null kills only the recorded', async () => {
  const db = fresh(); const snap = await sp.snapshot({ run });
  sp.record(db, sp.claim({ snap, sessions: [{ plan: 'p', session: 'A', pid: 812, worktree: null }] })); // 821 only
  const all = sp.closeTargets({ db, plan: 'p', session: 'A', snap, worktree: WT, self: 500, selfPort: 3078 });
  assert.deepEqual(all.map((t) => t.pid).sort(), [821, 830]);
  const recorded = sp.closeTargets({ db, plan: 'p', session: 'A', snap, worktree: null, self: 500, selfPort: 3078 });
  assert.deepEqual(recorded.map((t) => t.pid), [821]);
  db.prepare('insert into session_procs values (?, ?, ?, ?, ?, ?, ?)').run('p', 'A', 500, snap.ps.find((p) => p.pid === 500).since, 3078, 'node server.mjs', '/opt/calmdev');
  assert.ok(!sp.closeTargets({ db, plan: 'p', session: 'A', snap, worktree: null, self: 500, selfPort: 3078 }).some((t) => t.pid === 500));
  sp.forget(db, 'p', 'A'); assert.deepEqual(sp.rowsOf(db, 'p', 'A'), []);
});

test('stop: SIGTERM, then SIGKILL after the wait to those still up', async () => {
  const sig = []; const up = new Set([821, 830]);
  const kill = (pid, s) => { sig.push([pid, s]); if (s === 'SIGTERM' && pid === 830) up.delete(830); if (s === 0 && !up.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); if (s === 'SIGKILL') up.delete(pid); };
  const waits = [];
  const sent = await sp.stop([{ pid: 821 }, { pid: 830 }], { kill, sleep: async (ms) => waits.push(ms) });
  assert.equal(sent.length, 2); assert.deepEqual(waits, [3000]);
  assert.deepEqual(sig.filter(([, s]) => s === 'SIGKILL'), [[821, 'SIGKILL']]);
});

test('listLine reads like the contract', () => {
  assert.equal(sp.listLine([{ pid: 1, port: 3190, command: '/usr/local/bin/node demo.mjs' }, { pid: 2, port: 8082, command: `node ${ROOT}/node_modules/.bin/expo start` }]), ':3190 (node demo.mjs), :8082 (expo start)');
});

test('classify: orphan in a project root, owned by a live session, by ENV: up, outside every project, calmdev itself', async () => {
  const db = fresh(); const snap = await sp.snapshot({ run });
  sp.record(db, sp.claim({ snap, sessions: [{ plan: 'p', session: 'A', pid: 812, worktree: WT }] }));
  const base = { listeners: snap.listeners, rows: sp.allRows(db), roots: [ROOT], self: 500, selfPort: 3078 };
  const by = (list) => Object.fromEntries(list.map((x) => [x.port, x]));
  let c = by(sp.classify({ ...base, sessions: [{ plan: 'p', id: 'A', status: 'running', worktree: { path: WT } }] }));
  assert.equal(c[3190].orphan, false); assert.equal(c[3190].reason, 'owned by p/A'); assert.equal(c[3190].plan, 'p');
  assert.equal(c[5173].orphan, true, 'the root alone owns nothing');
  assert.equal(c[9000].orphan, false); assert.equal(c[9000].reason, 'outside every project');
  assert.equal(c[3078].reason, 'calmdev itself');
  for (const s of Object.values(c)) for (const k of ['pid', 'port', 'command', 'cwd', 'since', 'orphan']) assert.ok(k in s, k);
  c = by(sp.classify({ ...base, sessions: [{ plan: 'p', id: 'A', status: 'done', worktree: { path: WT } }] }));
  assert.equal(c[3190].orphan, true, 'a done session owns nothing alive'); assert.equal(c[3190].session, 'A');
  c = by(sp.classify({ ...base, sessions: [], envs: [{ project: ROOT }] }));
  assert.equal(c[5173].reason, 'owned by ENV: up'); assert.equal(c[8082].orphan, true, 'a worktree is not the environment');
});

test('the gate: stop-orphan needs a proof, and its 403 names the button', () => {
  const row = gateClassify('POST', '/api/running/stop-orphan');
  assert.equal(row.kind, 'act'); assert.deepEqual(row.opens, ['cookie', 'device', 'pilot']);
  assert.equal(refusal(row, 'POST', '/api/running/stop-orphan').messageKey, 'srv.gate.stopOrphan');
});
