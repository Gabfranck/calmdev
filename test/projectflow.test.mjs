// The project's flow (docs/projectflow.md): nodes, after and wave edges, totals, the sentence, on a fixture base
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { flowOf, storyOf as storyOfRaw } from '../lib/projectflow.mjs';
import { plain } from '../lib/i18n.mjs';
const storyOf = (...a) => plain(storyOfRaw(...a));

const PROJECT = '/tmp/projet';
const fixture = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table plans (id text primary key, title text, created text, json text, project text);
    create table sessions (plan text, id text, status text, stops text, health text, why text, claude text, note text, name text, at text, session_id text, mode text, worktree text, usage text, pending text, handoffs text, summary text, alerted text, pushed text, primary key (plan, id));
    create table log (seq integer primary key autoincrement, plan text, session text, at text, status text, stops text, health text, why text, claude text, name text);
    create table session_messages (seq integer primary key autoincrement, plan text, session text, role text, text text, data text, at text);
    create table escadrilles (id text, weekly real, reset_at text, at text);
    create table project_settings (project text primary key, json text, at text);`);
  const plan = { id: 'p7', title: 'Phase 7 : tout', sessions: [
    { id: 'A', name: 'Les connecteurs', wave: 1, model: 'claude-opus-5-5', budget: 8, stops: ['contrat', 'tests', 'PR'] },
    { id: 'C', name: 'La robustesse', wave: 1, stops: ['un', 'deux'] },
    { id: 'R', name: 'La revue', wave: 1, budget: 6, stops: ['un'] },
    { id: 'Q', name: 'Les règles', wave: 1 },
    { id: 'K', name: 'La rafale', wave: 2, after: ['A', 'C', 'R'] },
    { id: 'P', name: 'La passe design', wave: 3 },
  ] };
  db.prepare('insert into plans values (?, ?, ?, ?, ?)').run(plan.id, plan.title, '2026-11-01T07:00:00Z', JSON.stringify(plan), PROJECT);
  const old = { id: 'p6', title: 'Phase 6', sessions: [{ id: 'A', name: 'Fini', wave: 1 }] };
  db.prepare('insert into plans values (?, ?, ?, ?, ?)').run(old.id, old.title, '2026-11-01T05:00:00Z', JSON.stringify(old), PROJECT);
  const ins = db.prepare('insert into sessions (plan, id, status, stops, health, claude, name, at, worktree, usage, pending, summary) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  ins.run('p7', 'A', 'running', '[0]', 'ok', 'Regarde le contrat', 'Les connecteurs', '2026-11-01T08:00:00Z', '{"merged":false}', '{"cost":1.5,"context":0.2}', '[]', 'Fait : le contrat\nReste : les tests');
  ins.run('p7', 'C', 'done', '[0,1]', 'ok', 'Fusionnée', 'La robustesse', '2026-11-01T08:00:00Z', '{"merged":true}', '{"cost":2}', '[]', null);
  ins.run('p7', 'R', 'done', '[0]', 'ok', 'Relis la PR', 'La revue', '2026-11-01T08:00:00Z', '{"merged":false}', '{"cost":3}', '[]', null);
  ins.run('p7', 'Q', 'waiting', '[]', 'ok', 'Une question', 'Les règles', '2026-11-01T08:00:00Z', '{"merged":false}', '{"cost":0.5}', '[{"id":"x","kind":"permission","text":"Bash"}]', null);
  ins.run('p7', 'K', 'later', '[]', 'ok', '', 'La rafale', '2026-11-01T07:00:00Z', null, null, '[]', null);
  ins.run('p7', 'P', 'later', '[]', 'ok', '', 'La passe design', '2026-11-01T07:00:00Z', null, null, '[]', null);
  ins.run('p6', 'A', 'done', '[]', 'ok', '', 'Fini', '2026-11-01T06:00:00Z', '{"merged":true}', '{"cost":4}', '[]', null);
  db.prepare("insert into log (plan, session, at, status) values ('p7', 'A', '2026-11-01T07:30:00Z', 'running')").run();
  db.prepare("insert into session_messages (plan, session, role, text, at) values ('p7', 'A', 'activity', 'lit lib/github.mjs', '2026-11-01T08:05:00Z')").run();
  db.prepare("insert into escadrilles values ('e', 0.59, null, '2026-11-01T08:00:00Z')").run();
  return db;
};

test('nodes: status, waiting, cost, stops, now', () => {
  const f = flowOf(fixture(), PROJECT, { calibration: { calibrated: true, dollarsPerPct: 1 } });
  const n = Object.fromEntries(f.nodes.map((x) => [x.session, x]));
  assert.equal(f.nodes.length, 6); assert.equal(f.finished, 1, 'the merged plan is counted, not shown');
  assert.equal(n.A.id, 'p7/A'); assert.equal(n.A.status, 'running'); assert.equal(n.A.waitingFor, null);
  assert.equal(n.A.now, 'lit lib/github.mjs', 'a running session shows its newer activity');
  assert.equal(n.A.cost, 1.5); assert.equal(n.A.budget, 8); assert.equal(n.A.contextPct, 0.2);
  assert.equal(n.A.stopsDone, 1); assert.equal(n.A.stopsTotal, 3); assert.equal(n.A.startedAt, '2026-11-01T07:30:00Z');
  assert.equal(n.C.status, 'merged'); assert.equal(n.R.status, 'done'); assert.equal(n.R.waitingFor, 'merge', 'a finished branch waits for the developer\'s merge (Dev, 2026-11-02)'); assert.equal(n.R.verb, 'merge');
  assert.equal(n.Q.verb, 'allow'); assert.equal(n.A.verb, null);
  assert.equal(n.Q.waitingFor, 'permission'); assert.equal(n.Q.budget, 5, 'the default budget');
  assert.equal(n.K.status, 'later'); assert.equal(n.K.cost, 0);
});

test('edges: after, wave and the merge into main', () => {
  const f = flowOf(fixture(), PROJECT);
  const has = (from, to, kind) => f.edges.some((e) => e.from === from && e.to === to && e.kind === kind);
  for (const a of ['A', 'C', 'R']) assert.ok(has(`p7/${a}`, 'p7/K', 'after'), a + ' → K');
  assert.ok(!has('p7/Q', 'p7/K', 'wave'), 'after replaces the wave');
  assert.ok(has('p7/K', 'p7/P', 'wave'), 'P waits for the whole wave 2');
  assert.ok(has('p7/P', 'p7/main', 'merge')); assert.ok(has('p7/Q', 'p7/main', 'merge'), 'a session without successor ends in main');
  assert.equal(f.edges.find((e) => e.from === 'p7/C').met, true); assert.equal(f.edges.find((e) => e.from === 'p7/A').met, false);
  assert.deepEqual(f.nodes.find((n) => n.session === 'K').after, ['A', 'C', 'R']);
});

test('totals and plans', () => {
  const f = flowOf(fixture(), PROJECT, { calibration: { calibrated: true, dollarsPerPct: 1 } });
  assert.deepEqual(f.plans.map((p) => p.id), ['p7']);
  assert.deepEqual(f.plans[0].main, { merged: 1, total: 6 }); assert.equal(f.plans[0].status, 'running');
  assert.equal(f.totals.running, 1); assert.equal(f.totals.waiting, 2, 'Q waits, R is to review'); assert.equal(f.totals.mine, 2);
  assert.equal(f.totals.cost, 7); assert.equal(f.totals.budget, 8 + 5 + 6 + 5 + 5 + 5);
  assert.equal(f.totals.weeklyNow, 0.59);
  // left at the ceiling: A 8 - 1.5, Q 5 - 0.5, K 5, P 5 = 21 $ → 21 % at 1 $ per %
  assert.equal(f.totals.weeklyAfter, 0.8);
  assert.equal(flowOf(fixture(), PROJECT).totals.weeklyAfter, null, 'no calibration, no projection');
  assert.equal(flowOf(fixture(), PROJECT, { all: true }).plans.length, 2);
});

test('the sentence', () => {
  const f = flowOf(fixture(), PROJECT);
  assert.equal(plain(f.story), 'Q demande une autorisation · R attend ta fusion.', 'two groups at most, the most urgent first');
  assert.equal(plain(f.storyFull), 'Q demande une autorisation, R attend ta fusion, A code, K partira après A et R, puis 1 autre.');
  const node = (session, status, extra = {}) => ({ id: 'p/' + session, plan: 'p', session, status, wave: 1, waitingFor: null, ...extra });
  const plans = [{ id: 'p', title: 'Phase 7' }];
  assert.equal(storyOf({ plans, nodes: [node('A', 'running'), node('C', 'running')], edges: [] }), 'A et C codent.');
  assert.equal(storyOf({ plans, nodes: 'ABCDE'.split('').map((s) => node(s, 'running')), edges: [] }), '5 sessions codent.');
  assert.equal(storyOf({ plans, nodes: [node('A', 'running'), node('K', 'later', { wave: 2 })], edges: [{ from: 'p/A', to: 'p/K', kind: 'after' }] }), 'A code, K partira après A.');
  assert.equal(storyOf({ plans, nodes: [node('A', 'error', { waitingFor: 'dev' }), node('B', 'error')], edges: [] }), 'A attend ta réponse, B est en erreur.', 'a session is told once');
  assert.equal(storyOf({ plans, nodes: [node('A', 'todo'), node('B', 'todo')], edges: [] }), '2 à lancer.');
  assert.equal(storyOf({ plans, nodes: [node('A', 'merged')], edges: [] }), 'Tout est fusionné.');
  assert.equal(storyOf({ plans: [], nodes: [], edges: [] }), 'Rien en cours ni à venir.');
  const two = [{ id: 'p', title: 'Phase 7 : x' }, { id: 'q', title: 'R02 · Évaluations' }];
  assert.equal(storyOf({ plans: two, nodes: [node('A', 'running'), node('C', 'running'), { ...node('A', 'running'), id: 'q/A', plan: 'q' }], edges: [] }), 'A, C (Phase 7) et A (R02) codent.');
  assert.equal(storyOf({ plans: two, nodes: [node('A', 'running'), { ...node('B', 'waiting', { waitingFor: 'dev' }), id: 'q/B', plan: 'q' }], edges: [] }, { max: 2, sep: ' · ' }), 'B (R02) attend ta réponse · A (Phase 7) code.');
});

test('review: strict, autoMerge, kit; a finished plan folds', () => {
  const db = fixture();
  const set = (patch) => { const p = JSON.parse(db.prepare("select json from plans where id = 'p7'").get().json); db.prepare("update plans set json = ? where id = 'p7'").run(JSON.stringify({ ...p, ...patch })); };
  const R = () => flowOf(db, PROJECT).nodes.find((n) => n.session === 'R').waitingFor;
  assert.equal(R(), 'merge', 'a plan merged by hand: the developer\'s merge');
  set({ autoMerge: true }); assert.equal(R(), null, 'autoMerge: the merge follows done');
  db.prepare("insert into project_settings values (?, ?, '')").run(PROJECT, JSON.stringify({ review: 'strict' })); assert.equal(R(), 'review', 'a strict project reviews everything');
  assert.equal(flowOf(db, PROJECT, { pilot: true }).nodes.find((n) => n.session === 'R').waitingFor, 'pilot', 'a strict review goes to a pilot when one is present');
  db.prepare('delete from project_settings').run(); set({ autoMerge: false, kit: true }); assert.equal(R(), null, 'a kit is delivered without a merge');
  set({ kit: false }); assert.equal(flowOf(db, PROJECT, { pilot: true }).nodes.find((n) => n.session === 'R').waitingFor, 'merge', 'a merge is never the pilot\'s: nothing is merged without the developer\'s click');
  set({ kit: true });
  set({ kit: false });
  db.prepare("update sessions set status = 'done' where plan = 'p7'").run();
  const f = flowOf(db, PROJECT);
  assert.equal(f.plans.length, 0); assert.equal(f.nodes.length, 0); assert.equal(f.totals.mine, 0);
  assert.deepEqual(f.folded.map((p) => [p.id, p.sessions]), [['p7', 6], ['p6', 1]]);
  assert.equal(plain(f.story), 'Rien en cours ni à venir.');
});

test('the most active plan comes first', () => {
  const db = fixture();
  const q = { id: 'q', title: 'Quiet', sessions: [{ id: 'A', name: 'x', wave: 1 }] };
  db.prepare('insert into plans values (?, ?, ?, ?, ?)').run('q', 'Quiet', '2026-11-01T09:00:00Z', JSON.stringify(q), PROJECT);
  db.prepare("insert into sessions (plan, id, status, stops, health, pending) values ('q', 'A', 'todo', '[]', 'ok', '[]')").run();
  assert.deepEqual(flowOf(db, PROJECT).plans.map((p) => p.id), ['p7', 'q']);
});

test('a merged session waits for nothing, even with a reply left pending (PX, 2026-11-02)', () => {
  const db = fixture();
  db.prepare("update sessions set pending = ? where plan = 'p7' and id = 'C'").run(JSON.stringify([{ id: 'r', kind: 'reply', text: 'Regarde la planche' }]));
  const f = flowOf(db, PROJECT); const C = f.nodes.find((n) => n.session === 'C');
  assert.equal(C.status, 'merged'); assert.equal(C.waitingFor, null); assert.equal(C.verb, null);
  assert.ok(!plain(f.storyFull).includes('C attend'), 'the sentence never names a merged session: ' + plain(f.storyFull));
  assert.equal(f.totals.mine, 2, 'Q and R, not C');
});

test('the verb of « À toi »: a human stop is judged, a reply answered, a permission allowed, a branch merged', () => {
  const db = fixture();
  const set = (patch) => { const p = JSON.parse(db.prepare("select json from plans where id = 'p7'").get().json); db.prepare("update plans set json = ? where id = 'p7'").run(JSON.stringify({ ...p, ...patch })); };
  db.prepare("update sessions set status = 'waiting', summary = 'Fait : tout\nReste : rien', pending = ? where plan = 'p7' and id = 'A'").run(JSON.stringify([{ id: 'r', kind: 'reply', stop: 0, text: 'CAPTURE: x' }]));
  let A = flowOf(db, PROJECT).nodes.find((n) => n.session === 'A'); assert.equal(A.waitingFor, 'dev'); assert.equal(A.verb, 'reply');
  const p = JSON.parse(db.prepare("select json from plans where id = 'p7'").get().json); p.sessions[0].stops = [{ title: 'La planche', kind: 'taste' }]; set(p); // its last stop (ATOI: a taste with stops ahead goes on)
  A = flowOf(db, PROJECT, { pilot: true }).nodes.find((n) => n.session === 'A'); assert.equal(A.waitingFor, 'dev', 'a taste stop stays the developer\'s with a pilot'); assert.equal(A.verb, 'judge'); assert.equal(A.human, true);
});

test('the end node of a plan: the next plan by date, waiting for the click once everything is merged; next field; nothing', () => {
  const db = fixture();
  const set = (id, patch) => { const p = JSON.parse(db.prepare('select json from plans where id = ?').get(id).json); db.prepare('update plans set json = ? where id = ?').run(JSON.stringify({ ...p, ...patch }), id); };
  // p6 (older, merged) chains into p7 (running): its end node names p7, not launchable (p7 has left)
  let f = flowOf(db, PROJECT, { all: true }); const end = (id) => f.ends.find((e) => e.plan === id);
  assert.equal(end('p6').kind, 'next'); assert.equal(end('p6').next.id, 'p7'); assert.equal(end('p6').next.title, 'Phase 7 : tout'); assert.equal(end('p6').ready, true); assert.equal(end('p6').next.status, 'running'); assert.equal(end('p6').waitingFor, null);
  assert.equal(end('p7').kind, 'none', 'the newest plan has nothing after it'); assert.equal(end('p7').id, 'p7/main'); assert.equal(end('p7').open, 2, 'Q and R are the developer\'s');
  assert.deepEqual(f.plans.map((p) => p.end), ['p7', 'p6'].map((id) => id + '/main').filter((x) => f.plans.some((p) => p.end === x)));
  // a plan to launch after p7: p7's end node names it; once p7 is merged whole, it waits for the click
  const q = { id: 'q', title: 'Phase 8 : la suite', sessions: [{ id: 'A', name: 'x', wave: 1 }] };
  db.prepare('insert into plans values (?, ?, ?, ?, ?)').run('q', q.title, '2026-11-01T09:00:00Z', JSON.stringify(q), PROJECT);
  db.prepare("insert into sessions (plan, id, status, stops, health, pending) values ('q', 'A', 'todo', '[]', 'ok', '[]')").run();
  f = flowOf(db, PROJECT); assert.equal(end('p7').next.id, 'q'); assert.equal(end('p7').waitingFor, null, 'p7 is not merged whole');
  db.prepare("update sessions set status = 'done', worktree = '{\"merged\":true}', pending = '[]' where plan = 'p7'").run();
  f = flowOf(db, PROJECT); assert.equal(end('p7').ready, true); assert.equal(end('p7').waitingFor, 'dev'); assert.equal(end('p7').verb, 'launch');
  assert.ok(f.plans.some((p) => p.id === 'p7'), 'a plan merged whole stays on the canvas while its next plan waits for the click'); assert.ok(!f.folded.some((p) => p.id === 'p7'));
  assert.ok(f.folded.some((p) => p.id === 'p6'), 'p6, whose next plan has left, folds');
  assert.ok(plain(f.storyFull).includes('Phase 8 attend ton clic'), plain(f.storyFull)); assert.equal(f.totals.mine, 1, 'the click counts as a gesture of the developer');
  f = flowOf(db, PROJECT, { pilot: true }); assert.equal(end('p7').waitingFor, 'dev', 'a pilot never launches a plan');
  // the next field: a plan id, or judge, qa, none
  set('p7', { next: 'p6' }); f = flowOf(db, PROJECT, { all: true }); assert.equal(end('p7').next.id, 'p6'); assert.equal(end('p7').waitingFor, null, 'p6 is already merged');
  set('p7', { next: 'judge' }); f = flowOf(db, PROJECT, { all: true }); assert.equal(end('p7').kind, 'judge'); assert.equal(end('p7').next, null);
  set('p7', { next: 'qa' }); f = flowOf(db, PROJECT, { all: true }); assert.equal(end('p7').kind, 'qa');
  set('p7', { next: 'none' }); f = flowOf(db, PROJECT, { all: true }); assert.equal(end('p7').kind, 'none'); assert.equal(end('p7').waitingFor, null);
  set('p7', { next: 'nowhere' }); f = flowOf(db, PROJECT, { all: true }); assert.equal(end('p7').kind, 'none', 'an unknown plan id: nothing');
});

test('the ETAs come from the log: a running card, a queued card, the phase; nothing without history', () => {
  const db = fixture();
  let f = flowOf(db, PROJECT); assert.equal(f.nodes.find((n) => n.session === 'A').eta, null, 'no finished session in the log: no ETA'); assert.equal(f.plans[0].eta, null);
  // two finished sessions of the same kind worked 60 and 90 minutes (the log holds their running and done lines)
  const log = db.prepare("insert into log (plan, session, at, status) values (?, ?, ?, ?)");
  log.run('p6', 'A', '2026-11-01T05:00:00Z', 'running'); log.run('p6', 'A', '2026-11-01T06:00:00Z', 'done');
  log.run('p7', 'C', '2026-11-01T06:00:00Z', 'running'); log.run('p7', 'C', '2026-11-01T06:30:00Z', 'waiting'); log.run('p7', 'C', '2026-11-01T07:30:00Z', 'running'); log.run('p7', 'C', '2026-11-01T08:30:00Z', 'done');
  const now = Date.parse('2026-11-01T08:00:00Z');
  f = flowOf(db, PROJECT, { now }); const n = Object.fromEntries(f.nodes.map((x) => [x.session, x]));
  // the median worked time is 75 min (60 and 90; C's hour of waiting is not counted); A started at 07:30 → 08:45
  assert.equal(n.A.eta.at, '2026-11-01T08:45:00.000Z'); assert.equal(n.A.eta.low, '2026-11-01T08:37:30.000Z'); assert.equal(n.A.eta.high, '2026-11-01T08:52:30.000Z'); assert.equal(n.A.eta.late, false);
  assert.equal(n.C.eta, null, 'a merged card has no end to estimate'); assert.equal(n.R.eta, null, 'a finished card neither');
  // K waits for A, C and R: after A's end, plus its own median → 10:00; P after K → 11:15; the phase ends with P
  assert.equal(n.K.eta.at, '2026-11-01T10:00:00.000Z'); assert.equal(n.P.eta.at, '2026-11-01T11:15:00.000Z');
  assert.equal(f.plans[0].eta.at, '2026-11-01T11:15:00.000Z'); assert.equal(f.ends.find((e) => e.plan === 'p7').eta.at, '2026-11-01T11:15:00.000Z');
  // past its median, a running card is late and its ETA is now
  const late = flowOf(db, PROJECT, { now: Date.parse('2026-11-01T09:30:00Z') }).nodes.find((x) => x.session === 'A').eta; assert.equal(late.late, true); assert.equal(late.at, '2026-11-01T09:30:00.000Z');
});
