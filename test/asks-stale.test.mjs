import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closedOrStopped, listOf } from '../lib/asks.mjs';

const perm = { id: 'p1', kind: 'permission', tool: 'Bash', input: { command: 'git status' }, at: new Date().toISOString() };
const row = (over = {}) => ({ plan: 'p', session: 's', status: 'waiting', mode: 'page', pending: [perm], ...over });
// what asksNow does: drop closed or stopped rows, then list
const listed = (r, ctx) => listOf(closedOrStopped(r, ctx) ? [] : [{ ...r, cwd: '/w' }], { pilotOn: false });

test('a normal waiting session stays in the list', () => {
  const l = listed(row(), { hasProc: true });
  assert.equal(l.asks.length, 1);
});

test('a stopped session leaves the list, and comes back once it restarts', () => {
  const stopped = row({ mode: null });
  assert.equal(listed(stopped, { hasProc: false }).count, 0);
  assert.equal(stopped.pending.length, 1); // the wait stays in the thread
  assert.equal(listed({ ...stopped, mode: 'page' }, { hasProc: false }).asks.length, 1);
  assert.equal(listed(stopped, { hasProc: true }).asks.length, 1);
});

test('a merged, removed or retired session is absent', () => {
  assert.equal(listed(row({ worktree: { merged: true } }), { hasProc: false }).count, 0);
  assert.equal(listed(row({ worktree: { removed: true } }), { hasProc: true }).count, 0);
  assert.equal(listed(row(), { hasProc: true, retired: true }).count, 0);
});

test('an error session that really waits stays listed', () => {
  const l = listed(row({ status: 'error', mode: null }), { hasProc: false });
  assert.equal(l.asks.length, 1);
});
