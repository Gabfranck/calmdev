// lib/pilotbrief.mjs: one line per live session, then « À toi : n »; nothing of the dead (docs/sessions.md)
import test from 'node:test';
import assert from 'node:assert/strict';
import { briefOf, stopLine, permissionsOf, STOP_MAX } from '../lib/pilotbrief.mjs';

const node = (session, extra = {}) => ({ id: `p/${session}`, plan: 'p', session, status: 'running', cost: 0.4, budget: 3, summary: 'Fait : route ajoutée.\nReste : tests.', now: '', ...extra });

test('three live sessions, one waiting for a permission → three lines and the « À toi » line', () => {
  const nodes = [node('A'), node('B', { status: 'waiting' }), node('C')];
  const listed = { asks: [{ plan: 'p', session: 'B', tool: 'Bash', explain: { line: 'Lance npm test.' } }], kept: [], count: 1 };
  const b = briefOf({ nodes, alive: () => true, permissions: permissionsOf(listed), count: listed.count });
  assert.equal(b.sessions.length, 3);
  const lines = b.text.trim().split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^p\/A · running · route ajoutée\. · 0\.4\/3 \$$/);
  assert.match(lines[1], /autorisation : Lance npm test\./);
  assert.equal(lines[3], 'À toi : 1');
});

test('a worktree without a process, a merged session: absent', () => {
  const nodes = [node('A'), node('DEAD', { status: 'done' }), node('M', { status: 'merged' })];
  const b = briefOf({ nodes, alive: (p, s) => s !== 'DEAD', count: 0 });
  assert.deepEqual(b.sessions.map((s) => s.session), ['A']);
  assert.equal(b.text.trim().split('\n').pop(), 'À toi : 0');
});

test('the last stop is one sentence of 120 characters at most', () => {
  const long = 'Fait : ' + 'x'.repeat(300);
  assert.ok(stopLine({ summary: long }).length <= STOP_MAX);
  assert.equal(stopLine({ summary: 'Fait : une phrase courte ici. Une autre.\nReste : rien' }), 'une phrase courte ici.');
  assert.equal(stopLine({ summary: '', now: 'Lit server.mjs' }), 'Lit server.mjs');
});
