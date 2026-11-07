// The guardrail line of every session's prompt names the five files the sandbox refuses (KEY_GATED, WRITE_DENIED) and
// nothing else: five sessions of 2 November believed server.mjs and lib/planner.mjs refused and left patches to the pilot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { instruction, WRITE_DENIED, sandboxGuard } from '../lib/guardrails.mjs';
import { writeNote } from '../lib/planner.mjs';

// lib/planner.mjs says it in every session's system prompt, from the sandbox's own denyWrite list
test('the system prompt names the five refused files and says everything else is written', () => {
  const wt = path.join(process.cwd(), '.calmdev', 'fake-worktree');
  const settings = sandboxGuard({ sandbox: { enabled: true } }, { worktree: wt });
  const note = writeNote(settings, wt);
  const m = /refusés en écriture : (.+?)\. Tout le reste/.exec(note);
  assert.ok(m, note);
  const listed = m[1].split(/,\s*/);
  assert.deepEqual([...listed].sort(), [...FIVE_FILES].sort());
  assert.ok(!listed.includes('server.mjs') && !listed.includes('lib/planner.mjs'));
  assert.match(note, /Tout le reste, server\.mjs et lib\/planner\.mjs compris, s'écrit[^.]*fusion\./);
  assert.equal(writeNote({ sandbox: { enabled: true } }, wt), '', 'no note outside Escadrille');
});
const FIVE_FILES = ['lib/guardrails.mjs', 'lib/policy.mjs', 'docs/autonomy.md', 'test/guardrails.test.mjs', 'CLAUDE.md'];

const FIVE = ['lib/guardrails.mjs', 'lib/policy.mjs', 'docs/autonomy.md', 'test/guardrails.test.mjs', 'CLAUDE.md'];
// The fix lives in lib/guardrails.mjs (KEY_GATED): until Dev applies its patch by the key, these tests run as todo
// (reported, not failing the suite); once the new line is there they are strict.
const todo = /Tout le reste/.test(instruction()) ? false : 'attend le patch de lib/guardrails.mjs (accord par la clé)';

test('the guardrail key-gated list still has its five files', () => {
  assert.deepEqual([...WRITE_DENIED].sort(), [...FIVE].sort());
});

test('the prompt names the five refused files, and only them', { todo }, () => {
  const text = instruction();
  const m = /Garde-fous protégés \(docs\/autonomy\.md\) : (.+?)\. Le bac à sable refuse de les écrire/.exec(text);
  assert.ok(m, text);
  const listed = m[1].split(/,\s*/).map((s) => s.trim());
  assert.deepEqual(listed.sort(), [...FIVE].sort());
  assert.ok(!listed.includes('server.mjs') && !listed.includes('lib/planner.mjs'));
});

test('the prompt says in one sentence that everything else is written and reviewed at the merge', { todo }, () => {
  assert.match(instruction(), /Tout le reste, server\.mjs et lib\/planner\.mjs compris, s'écrit[^.]*fusion\./);
});
