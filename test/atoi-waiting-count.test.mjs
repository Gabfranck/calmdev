// ATOI (Dev, 7 November 02:00): « 3 en cours · 6 t'attend · 4 à venir · 3 pour le pilote » while almost nothing was his.
// Every designation of the developer is counted from nextStep alone: the Flot's waitingFor, « Maintenant » (lib/status.mjs
// nowOf) and « À toi » (public/todo.js) agree on the state of that night, rebuilt here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { flowOf } from '../lib/projectflow.mjs';
import { nowOf } from '../lib/status.mjs';
const todo = createRequire(import.meta.url)('../public/todo.js');

const PROJECT = '/tmp/calmdev';
const wt = (b) => JSON.stringify({ path: '/w/' + b, branch: b, base: 'main', merged: false });
const night = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table plans (id text primary key, title text, created text, json text, project text);
    create table sessions (plan text, id text, status text, stops text, health text, why text, claude text, note text, name text, at text, session_id text, mode text, worktree text, usage text, pending text, handoffs text, summary text, alerted text, review text, primary key (plan, id));
    create table log (seq integer primary key autoincrement, plan text, session text, at text, status text, stops text, health text, why text, claude text, name text);
    create table session_messages (seq integer primary key autoincrement, plan text, session text, role text, text text, data text, at text);
    create table escadrilles (id text, weekly real, reset_at text, at text);
    create table project_settings (project text primary key, json text, at text);`);
  const plan = (id, created, sessions, extra = {}) => db.prepare('insert into plans values (?, ?, ?, ?, ?)').run(id, id, created, JSON.stringify({ id, title: id, sessions, ...extra }), PROJECT);
  const ins = db.prepare('insert into sessions (plan, id, status, stops, health, name, at, worktree, pending, summary, review) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const reply = (id, stop, text, summary) => JSON.stringify([{ id, kind: 'reply', stop, text, summary, at: '2026-11-07T00:50:00Z' }]);
  // the servers plan: A2 asks to reread server.mjs while its screen is not done; A3 finished, asks to reread its diff
  plan('2026-11-07-les-serveurs-meurent-avec-leur', '2026-11-07T00:10:00Z', [
    { id: 'A2', name: 'Le contrôle des serveurs', stops: [{ title: 'Revue', kind: 'taste' }, 'Fin'] },
    { id: 'A3', name: 'Les orphelins', stops: ['Revue du diff'] },
    { id: 'A4', name: 'Le nettoyage', stops: [] },
  ]);
  const p1 = '2026-11-07-les-serveurs-meurent-avec-leur';
  ins.run(p1, 'A2', 'waiting', '[0]', 'ok', 'A2', '2026-11-07T00:50:00Z', wt('a2'), reply('r-a2', 0, 'Relire server.mjs (fichier sous garde) et lib/sessionprocs.mjs.', 'Fait : lib/sessionprocs.mjs.\nReste : l’écran n’est pas fait.'), 'Fait : lib/sessionprocs.mjs.\nReste : l’écran n’est pas fait.', JSON.stringify({ files: ['server.mjs'], seen: false }));
  ins.run(p1, 'A3', 'waiting', '[0]', 'ok', 'A3', '2026-11-07T00:51:00Z', wt('a3'), reply('r-a3', 0, 'Relire le diff de lib/orphans.mjs.', 'Fait : tout.\nReste : rien.'), 'Fait : tout.\nReste : rien.', null);
  // a session whose process is gone: its turn ended, nothing pending, no branch
  ins.run(p1, 'A4', 'waiting', '[]', 'ok', 'A4', '2026-11-07T00:52:00Z', null, '[]', null, null);
  // the guardrail plan: B is a security decision, the developer's
  plan('2026-11-06-un-garde-fou-s-approuve-une-seule', '2026-11-06T22:00:00Z', [{ id: 'B', name: 'Revue de l’accord', stops: [{ title: 'Accord', kind: 'security' }] }]);
  ins.run('2026-11-06-un-garde-fou-s-approuve-une-seule', 'B', 'waiting', '[0]', 'ok', 'B', '2026-11-07T00:40:00Z', wt('b'), reply('r-b', 0, 'Lis le rapport : .escadrille/revue-accord.md. Faut-il lier l’accord au commit approuvé ? Recommandé : oui.', 'Reste : ta décision.'), 'Reste : ta décision.', null);
  // a retired plan whose session still says waiting: never counted
  plan('2026-11-05-retire', '2026-11-05T10:00:00Z', [{ id: 'R', name: 'Retirée', stops: [{ title: 'Goût', kind: 'taste' }] }], { closedAt: '2026-11-06T10:00:00Z' });
  ins.run('2026-11-05-retire', 'R', 'waiting', '[0]', 'ok', 'R', '2026-11-05T12:00:00Z', wt('r'), reply('r-r', 0, 'Juge l’écran ?', ''), null, null);
  return db;
};

test('ATOI: « t’attend » on the night of 7 November counts only B, from nextStep alone', () => {
  const flow = flowOf(night(), PROJECT, { pilot: true, mode: 'guide', isAncestor: () => false });
  const mine = flow.nodes.filter((n) => n.next && n.next.who === 'dev').map((n) => n.session);
  assert.deepEqual(mine, ['B'], 'nextStep: only B is the developer\'s');
  for (const n of flow.nodes) assert.equal(['dev', 'permission', 'review', 'merge'].includes(n.waitingFor), n.next.who === 'dev', `${n.session}: waitingFor follows nextStep`);
  const now = nowOf(flow.nodes, flow.plans);
  assert.equal(now.waiting, 1, '« t’attend » is 1');
  assert.equal(now.pilot, 3, 'A2, A3, A4 for the pilot');
  assert.ok(!flow.nodes.some((n) => n.plan === '2026-11-05-retire'), 'a retired plan never counts');
  const lines = todo.items({ nodes: flow.nodes, pilot: true });
  assert.deepEqual(lines.map((l) => l.s), ['B'], '« À toi »: one line');
  assert.match(lines[0].ask.q, /\?$/); assert.equal(lines[0].ask.rec, 'oui');
});
