// The ETAs (lib/eta.mjs, docs/flot.md « Les ETA »): the spans of a session from its log rows, the medians by kind and
// model, the end of a running card, of a queued card and of a phase; nothing without history
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spansOf, historyOf, groupsOf, durationFor, etaOf, testSpansOf, MIN_GROUP } from '../lib/eta.mjs';
import { kindOf } from '../lib/learning.mjs';

const H = 3600e3; const T0 = Date.parse('2026-11-01T08:00:00Z');
const at = (h) => new Date(T0 + h * H).toISOString();

test('spansOf: the time in running is worked, the time in waiting or paused is waited apart; an open interval runs to now', () => {
  const rows = [{ at: at(0), status: 'running' }, { at: at(1), status: 'waiting' }, { at: at(1.5), status: 'running' }, { at: at(2), status: 'paused' }, { at: at(2.25), status: 'running' }, { at: at(3), status: 'done' }];
  const s = spansOf(rows, T0 + 10 * H);
  assert.equal(s.start, at(0)); assert.equal(s.end, at(3)); assert.equal(s.done, true);
  assert.equal(s.worked, 1 * H + 0.5 * H + 0.75 * H); assert.equal(s.waited, 0.5 * H + 0.25 * H);
  const open = spansOf([{ at: at(2), status: 'running' }, { at: at(0), status: 'running' }, { at: at(1), status: 'waiting' }], T0 + 3 * H); // any order
  assert.equal(open.done, false); assert.equal(open.worked, 2 * H); assert.equal(open.waited, 1 * H); assert.equal(open.end, null);
  assert.equal(spansOf([{ at: at(0), status: 'todo' }]).start, null, 'never launched');
});

test('historyOf reads the project\'s plans and their log; groupsOf takes the medians by kind and model, then by kind, then over all', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table plans (id text primary key, title text, created text, json text, project text);
    create table log (seq integer primary key autoincrement, plan text, session text, at text, status text, stops text, health text, why text, claude text, name text);`);
  const plan = { id: 'p', title: 'x', model: 'claude-opus-5-5', sessions: [{ id: 'A', name: 'L’écran du flot', wave: 1 }, { id: 'B', name: 'Le serveur et l’API', wave: 1, model: 'claude-sonnet-5-5' }, { id: 'C', name: 'La page d’accueil', wave: 1 }] };
  db.prepare('insert into plans values (?, ?, ?, ?, ?)').run('p', 'x', at(-5), JSON.stringify(plan), '/proj');
  db.prepare('insert into plans values (?, ?, ?, ?, ?)').run('o', 'other', at(-5), JSON.stringify({ id: 'o', sessions: [{ id: 'A', name: 'écran' }] }), '/other');
  const log = db.prepare('insert into log (plan, session, at, status) values (?, ?, ?, ?)');
  log.run('p', 'A', at(0), 'running'); log.run('p', 'A', at(2), 'done');
  log.run('p', 'B', at(0), 'running'); log.run('p', 'B', at(1), 'waiting'); log.run('p', 'B', at(3), 'running'); log.run('p', 'B', at(4), 'done');
  log.run('p', 'C', at(0), 'running'); // still running
  log.run('o', 'A', at(0), 'running'); log.run('o', 'A', at(9), 'done');
  const all = historyOf(db, '/proj', { now: T0 + 5 * H });
  assert.deepEqual(all.filter((x) => !x.own).map((x) => [x.plan, x.session, x.worked / H]), [['o', 'A', 9]], 'the other project comes, marked apart');
  const h = all.filter((x) => x.own);
  assert.equal(groupsOf(all).get('o:*|*').n, 1); assert.equal(groupsOf(all).get('*|*').n, 2, 'the other project never mixes into the project\'s groups');
  assert.deepEqual(h.map((x) => [x.session, x.kind, x.model, x.worked / H, x.waited / H, x.done]).sort(), [['A', 'front', 'claude-opus-5-5', 2, 0, true], ['B', 'back', 'claude-sonnet-5-5', 2, 2, true], ['C', 'front', 'claude-opus-5-5', 5, 0, false]]);
  const g = groupsOf(h);
  assert.equal(g.get('front|claude-opus-5-5').n, 1, 'C still runs: not in the medians'); assert.equal(g.get('*|*').n, 2); assert.equal(g.get('*|*').median, 2 * H);
  assert.equal(MIN_GROUP, 2);
  assert.equal(durationFor(g, 'front', 'claude-opus-5-5').basis, 'all', 'one session of the kind: the fallback is every session');
  assert.equal(durationFor(g, 'docs', null).basis, 'all'); assert.equal(durationFor(new Map(), 'front', null), null, 'no history at all');
  const g2 = groupsOf([...h, { kind: 'front', model: 'claude-opus-5-5', worked: 4 * H, done: true }, { kind: 'front', model: 'claude-fable-5-1', worked: 6 * H, done: true }]);
  assert.equal(durationFor(g2, 'front', 'claude-opus-5-5').basis, 'kind+model'); assert.equal(durationFor(g2, 'front', 'claude-opus-5-5').median, 3 * H);
  assert.equal(durationFor(g2, 'front', 'claude-haiku-5-5').basis, 'kind'); assert.equal(durationFor(g2, 'front', 'claude-haiku-5-5').median, 4 * H);
});

test('etaOf: a running card ends at its start plus its waits plus the median; a queued card after what it waits for; the phase at its farthest card', () => {
  const history = [
    { plan: 'q', session: 'X', kind: 'front', model: 'm', worked: 1 * H, waited: 0, done: true, start: at(-9) }, { plan: 'q', session: 'Y', kind: 'front', model: 'm', worked: 2 * H, waited: 0, done: true, start: at(-9) }, { plan: 'q', session: 'Z', kind: 'front', model: 'm', worked: 3 * H, waited: 0, done: true, start: at(-9) },
    { plan: 'p', session: 'A', kind: 'front', model: 'm', worked: 0.5 * H, waited: 0.5 * H, done: false, start: at(0) },
  ];
  const node = (session, status, extra = {}) => ({ id: 'p/' + session, plan: 'p', session, status, kind: 'front', model: 'm', after: [], ...extra });
  const nodes = [node('A', 'running'), node('M', 'merged'), node('K', 'later'), node('P', 'later'), node('D', 'done')];
  const edges = [{ from: 'p/A', to: 'p/K', kind: 'after' }, { from: 'p/M', to: 'p/K', kind: 'after' }, { from: 'p/K', to: 'p/P', kind: 'wave' }, { from: 'p/P', to: 'p/main', kind: 'merge' }];
  const now = T0 + 1 * H; const r = etaOf({ nodes, edges, history, now });
  // the median is 2 h (1, 2, 3), the quartiles 1,5 h and 2,5 h; A started at 08:00 and waited half an hour → 10:30
  assert.equal(r.nodes['p/A'].at, at(2.5)); assert.equal(r.nodes['p/A'].low, at(2)); assert.equal(r.nodes['p/A'].high, at(3)); assert.equal(r.nodes['p/A'].basis, 'kind+model'); assert.equal(r.nodes['p/A'].late, false);
  assert.equal(r.nodes['p/M'], null); assert.equal(r.nodes['p/D'], null, 'finished cards have no ETA');
  assert.equal(r.nodes['p/K'].at, at(4.5), 'after A (M is already merged), plus 2 h'); assert.equal(r.nodes['p/K'].low, at(3.5), 'the low path takes the low quartile twice'); assert.equal(r.nodes['p/K'].high, at(5.5));
  assert.equal(r.nodes['p/P'].at, at(6.5)); assert.equal(r.plans.p.at, at(6.5)); assert.equal(r.plans.p.low, at(5)); assert.equal(r.plans.p.high, at(8));
  // late: a running card past its median ends « now »
  const lateR = etaOf({ nodes, edges, history, now: T0 + 4 * H }); assert.equal(lateR.nodes['p/A'].late, true); assert.equal(lateR.nodes['p/A'].at, at(4));
  // a card of a kind without history, when nothing finished at all: null, and the phase too
  const none = etaOf({ nodes, edges, history: [history[3]], now }); assert.equal(none.nodes['p/A'], null); assert.equal(none.plans.p, null);
  // a queued card without dependencies starts now
  const alone = etaOf({ nodes: [node('T', 'todo')], edges: [], history, now }); assert.equal(alone.nodes['p/T'].at, at(3));
});

test('testSpansOf pairs each server test start with its end; a message without its pair counts nothing', () => {
  const m = (h, text) => ({ role: 'system', at: at(h), text });
  assert.equal(testSpansOf([m(1, 'Tests de la branche fusionnée à blanc, dans un bac à sable : npm test'), m(1.5, 'Tests : code 1\n…'), m(2, 'Tests of the branch merged dry, in a sandbox: npm test'), m(2.25, 'Tests: code 0'), m(3, 'Tests de la branche fusionnée à blanc, dans un bac à sable : x')]), 0.75 * H);
  assert.equal(testSpansOf([]), 0); assert.equal(testSpansOf([{ role: 'dev', at: at(0), text: 'Tests : code 0' }]), 0);
});

// A constructed base shaped like the Harbor day of 3 November: Harbor has no history at all, the Escadrille project has
// finished Opus sessions of the same kinds, and its integrations waited on the server's long test runs. The first Harbor
// plan (a backend chain, a dashboard after the first brick, an integration at the end) is estimated fresh, then compared
// with the durations the day really took (also constructed here: the real base is never read by a test).
test('a project without history borrows the same kind and model from the other projects; the estimate of a Harbor-like plan stays within 30 % of the real', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table plans (id text primary key, title text, created text, json text, project text);
    create table log (seq integer primary key autoincrement, plan text, session text, at text, status text, stops text, health text, why text, claude text, name text);
    create table session_messages (seq integer primary key autoincrement, plan text, session text, role text, text text, data text, at text);`);
  const OPUS = 'claude-opus-5-5';
  const BACK = 'Le serveur et l’API des avis', FRONT = 'L’écran du tableau de bord', QA = 'La vérification de l’intégration';
  // the Escadrille history, two days earlier: back 1, 1.4, 1.6, 2 h; front 1, 1.5, 2.5 h; qa 0.5, 0.5, 0.7 h worked + 0.75, 1, 1.25 h of server tests
  const past = [[BACK, 1], [BACK, 1.4], [BACK, 1.6], [BACK, 2], [FRONT, 1], [FRONT, 1.5], [FRONT, 2.5], [QA, 0.5, 0.75], [QA, 0.5, 1], [QA, 0.7, 1.25]];
  const sessions = past.map(([name], i) => ({ id: 'E' + i, name }));
  db.prepare('insert into plans values (?, ?, ?, ?, ?)').run('esc', 'escadrille', at(-60), JSON.stringify({ id: 'esc', model: OPUS, sessions }), '/tmp/x/Dev/escadrille');
  const log = db.prepare('insert into log (plan, session, at, status) values (?, ?, ?, ?)');
  const msg = db.prepare('insert into session_messages (plan, session, role, text, at) values (?, ?, ?, ?, ?)');
  past.forEach(([, worked, tests], i) => {
    const t = -48 + i * 3; log.run('esc', 'E' + i, at(t), 'running'); log.run('esc', 'E' + i, at(t + worked), 'done');
    if (tests) { msg.run('esc', 'E' + i, 'system', 'Tests de la branche fusionnée à blanc, dans un bac à sable : node --test', at(t + worked)); msg.run('esc', 'E' + i, 'system', 'Tests : code 0', at(t + worked + tests)); }
  });
  // the first Harbor plan, not launched yet: B1 → B2 → B3 → I, and G after B1, I after G too
  const plan = [['B1', BACK], ['B2', BACK], ['B3', BACK], ['G', FRONT], ['I', QA]];
  db.prepare('insert into plans values (?, ?, ?, ?, ?)').run('harbor1', 'harbor', at(-1), JSON.stringify({ id: 'harbor1', model: OPUS, sessions: plan.map(([id, name]) => ({ id, name })) }), '/tmp/x/Dev/harbor');
  const edges = [['B1', 'B2'], ['B2', 'B3'], ['B1', 'G'], ['B3', 'I'], ['G', 'I']].map(([a, b]) => ({ from: 'harbor1/' + a, to: 'harbor1/' + b, kind: 'after' }));
  const nodes = plan.map(([id, name]) => ({ id: 'harbor1/' + id, plan: 'harbor1', session: id, status: 'todo', kind: kindOf({ name }), model: OPUS }));

  const history = historyOf(db, '/tmp/x/Dev/harbor', { now: T0 });
  assert.equal(history.filter((h) => h.own).length, 0, 'Harbor has no history');
  assert.equal(history.filter((h) => h.kind === 'qa').map((h) => h.tests / H).join(), '0.75,1,1.25', 'the server\'s test runs are read');
  const groups = groupsOf(history);
  const back = durationFor(groups, 'back', OPUS); assert.deepEqual([back.basis, back.source, back.n, back.median / H], ['kind+model', 'others', 4, 1.5]);
  const qa = durationFor(groups, 'qa', OPUS); assert.equal(qa.median / H, 1.5, 'an integration counts its tests: 1.5 h, not the 0.5 h it worked');
  // before: the project's history alone, nothing to say
  const before = etaOf({ nodes, edges, history: history.filter((h) => h.own), now: T0 });
  assert.equal(before.plans.harbor1, null);
  // after: borrowed, said so
  const r = etaOf({ nodes, edges, history, now: T0 });
  const est = (Date.parse(r.plans.harbor1.at) - T0) / H;
  assert.equal(r.plans.harbor1.source, 'others'); assert.equal(r.plans.harbor1.basis, 'kind+model'); assert.equal(r.nodes['harbor1/I'].source, 'others');
  assert.equal(est, 6, 'B1 + B2 + B3 + I = 1.5 × 4 h');
  // what the day really took: B1 1.2 h, B2 1.5 h, B3 1.3 h, G 1.6 h, I 0.6 h + 1 h of tests; the longest path is B1 B2 B3 I
  const realH = Math.max(1.2 + 1.5 + 1.3 + 1.6, 1.2 + 1.6 + 1.6);
  assert.ok(Math.abs(est - realH) / realH < 0.3, `estimate ${est} h against ${realH} h real`);
});
