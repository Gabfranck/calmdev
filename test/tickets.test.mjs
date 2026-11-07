// Phase 16 TIX (docs/connectors.md « Partir des tickets »): the tickets of a project listed and read for a planning,
// on the fakes only (test/fake-gh.mjs): a fake gh, a fake Linear on 127.0.0.1. Read only: no state, no comment.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakeGh, fakeLinear, LINEAR_KEY } from './fake-gh.mjs';
import { validatePlan } from '../lib/blocks.mjs';

const gh = fakeGh(); const lin = await fakeLinear();
process.env.ESCADRILLE_LINEAR_URL = lin.url; process.env.ESCADRILLE_GH = gh.file;
const tickets = await import('../lib/tickets.mjs');
after(() => lin.close());
const project = process.cwd();
const writes = () => lin.requests.filter((r) => /mutation/.test(r.query)).length;

test('listTickets: Linear by the project key, 50 at most, q filters; GitHub as GH-<n>', async () => {
  const all = await tickets.listTickets({ source: 'linear', project, key: LINEAR_KEY });
  assert.equal(all.length, 50);
  assert.deepEqual(all[0], { id: 'ORC-88', title: 'Ticket ORC-88', state: 'Todo', url: 'https://linear.app/acme/issue/ORC-88', source: 'linear' });
  assert.deepEqual((await tickets.listTickets({ source: 'linear', project, key: LINEAR_KEY, q: 'ops' })).map((t) => t.id), ['OPS-3']);
  assert.equal(lin.requests.at(-1).auth, LINEAR_KEY);
  const g = await tickets.listTickets({ source: 'github', project });
  assert.deepEqual(g.map((t) => t.id), ['GH-12', 'GH-13', 'GH-14']); assert.equal(g[0].source, 'github'); assert.equal(g[0].state, 'OPEN');
  assert.deepEqual((await tickets.listTickets({ source: 'github', project, q: 'export' })).map((t) => t.id), ['GH-13']);
  const call = gh.calls().find((c) => c.args.includes('--search'));
  assert.deepEqual(call.args.slice(0, 6), ['issue', 'list', '--state', 'open', '--limit', '50']);
  await assert.rejects(tickets.listTickets({ source: 'jira', project }), /linear ou github/);
});

test('a missing Linear key or a gh signed out: one sentence and the gesture', async () => {
  await assert.rejects(tickets.listTickets({ source: 'linear', project, key: null }), /aucune clé pour ce projet ; colle ta clé personnelle dans Réglages du projet/);
  await assert.rejects(tickets.ideaFromTickets({ project, ids: ['ORC-88'], key: null }), /Réglages du projet/);
  gh.setMode('unauth');
  try { await assert.rejects(tickets.listTickets({ source: 'github', project }), /gh n’est pas connecté : lance gh auth login/); } finally { gh.setMode(''); }
});

test('ideaFromTickets: a simulated planner receives three tickets, each 2 000 characters at most, the one-line instruction', async () => {
  const before = writes();
  const { idea, ids } = await tickets.ideaFromTickets({ project, ids: ['ORC-88', 'gh-12', 'GH-14', 'ORC-88'], key: LINEAR_KEY, idea: 'Fais le lot de novembre' });
  assert.deepEqual(ids, ['ORC-88', 'GH-12', 'GH-14']);
  assert.ok(idea.startsWith('Fais le lot de novembre\n\n## Les tickets\n\n' + tickets.CONSIGNE + '\n\n'));
  assert.equal(tickets.CONSIGNE.split('\n').length, 1);
  const parts = idea.split(/\n(?=### )/).slice(1);
  assert.equal(parts.length, 3);
  for (const p of parts) assert.ok(p.trim().length <= tickets.MAX_CHARS, `${p.slice(0, 20)} : ${p.length}`);
  const [a, g12, g14] = parts;
  assert.match(a, /^### ORC-88 · Ticket ORC-88 \(Todo\)\nhttps:\/\/linear\.app\/acme\/issue\/ORC-88\nDescription de ORC-88\nDerniers commentaires :\n- Léa, 2026-10-01 : ancien\n- Dev, 2026-10-30 : récent/);
  assert.match(g12, /Corps de l’issue 12/);
  assert.ok(!g12.includes('commentaire 1'), 'the three last comments only'); assert.match(g12, /- u2, 2026-10-02 : commentaire 2/);
  assert.match(g12, /commentaire 4 y+…/); assert.ok(g12.length < 1000, 'a long comment is cut to 300');
  assert.match(g14, /x…\nDerniers commentaires/, 'a long description gives way to the comments'); assert.ok(g14.trim().length > 1500);
  assert.equal(writes(), before, 'read only: no mutation sent to Linear');
  assert.ok(!gh.calls().some((c) => /comment|edit|close/.test(c.args[1] || '')), 'read only: no gh issue comment, edit or close');
});

test('ideaFromTickets: 8 tickets at most, an identifier badly formed refused, a default idea', async () => {
  const nine = Array.from({ length: 9 }, (_, i) => `AGO-${i + 1}`);
  await assert.rejects(tickets.ideaFromTickets({ project, ids: nine, key: LINEAR_KEY }), /8 tickets au plus/);
  await assert.rejects(tickets.ideaFromTickets({ project, ids: ['AGO88'], key: LINEAR_KEY }), /mal formé/);
  await assert.rejects(tickets.ideaFromTickets({ project, ids: [], key: LINEAR_KEY }), /au moins un ticket/);
  const fetchOne = async ({ id }) => ({ id, title: 't', description: '', comments: [] });
  const r = await tickets.ideaFromTickets({ project, ids: Array.from({ length: 8 }, (_, i) => `GH-${i + 1}`), fetchOne });
  assert.ok(r.idea.startsWith('Planifie le travail des tickets GH-1, GH-2'));
});

test('validatePlan takes GH-<n> on a session, and nothing else changes', () => {
  const s = { id: 'A', name: 'a', path: '/x', stops: ['fin'], prompt: 'p', tickets: ['GH-12', 'ORC-88'] };
  const { plan, errors } = validatePlan({ title: 'T', sessions: [s] });
  assert.equal(errors, undefined); assert.deepEqual(plan.sessions[0].tickets, ['GH-12', 'ORC-88']);
  for (const bad of [['gh-12'], ['GH12'], ['GH-']]) assert.match(validatePlan({ title: 'T', sessions: [{ ...s, tickets: bad }] }).errors.join(), /ticket/);
});
