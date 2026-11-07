// PROC (7 Nov.): nothing calmdev started outlives its session or its suite, and the top line counts only what calmdev started.
// docs: .escadrille/proc-regles.md. No real ps/lsof: fixed outputs, injected runners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isClaude, isFakeClaude, others } from '../lib/running.mjs';
import * as sp from '../lib/sessionprocs.mjs';
import * as testapps from '../lib/testapps.mjs';
import * as done from '../lib/sessiondone.mjs';
import { testEnv } from './test-env.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const VER = '/private/var/folders/xx/T/escadrille-verify-AbC123';

test('a fake claude (tmp escadrille-* folder, test/fixtures) is not a Claude Code process; the real ones are', async () => {
  assert.equal(isClaude('claude -p x'), true);
  assert.equal(isClaude('node /opt/dev/.nvm/lib/node_modules/@anthropic-ai/claude-code/cli.js'), true);
  assert.equal(isClaude('node /var/folders/ab/T/escadrille-9Zq/claude --output-format stream-json'), false);
  assert.equal(isClaude(`${VER}/test/fixtures/claude -p`), false);
  assert.equal(isFakeClaude('/opt/dev/.local/bin/claude'), false);
  const PS = '  10     1 Sat Nov  7 08:00:00 2026     claude -p vrai\n  11     1 Sat Nov  7 08:00:00 2026     node /var/folders/ab/T/escadrille-9Zq/claude -p faux\n';
  const got = await others({ run: async (cmd) => (cmd === 'ps' ? PS : '') });
  assert.deepEqual(got.map((p) => p.pid), [10]);
});

const PSV = `    1     0 Sat Nov  7 06:00:00 2026     /sbin/launchd
  500     1 Sat Nov  7 06:00:00 2026     node ${VER}/server.mjs
  501   500 Sat Nov  7 06:00:01 2026     node ${VER}/test/fixtures/helper.mjs
  600     1 Sat Nov  7 06:00:00 2026     node ${VER}/server.mjs
  700   600 Sat Nov  7 06:00:00 2026     node ${VER}/server.mjs
  800     1 Sat Nov  7 06:00:00 2026     com.docker.backend
  900     1 Sat Nov  7 06:00:00 2026     php-fpm: master process
 1000   999 Sat Nov  7 06:00:00 2026     node ${VER}/server.mjs`;

test('verifyOrphans: a suite whose parent is gone is stopped; a living parent, Docker, php-fpm and this server are not', async () => {
  const ps = (await import('../lib/running.mjs')).parsePs(PSV);
  const got = sp.verifyOrphans({ ps, self: 600 }).map((t) => t.pid);
  assert.deepEqual(got, [500, 1000]); // 500: ppid 1; 1000: ppid 999 is not in ps; 501/700 have a living parent; 600 is us
});

test('classify: a verification server with a dead parent is an orphan, with a living parent it is its suite\'s; Docker outside every project is not touched', () => {
  const ls = [
    { pid: 500, port: 3301, command: `node ${VER}/server.mjs`, cwd: VER, since: 'a', parentDead: true },
    { pid: 700, port: 3302, command: `node ${VER}/server.mjs`, cwd: VER, since: 'a', parentDead: false },
    { pid: 800, port: 5432, command: 'com.docker.backend', cwd: '/', since: 'a', parentDead: true },
  ];
  const out = sp.classify({ listeners: ls, roots: ['/p'], self: 1, selfPort: 3078 });
  assert.deepEqual(out.map((o) => o.orphan), [true, false, false]);
  assert.equal(out[1].reason, 'owned by a running suite');
});

test('classify: a recorded server of a finished session whose parent is dead is an orphan; of a waiting session it is kept', () => {
  const rows = [{ plan: 'p', session: 'A', pid: 40, started: 's' }];
  const l = { pid: 40, port: 3190, command: 'node demo.mjs', cwd: '/p/.claude/worktrees/w', since: 's', parentDead: true };
  const sessions = (status) => [{ plan: 'p', id: 'A', status, worktree: { path: '/p/.claude/worktrees/w' } }];
  assert.equal(sp.classify({ listeners: [l], rows, sessions: sessions('done'), roots: ['/p'] })[0].orphan, true);
  assert.equal(sp.classify({ listeners: [l], rows, sessions: sessions('waiting'), roots: ['/p'] })[0].orphan, false);
});

test('the server of a session done more than an hour ago stops, even when its row was rewritten since (sessions.at moves)', () => {
  const NOW = Date.parse('2026-11-07T20:00:00Z'); const roots = ['/p']; const wt = '/p/.claude/worktrees/w';
  const app = { pid: 9, port: 3298, cwd: wt, command: 'node server.mjs' };
  const row = (extra) => ({ plan: 'p', id: 'BKL', status: 'done', at: '2026-11-07T19:50:00Z', worktree: { path: wt }, ...extra });
  assert.deepEqual(testapps.toStop({ apps: [app], rows: [row({})], roots, now: NOW }), [], 'without the fixed date a rewritten row keeps it');
  assert.deepEqual(testapps.toStop({ apps: [app], rows: [row({ doneAt: '2026-11-07T10:00:00Z' })], roots, now: NOW }).map((a) => a.why), ['done']);
  assert.deepEqual(testapps.toStop({ apps: [app], rows: [row({ doneAt: '2026-11-07T19:30:00Z' })], roots, now: NOW }), [], 'under an hour');
});

test('session_done: written once, kept across rewrites, erased when the session reopens', () => {
  const db = new DatabaseSync(':memory:'); done.ensure(db);
  done.sync(db, [{ plan: 'p', id: 'A', status: 'done', at: '2026-11-07T10:00:00Z' }]);
  done.sync(db, [{ plan: 'p', id: 'A', status: 'done', at: '2026-11-07T19:00:00Z' }]); // rewritten later: the first date stays
  assert.equal(done.doneAt(db, 'p', 'A', 'x'), '2026-11-07T10:00:00Z');
  done.sync(db, [{ plan: 'p', id: 'A', status: 'running', at: '2026-11-07T20:00:00Z' }]);
  assert.equal(done.doneAt(db, 'p', 'A', 'fallback'), 'fallback');
});

test('the top line counts what calmdev started: a test app and an orphan yes, Docker and php-fpm no, folded in one line', () => {
  const g = { T: (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k) }; g.T.usd = (n) => `${n} $`;
  runInNewContext(readFileSync(path.join(HERE, '..', 'public', 'livecount.js'), 'utf8'), g);
  const L = g.EscadrilleLive;
  const servers = [
    { pid: 1, port: 3190, role: 'test', cwd: '/p/.claude/worktrees/a', command: 'node server.mjs', session: 'A' },
    { pid: 2, port: 3191, role: 'test', cwd: VER, command: 'node server.mjs', orphan: true },
    { pid: 3, port: 5432, role: 'other', command: 'com.docke', cwd: '/' },
    { pid: 4, port: 9000, role: 'other', command: 'php-fpm: master process', cwd: '/' },
    { pid: 5, port: 3078, role: 'env', project: '/p', cwd: '/p', command: 'node server.mjs' },
  ];
  const m = L.group({ ours: [], servers, vitals: null }, {}, { canStop: true });
  const html = L.markup(m, true);
  const plain = html.replace(/&quot;/g, '"');
  assert.match(plain, /live\.apps:\{"n":2\}/, 'two: the test app and the orphan');
  assert.match(plain, /live\.macHead:\{"n":2,"names":"Docker, php-fpm"\}/);
  assert.equal((html.match(/data-orph-stop=/g) || []).length, 1, 'only the orphan is stoppable');
  assert.match(html, /live\.orphTag/, 'the orphan says so');
});

test('a suite killed in mid-flight leaves no child: the server watches its parent and follows it', async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-proc-')));
  const child = path.join(dir, 'child.mjs'); const parent = path.join(dir, 'parent.mjs'); const pidFile = path.join(dir, 'pid');
  writeFileSync(child, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`);
  writeFileSync(parent, `import { spawn } from 'node:child_process'; import { testEnv } from ${JSON.stringify(path.join(HERE, 'test-env.mjs'))};
spawn(process.execPath, [${JSON.stringify(child)}], { env: testEnv(), stdio: 'ignore' }); setInterval(() => {}, 1000);\n`);
  const p = spawn(process.execPath, [parent], { stdio: 'ignore' });
  const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
  const up = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const read = () => { try { return Number(readFileSync(pidFile, 'utf8')); } catch { return 0; } };
  assert.ok(await until(() => read() > 0, 5000), 'the child started');
  const pid = read(); assert.ok(up(pid));
  p.kill('SIGKILL'); // no exit handler runs
  assert.ok(await until(() => !up(pid), 8000), 'the child is gone after its parent was killed');
});
