// The merge verification counts only the new failures (lib/testbox.mjs, known failures of main):
// a known red does not block, a new one does, a known one gone green is reported, a timeout is run alone once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as TB from '../lib/testbox.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const BOX = path.join(HERE, 'fake-box.sh');
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const repo = () => { const root = tmp('escadrille-kf-'); sh(root, ['init', '-q', '-b', 'main']); sh(root, ['config', 'user.email', 't@t']); sh(root, ['config', 'user.name', 't']); writeFileSync(path.join(root, 'a.txt'), 'un\n'); sh(root, ['add', '.']); sh(root, ['commit', '-qm', 'start']); sh(root, ['branch', 'b']); return root; };
// A command that prints a TAP report and exits with the given code
const tapCmd = (root, name, tap, code) => { const f = path.join(root, '..', `${name}-${path.basename(root)}.txt`); writeFileSync(f, tap); return `cat '${f}'; exit ${code}`; };
const KNOWN = [{ name: 'trace test', date: '2026-11-07', reason: 'red on main' }, { name: 'perf test', date: '2026-11-07', reason: 'load' }];
const lock = () => path.join(tmp('escadrille-kf-lock-'), 'v.lock');
const run = (root, cmd, known = KNOWN) => TB.verifyMerge({ root, branch: 'b', cmd, box: BOX, timeoutMs: 60000, lockFile: lock(), known });

test('a known failure does not block and is said in a line', async () => {
  const root = repo();
  const r = await run(root, tapCmd(root, 'k', 'TAP version 13\nok 1 - fine\nnot ok 2 - trace test\n  ---\n  error: \'boom\'\n  ...\n1..2\n', 1));
  assert.equal(r.code, 0, r.out); assert.equal(r.rawCode, 1);
  assert.deepEqual(r.knownFailures.map((k) => k.name), ['trace test']); assert.deepEqual(r.newFailures, []);
  assert.match(TB.knownReport(r).join('\n'), /1 échec\(s\) connu\(s\) de main, non bloquant\(s\) : « trace test »/);
});

test('a new failure blocks, next to a known one', async () => {
  const root = repo();
  const r = await run(root, tapCmd(root, 'n', 'ok 1 - fine\nnot ok 2 - trace test\nnot ok 3 - brand new\n1..3\n', 1));
  assert.notEqual(r.code, 0); assert.deepEqual(r.newFailures, ['brand new']); assert.deepEqual(r.knownFailures.map((k) => k.name), ['trace test']);
  assert.match(TB.knownReport(r).join('\n'), /Échec\(s\) nouveau\(x\) : « brand new »/);
});

test('a known failure that turned green is reported to remove from the list', async () => {
  const root = repo();
  const r = await run(root, tapCmd(root, 'h', 'ok 1 - fine\nok 2 - trace test\nnot ok 3 - perf test\n1..3\n', 1));
  assert.equal(r.code, 0); assert.deepEqual(r.healed, ['trace test']);
  assert.match(TB.knownReport(r).join('\n'), /redevenu\(s\) vert : « trace test » — à retirer de la liste/);
  const g = await run(root, tapCmd(root, 'g', 'ok 1 - trace test\nok 2 - fine\n1..2\n', 0));
  assert.equal(g.code, 0); assert.deepEqual(g.healed, ['trace test']);
});

test('a test that timed out is run alone once, and the report says so', async () => {
  const root = repo(); const counter = path.join(root, '..', `count-${path.basename(root)}`);
  // first run: the test times out; second run (the rerun): green
  const timeoutTap = 'not ok 1 - slow test\n  ---\n  failureType: "testTimeoutFailure"\n  error: "test timed out after 1000ms"\n  ...\n1..1\n';
  const redFile = path.join(root, '..', `red-${path.basename(root)}.txt`); const greenFile = path.join(root, '..', `green-${path.basename(root)}.txt`);
  writeFileSync(redFile, timeoutTap); writeFileSync(greenFile, 'ok 1 - slow test\n1..1\n');
  const cmd = `if [ -f '${counter}' ]; then cat '${greenFile}'; exit 0; else : > '${counter}'; cat '${redFile}'; exit 1; fi`;
  const r = await run(root, cmd, []);
  assert.equal(r.code, 0, r.out); assert.deepEqual(r.retriedTimeouts, [{ name: 'slow test', green: true }]);
  assert.match(TB.knownReport(r).join('\n'), /Délai \(timeout\) relancé seul une fois : « slow test » → vert au second passage/);
  // still red the second time: counted
  const cmd2 = `cat '${redFile}'; exit 1`;
  const s = await run(root, cmd2, []);
  assert.notEqual(s.code, 0); assert.deepEqual(s.newFailures, ['slow test']); assert.deepEqual(s.retriedTimeouts, [{ name: 'slow test', green: false }]);
});

test('the known list is read from the private folder, the tracked file only for the product itself', () => {
  const root = tmp('escadrille-kf-load-'); mkdirSync(path.join(root, '.calmdev')); mkdirSync(path.join(root, 'test'));
  writeFileSync(path.join(root, '.calmdev', 'echecs-connus.json'), JSON.stringify([{ name: 'a', date: '2026-11-07', reason: 'x' }]));
  writeFileSync(path.join(root, 'test', 'known-failures.json'), JSON.stringify([{ name: 'b', date: '2026-11-07', reason: 'y' }]));
  assert.deepEqual(TB.loadKnownFailures(root).map((k) => k.name), ['a']);
  assert.deepEqual(TB.loadKnownFailures(root, { tracked: true }).map((k) => k.name), ['a', 'b']);
  assert.deepEqual(TB.loadKnownFailures(tmp('escadrille-kf-none-')), []);
});

test('nested failures: a file whose subtests failed counts through its subtests only', () => {
  const out = 'TAP version 13\n# Subtest: x\n    not ok 1 - inner one\n      ---\n      ...\n    ok 2 - inner two\nnot ok 1 - test/x.test.mjs\n';
  assert.deepEqual(TB.parseTests(out).failed.map((e) => e.name), ['inner one']);
});
