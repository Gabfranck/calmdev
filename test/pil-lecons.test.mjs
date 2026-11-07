// PIL, the lessons of 3 November (docs/pilot.md, « Les gardes du 3 novembre »): events built by hand, a simulated clock
import test from 'node:test';
import assert from 'node:assert/strict';
import * as wake from '../lib/wake.mjs';
import * as pilot from '../lib/pilot.mjs';
import { pilotCostIn, pilotLines, storyOf } from '../lib/story.mjs';
import { createWatchdog, requestsOf, oldestAge, ageLine, policyAllows } from '../lib/pilotwatch.mjs';

const T0 = Date.parse('2026-11-03T15:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

test('PIL 1 repli : un arrêt data ne réveille le pilote qu’une fois, puis ni réveil ni relance', () => {
  const entry = { plan: 'p', session: 'DEV', stop: 1, stopKind: 'data', kind: 'reply' };
  let held = [];
  const first = wake.fallbackGate({ entry, row: { status: 'waiting' }, held });
  // the first fallback is played (Guidé lets a data stop fall back, test/autonomy.test.mjs) and the stop is kept
  assert.deepEqual(first, { fire: true, wake: true, hold: true, why: 'premier repli d’un arrêt de Dev' });
  held = [...held, wake.stopKey(entry)];
  assert.deepEqual(wake.fallbackGate({ entry, row: { status: 'waiting' }, held }), { fire: false, wake: false, hold: false, why: 'attend Dev' });
  // the same stop again, with a new pendingId: dropped by the filter, no wake
  const again = wake.classify({ waiting: [{ ...entry, pendingId: 'r2', at: iso(T0) }], held });
  assert.equal(again.judge, false); assert.equal(again.dropped[0].why, 'attend Dev');
  // a review counts as Dev's too; an info stop follows its fallback
  assert.equal(wake.fallbackGate({ entry: { ...entry, stopKind: 'info', kind: 'review' } }).wake, true);
  assert.equal(wake.fallbackGate({ entry: { ...entry, stopKind: 'info' } }).fire, true);
  // Dev answers: the gate opens again
  held = wake.releaseHeld(held, 'p', 'DEV'); assert.deepEqual(held, []);
});

test('PIL 1 repli : une session finie ne relance jamais son repli ni ne réveille', () => {
  const entry = { plan: 'p', session: 'MCP', stop: 0, stopKind: 'info', kind: 'reply' };
  assert.deepEqual(wake.fallbackGate({ entry, row: { status: 'waiting', done: true } }), { fire: false, wake: false, hold: false, why: 'finie' });
  const cl = wake.classify({ waiting: [{ ...entry, pendingId: 'r9' }], rows: { 'p/MCP': { status: 'waiting', done: true } } });
  assert.equal(cl.judge, false); assert.equal(cl.dropped[0].why, 'finie');
});

test('PIL 2 attente croisée : deux sessions qui s’attendent donnent un seul réveil nommé', () => {
  const sessions = [
    { plan: 'p', id: 'API', status: 'waiting', after: ['FRONT'], fallback: false, stopKind: 'info', at: iso(T0) },
    { plan: 'p', id: 'FRONT', status: 'waiting', state: { why: "j'attends API pour brancher les routes" }, fallback: true, stopKind: 'info', at: iso(T0 + 60000) },
    { plan: 'p', id: 'DOC', status: 'waiting', state: { why: 'attend FRONT' } },
  ];
  const loops = wake.crossWaits(sessions);
  assert.equal(loops.length, 1);
  assert.deepEqual(loops[0].loop, ['API', 'FRONT']); assert.equal(loops[0].advance, 'FRONT');
  assert.match(loops[0].why, /FRONT avance avec son repli/);
  assert.deepEqual(wake.crossWaits(sessions, [loops[0].key]), []); // seen: no second wake
  // FRONT done: no loop; a partial name does not count
  assert.deepEqual(wake.crossWaits([sessions[0], { ...sessions[1], status: 'done' }]), []);
  assert.equal(wake.waitsFor({ state: { why: 'attend API-V2' } }, { id: 'API' }), false);
});

test('PIL 3 plafond : les demandes arrivées au plafond sont gardées, rejouées une fois, la plus ancienne d’abord', () => {
  const st = { day: '2026-11-03', spent: 15 };
  assert.equal(pilot.capped(st, 15, '2026-11-03'), true);
  let held = pilot.holdRequests([], [{ key: 'main:7', at: iso(T0 + 2000) }, { key: 'main:4', at: iso(T0) }]);
  held = pilot.holdRequests(held, [{ key: 'main:7', at: iso(T0 + 2000) }]);
  assert.deepEqual(held.map((h) => h.key), ['main:4', 'main:7']);
  assert.equal(pilot.capped(st, 15, '2026-11-04'), false); // a new day
  assert.equal(pilot.capped(st, 30, '2026-11-03'), false); // the cap raised
  const d = pilot.drainHeld(held, (h) => h.key !== 'settled');
  assert.deepEqual(d.replay.map((h) => h.key), ['main:4', 'main:7']);
  assert.deepEqual(pilot.drainHeld(d.held).replay, []);
});

test('PIL 4 bilan : la part du pilote, le rapport et la ligne au-delà de 1', () => {
  const costs = [{ cost: 30, at: '2026-11-03T10:00:00Z' }, { cost: 21.6, at: '2026-11-03T20:00:00Z' }, { cost: 9, at: '2026-11-02T10:00:00Z' }];
  const pilotCost = pilotCostIn(costs, '2026-11-03T09:00:00Z', '2026-11-03T23:00:00Z');
  assert.equal(pilotCost, 51.6);
  assert.deepEqual(pilotLines({ pilotCost, cost: 24.2 }), ['Pilote : 51,60 $ ; sessions : 24,20 $ ; rapport 2,13.', 'Le pilote a coûté plus que le code qu’il pilote.']);
  assert.deepEqual(pilotLines({ pilotCost: 2, cost: 20 }), ['Pilote : 2,00 $ ; sessions : 20,00 $ ; rapport 0,1.']);
  assert.deepEqual(pilotLines({ cost: 20 }), []);
  const md = storyOf({ plan: { title: 'Harbor', sessions: [] }, metrics: { cost: 24.2, pilotCost } });
  assert.match(md, /Pilote : 51,60 \$ ; sessions : 24,20 \$/);
});

// ---------------------------------------------------------------- the watchdog (Dev, 3 November 17:35)
const rig = (over = {}) => {
  let t = T0; const woke = []; const told = []; const warned = [];
  const s = { on: true, busy: false, canWake: { ok: true }, seen: [], ...over.state };
  const reqs = over.reqs || [{ key: 'pend:fix/FIX/p1', kind: 'permission', at: iso(T0) }];
  const dog = createWatchdog({ projects: () => ['/harbor'], list: () => reqs, state: () => s, wake: (p, keys) => woke.push({ at: t, keys }), escalate: (p, rs, why) => told.push({ at: t, keys: rs.map((r) => r.key), why }), warn: (p, why) => warned.push(why), now: () => t, day: () => iso(t).slice(0, 10) });
  return { dog, s, reqs, woke, told, warned, at: (ms) => { t = T0 + ms; return dog.tick(); } };
};

test('PIL chien de garde 1 : le cas FIX, une autorisation qu’aucun réveil n’a vue, réveille le pilote au-delà de 60 s', () => {
  const r = rig();
  r.at(30000); assert.equal(r.woke.length, 0); // 30 s: too young
  r.at(61000); assert.deepEqual(r.woke.map((w) => w.keys), [['pend:fix/FIX/p1']]);
  r.at(91000); assert.equal(r.woke.length, 1); // carried once, no loop
});

test('PIL 5 chien de garde : deux réveils sans effet, le pilote est relancé et « À toi » le dit (Harbor, 16:27 → 23:20)', () => {
  const restarts = []; let t = T0; const woke = []; const told = [];
  const reqs = [{ key: 'pend:p/FIX/p1', kind: 'permission', at: iso(T0) }];
  const dog = createWatchdog({ projects: () => ['/harbor'], list: () => reqs, state: () => ({ on: true, busy: false, canWake: { ok: true }, seen: ['pend:p/FIX/p1'] }), wake: (p, k) => woke.push(t), escalate: (p, rs, why) => told.push(why), restart: (p) => restarts.push(t), now: () => t });
  const at = (ms) => { t = T0 + ms; dog.tick(); };
  at(61000); assert.equal(woke.length, 0); // seen by a wake: it waits its 3 minutes
  at(181000); assert.equal(woke.length, 1); // 3 min without an answer: a wake
  at(241000); assert.equal(woke.length, 1); // the same key: not before 3 more minutes
  at(361001); assert.equal(woke.length, 2);
  at(541002); assert.deepEqual(restarts, [T0 + 541002]); assert.deepEqual(told, ['le pilote ne répondait plus : relancé']);
  at(900000); assert.equal(restarts.length, 1); assert.equal(woke.length, 2); // told once, no loop
  // an answer resets: a new request gets its wakes again
  reqs.splice(0, 1, { key: 'pend:p/FIX/p2', kind: 'permission', at: iso(T0 + 900000) });
  at(900000 + 181000); assert.equal(woke.length, 3);
});

test('PIL 4 politique : une suggestion allow d’une politique allumée est appliquée tout de suite, le refus reste au pilote', async () => {
  const { decidePolicy } = await import('../lib/pilotpolicy.mjs');
  const requests = [
    { key: 'a', kind: 'permission', tool: 'Bash', input: { command: 'git status' }, text: 'git status', suggest: { allow: true, reason: 'lecture seule', rule: 'read-only' } },
    { key: 'b', kind: 'permission', tool: 'Bash', input: { command: 'rm -rf x' }, text: 'rm -rf x', suggest: { allow: false, reason: 'destructif' } },
    { key: 'c', kind: 'permission', tool: 'Bash', input: { command: 'git push' }, text: 'git push', suggest: { allow: true } },
    { key: 'd', kind: 'reply', suggest: { allow: true } },
  ];
  assert.deepEqual(policyAllows({ on: true, requests, decide: decidePolicy }).map((x) => x.r.key), ['a']);
  assert.deepEqual(policyAllows({ on: false, requests, decide: decidePolicy }), []);
  const plans = [{ id: 'p', sessions: [{ id: 'S' }] }];
  const got = requestsOf({ plans, rowsOf: () => [{ id: 'S', pending: [{ id: 'q1', kind: 'permission', tool: 'Bash', input: { command: 'ls' }, suggest: { allow: true }, at: iso(T0) }] }] });
  assert.deepEqual(got[0].suggest, { allow: true }); assert.equal(got[0].id, 'q1');
});

test('PIL chien de garde 1 : au plus un réveil par minute et par projet', () => {
  const reqs = [{ key: 'a', kind: 'permission', at: iso(T0) }];
  const r = rig({ reqs });
  r.at(61000); reqs.push({ key: 'b', kind: 'permission', at: iso(T0 + 1000) });
  r.at(91000); assert.equal(r.woke.length, 1); // b is due but the minute is not over
  r.at(121001); assert.deepEqual(r.woke.map((w) => w.keys), [['a'], ['b']]);
});

test('PIL chien de garde 1 : une demande « déjà vue » mais sans réponse depuis 5 min est reportée au pilote', () => {
  const r = rig({ state: { seen: ['pend:fix/FIX/p1'] } }); // the Harbor cursor: seen, never answered
  r.at(61000); assert.equal(r.woke.length, 0);
  r.at(180001); assert.equal(r.woke.length, 1);
});

test('PIL chien de garde 2 : pilote muet 5 min ou bloqué par une erreur, la demande passe à « À toi »', () => {
  const r = rig({ state: { busy: true, busySince: iso(T0) } });
  r.at(120000); assert.equal(r.told.length, 0);
  r.at(300001); assert.deepEqual(r.told, [{ at: T0 + 300001, keys: ['pend:fix/FIX/p1'], why: 'le pilote ne répond plus' }]);
  const e = rig({ state: { canWake: { ok: false, why: 'éteint par une erreur' } } });
  e.at(61000); assert.equal(e.told[0].why, 'le pilote ne peut pas se réveiller (éteint par une erreur)');
});

test('PIL chien de garde 3 : au plafond, un seul avertissement, puis le rattrapage dès le plafond relevé', () => {
  const r = rig({ state: { canWake: { ok: false, why: 'plafond du jour' } } });
  r.at(61000); r.at(91000); r.at(600000);
  assert.deepEqual(r.warned, ['le pilote a atteint son plafond']);
  assert.equal(r.told.length, 1); assert.equal(r.told[0].why, 'le pilote a atteint son plafond');
  r.s.canWake = { ok: true }; r.reqs.push({ key: 'main:12', kind: 'message', at: iso(T0 + 300000) });
  r.at(630000); assert.deepEqual(r.woke.map((w) => w.keys), [['main:12']]); // the one already told stays with Dev
});

test('PIL chien de garde 4 : l’âge de la plus vieille demande, affiché au-delà de 2 min', () => {
  const reqs = [{ at: iso(T0) }, { at: iso(T0 + 60000) }];
  assert.equal(ageLine(oldestAge(reqs, T0 + 119000)), null);
  assert.equal(ageLine(oldestAge(reqs, T0 + 16 * 60000)), 'Plus vieille demande sans réponse : 16 min');
});

test('PIL chien de garde : les demandes de tous les plans, pas des 12 derniers (la cause Harbor)', () => {
  const plans = Array.from({ length: 14 }, (_, i) => ({ id: `plan-${i}`, sessions: [{ id: 'FIX', stops: [] }] }));
  const rowsOf = (id) => (id === 'plan-13' ? [{ id: 'FIX', pending: [{ id: 'p1', kind: 'permission', at: iso(T0) }, { id: 'i1', kind: 'info' }] }] : []);
  assert.deepEqual(requestsOf({ plans, rowsOf }).map((r) => r.key), ['pend:plan-13/FIX/p1']);
  assert.equal(requestsOf({ plans: plans.slice(0, 12), rowsOf }).length, 0); // what pilotCollect read: nothing
});

test('PIL chien de garde : un plan retiré n’attend personne (QA du passage à calmdev, 1494 min le 7 novembre)', () => {
  const rowsOf = () => [{ id: 'QA', pending: [{ id: 'r1', kind: 'reply', at: iso(T0) }] }];
  const plan = (extra) => ({ id: 'p', sessions: [{ id: 'QA', stops: [] }], ...extra });
  assert.equal(requestsOf({ plans: [plan()], rowsOf }).length, 1);
  for (const closed of [{ status: 'closed' }, { closed: true }, { closedAt: iso(T0) }]) assert.equal(requestsOf({ plans: [plan(closed)], rowsOf }).length, 0, JSON.stringify(closed));
});
