// The grouped QA (lib/qa.mjs): a session waiting for the developer does not hold it back, a working one does (7 November)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocksQa, needsProjectQa } from '../lib/qa.mjs';

test('only a working session holds the grouped QA back, never one waiting for the developer', () => {
  assert.equal(blocksQa('running'), true);
  assert.equal(blocksQa('starting'), true);
  for (const s of ['waiting', 'done', 'error', 'todo', 'later', 'paused']) assert.equal(blocksQa(s), false, s);
  const states = { a: ['done'], b: ['waiting', 'done'] };
  const plans = Object.entries(states).map(([id, st]) => ({ id, mergedAt: '2026-11-06T22:00:00Z', running: st.some(blocksQa) }));
  assert.equal(needsProjectQa({ plans, lastQaAt: null }), true);
  assert.equal(needsProjectQa({ plans: [...plans, { id: 'c', mergedAt: null, running: ['running'].some(blocksQa) }], lastQaAt: null }), false);
});
