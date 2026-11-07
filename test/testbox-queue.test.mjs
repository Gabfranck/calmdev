// One merge verification at a time on the Mac, and a ceiling on node --test (phase 12, TB; lib/testbox.mjs):
//  1. two verifyMerge of one process run one after the other, never together;
//  2. the machine-wide lock: a lock whose pid is dead is taken over at once, one held by a live pid makes the next
//     verification wait until it is released, and a wait past its cap takes the lock and says so in the output;
//  3. --test-concurrency=N added to a node --test that lacks it, never to one that has it nor to another command.
// The verifications run through test/fake-box.sh (Seatbelt cannot nest inside a session sandbox) on a lock file of
// their own, never the machine's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as TB from '../lib/testbox.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const NODE = process.execPath;
const BOX = path.join(HERE, 'fake-box.sh');
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const repo = () => { const root = tmp('escadrille-tbq-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); writeFileSync(path.join(root, 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); sh(root, ['branch', 'b']); return root; };
const deadPid = () => spawnSync(NODE, ['-e', '']).pid; // a child that has exited and been reaped
const settled = (p) => { const s = { done: false, at: 0 }; p.then(() => { s.done = true; s.at = Date.now(); }, () => { s.done = true; s.at = Date.now(); }); return s; };

test('two verifications of one process never run together: the second starts after the first ends', async () => {
  const root = repo(); const dir = tmp('escadrille-tbq-log-'); const log = path.join(dir, 'log.txt'); const lockFile = path.join(dir, 'verify.lock');
  const stamp = path.join(dir, 'stamp.mjs');
  writeFileSync(stamp, "import fs from 'node:fs'; fs.appendFileSync(process.argv[2], `${process.argv[3]} ${process.argv[4]} ${Date.now()}\\n`);\n");
  const cmd = (who) => `"${NODE}" "${stamp}" "${log}" ${who} start && sleep 1 && "${NODE}" "${stamp}" "${log}" ${who} end`;
  const [r1, r2] = await Promise.all([
    TB.verifyMerge({ root, branch: 'b', cmd: cmd('one'), box: BOX, timeoutMs: 60000, lockFile }),
    TB.verifyMerge({ root, branch: 'b', cmd: cmd('two'), box: BOX, timeoutMs: 60000, lockFile }),
  ]);
  assert.equal(r1.code, 0, r1.out); assert.equal(r2.code, 0, r2.out);
  const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => { const [who, what, at] = l.split(' '); return { who, what, at: Number(at) }; });
  assert.deepEqual(lines.map((l) => `${l.who} ${l.what}`), ['one start', 'one end', 'two start', 'two end'], 'in the order of the calls, one after the other');
  assert.ok(lines[2].at >= lines[1].at, 'the second starts after the first ends');
  assert.equal(existsSync(lockFile), false, 'the lock is released');
  // a verification that throws (no such branch) does not block the queue
  await assert.rejects(TB.verifyMerge({ root, branch: 'absente', cmd: 'true', box: BOX, lockFile }));
  assert.equal((await TB.verifyMerge({ root, branch: 'b', cmd: 'true', box: BOX, lockFile })).code, 0);
  assert.equal(existsSync(lockFile), false);
});

test('the lock of the machine: a dead pid is taken over at once, a live one makes the verification wait for its release', async () => {
  const root = repo(); const dir = tmp('escadrille-tbq-lock-'); const lockFile = path.join(dir, 'verify.lock');
  // a lock left by a server that died: no wait, and the output says it was taken over
  const dead = deadPid(); writeFileSync(lockFile, `${dead} ancien\n`);
  const t0 = Date.now();
  const r = await TB.verifyMerge({ root, branch: 'b', cmd: 'true', box: BOX, timeoutMs: 60000, lockFile });
  assert.equal(r.code, 0, r.out); assert.ok(Date.now() - t0 < 20000, 'no wait on a dead pid');
  assert.match(r.out, new RegExp(`verrou de vérification repris : son processus ${dead} est mort`));
  assert.equal(existsSync(lockFile), false);
  // a lock held by a live process (this one, as another server would): the verification waits until it is gone
  writeFileSync(lockFile, `${process.pid} autre\n`);
  const p = TB.verifyMerge({ root, branch: 'b', cmd: 'true', box: BOX, timeoutMs: 60000, lockFile }); const s = settled(p);
  await new Promise((res) => setTimeout(res, 1500));
  assert.equal(s.done, false, 'still waiting while the lock is held');
  const freedAt = Date.now(); rmSync(lockFile);
  const w = await p; assert.equal(w.code, 0, w.out); assert.ok(s.at >= freedAt);
  assert.doesNotMatch(w.out, /verrou de vérification/, 'a lock released by its owner is not stale');
  // a lock held past the cap of the wait (ten minutes on the Mac, one second here): taken, and the output says it
  writeFileSync(lockFile, `${process.pid} bloque\n`);
  const c = await TB.verifyMerge({ root, branch: 'b', cmd: 'true', box: BOX, timeoutMs: 60000, lockFile, lockMaxWaitMs: 1000 });
  assert.equal(c.code, 0, c.out); assert.match(c.out, /verrou de vérification jugé périmé après 1 s d'attente \(processus \d+\) : repris/);
  assert.equal(existsSync(lockFile), false);
  assert.equal(TB.VERIFY_LOCK_MAX_WAIT_MS, 600000, 'never more than ten minutes on a lock');
});

test('--test-concurrency added to a node --test that lacks it, never to one that has it nor to another command', () => {
  const n = TB.TEST_CONCURRENCY;
  assert.ok(Number.isInteger(n) && n >= 1);
  if (!process.env.ESCADRILLE_TEST_CONCURRENCY) assert.ok(n >= 2 && n <= 4, 'between 2 and 4 from the cores');
  // 1. a node --test without it: the ceiling right after --test
  assert.equal(TB.capConcurrency(TB.DEFAULT_SELF_TEST, 3), 'node --test --test-concurrency=3 test/*.test.mjs');
  assert.equal(TB.capConcurrency('"/opt/n 22/bin/node" --no-warnings --test t/*.test.mjs', 2), '"/opt/n 22/bin/node" --no-warnings --test --test-concurrency=2 t/*.test.mjs');
  assert.equal(TB.capConcurrency('npm run build && /usr/local/bin/node --test', 4), 'npm run build && /usr/local/bin/node --test --test-concurrency=4');
  // 2. a command that says its own: as written
  assert.equal(TB.capConcurrency('node --test --test-concurrency=8 test/*.test.mjs', 3), 'node --test --test-concurrency=8 test/*.test.mjs');
  assert.equal(TB.capConcurrency('node --test-concurrency 1 --test x.mjs', 3), 'node --test-concurrency 1 --test x.mjs');
  // 3. another project's command: as written
  for (const c of ['npm test', 'pytest -q', 'node scripts/check.mjs --test', 'vitest run --test', 'make test']) assert.equal(TB.capConcurrency(c, 3), c, c);
  // the rerun of a failing file keeps the ceiling
  assert.equal(TB.rerunCommand(TB.capConcurrency(TB.DEFAULT_SELF_TEST, 3), 'test/b.test.mjs'), 'node --test --test-concurrency=3 test/b.test.mjs');
});
