// scripts/e2e-real.mjs in --dry mode: the whole trial (throwaway repo, server, plan, stop, answer, finish, review,
// journal, cleanup) against the fake claude; the real mode only differs by the binary (docs/lancement.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run, parseArgs, BUDGET_USD, MODEL } from '../scripts/e2e-real.mjs';

test('parseArgs reads --dry, --out, --timeout-min, --keep and refuses the rest', () => {
  assert.deepEqual(parseArgs([]), { dry: false, keep: false, out: null, timeoutMin: 10 });
  assert.deepEqual(parseArgs(['--dry', '--keep', '--out', 'x.json', '--timeout-min', '2']), { dry: true, keep: true, out: 'x.json', timeoutMin: 2 });
  assert.throws(() => parseArgs(['--now']), /unknown argument/);
  assert.throws(() => parseArgs(['--timeout-min', '0']), /positive/);
});

test('the real trial is capped at 1 $ on Sonnet', () => { assert.equal(BUDGET_USD, 1); assert.equal(MODEL, 'claude-sonnet-5-5'); });

// The session sandbox refuses to let Node spawn git (spawn EPERM, docs/terrain.md): the test then says so instead of failing
const gitFromNode = !spawnSync('git', ['--version']).error;

test('--dry runs the whole trial against the fake claude, writes the journal and cleans up', { timeout: 90000, skip: gitFromNode ? false : 'git cannot be spawned from Node here (sandbox): runs on the Mac' }, async () => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'escadrille-e2e-test-')), 'journal.json');
  const r = await run({ dry: true, out, timeoutMin: 1 });
  const j = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(r.ok, true, j.error || JSON.stringify(j.checks));
  assert.equal(j.mode, 'dry');
  assert.deepEqual(j.checks, { stopReached: true, finished: true, underBudget: true, reviewOpens: true });
  assert.deepEqual(j.review.files, ['docs/essai.txt']);
  assert.deepEqual(j.answers.map((a) => a.kind), ['permission', 'reply']);
  assert.equal(j.session.status, 'done');
  assert.deepEqual(j.steps.map((s) => s.what).filter((w) => ['launched', 'permission', 'stop', 'answered', 'done', 'review'].includes(w)), ['launched', 'permission', 'stop', 'answered', 'done', 'review']);
  assert.equal(r.cleaned, true); assert.ok(!existsSync(r.dir), 'the throwaway folder is gone');
});
