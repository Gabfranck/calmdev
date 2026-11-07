// The hand-built database of the measure (docs/mesure.md): three plans whose figures are known.
// Used by test/metrics.test.mjs, and by hand for the screens (not a test):
//   ESCADRILLE_DB=$TMPDIR/m.sqlite node --no-warnings test/seed-metrics.mjs <project folder> [<other project folder>]
//   PORT=3096 ESCADRILLE_DB=$TMPDIR/m.sqlite ESCADRILLE_PLANS=$TMPDIR/m-plans node --no-warnings server.mjs
//
// alpha (project A): sessions A and B, both done and merged, 4,80 $ → 2,40 $ per merged PR; A waits at its
//   stop 0 (10:30 → 10:40, 10 min) and asks one permission (10:10 → 10:12, 2 min); running A 50 min + B 60 min.
//   Finished, unattended.
// beta (project A): session C, done, not merged, 6 $; the developer writes at 12:45 after a wait with no stop
//   (12:30, 15 min: an intervention), the cap is reached at 13:00, the server answers at 13:05 (data.auto: no
//   attention); running 30 + 15 + 30 = 75 min; one handoff, health error once. Finished, not unattended.
// gamma (project B): session D, running 14:00 → waiting 15:00, never answered. Not finished.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  create table if not exists plans (id text primary key, title text, created text, json text, project text);
  create table if not exists sessions (plan text, id text, status text, stops text, health text, why text, claude text, note text, name text, at text,
    session_id text, mode text, worktree text, usage text, pending text, handoffs text, summary text, alerted text, pushed text, primary key (plan, id));
  create table if not exists log (seq integer primary key autoincrement, plan text, session text, at text, status text, stops text, health text, why text, claude text, name text);
  create table if not exists session_messages (seq integer primary key autoincrement, plan text, session text, role text, text text, data text, at text);
`;
const T = (hm) => `2026-11-01T${hm}:00.000Z`;

export const seedMetrics = (db, { projectA, projectB }) => {
  db.exec(SCHEMA);
  const plan = (id, title, goal, project, sessions, created) => db.prepare('insert or replace into plans (id, title, created, json, project) values (?, ?, ?, ?, ?)')
    .run(id, title, created, JSON.stringify({ id, title, goal, project, created, waves: [{ n: 1, title: 'Maintenant' }], sessions: sessions.map((s) => ({ id: s, name: 'Session ' + s, wave: 1, path: project, model: 'opus', stops: ['Arrêt un', 'Arrêt deux'], prompt: 'p' })) }), project);
  const row = (p, id, status, stops, health, usage, worktree, handoffs = []) => db.prepare('insert or replace into sessions (plan, id, status, stops, health, why, claude, note, name, at, usage, worktree, pending, handoffs) values (?, ?, ?, ?, ?, \'\', \'\', \'\', ?, ?, ?, ?, \'[]\', ?)')
    .run(p, id, status, JSON.stringify(stops), health, 'Session ' + id, T('16:00'), JSON.stringify(usage), JSON.stringify(worktree), JSON.stringify(handoffs));
  const log = (p, s, hm, status, stops, health = 'ok') => db.prepare('insert into log (plan, session, at, status, stops, health, why, claude, name) values (?, ?, ?, ?, ?, ?, \'\', \'\', ?)').run(p, s, T(hm), status, JSON.stringify(stops), health, 'Session ' + s);
  const msg = (p, s, hm, role, text, data) => db.prepare('insert into session_messages (plan, session, role, text, data, at) values (?, ?, ?, ?, ?, ?)').run(p, s, role, text, data ? JSON.stringify(data) : null, T(hm));

  plan('alpha', 'Alpha : deux sessions sages', 'Deux sessions qui finissent seules.', projectA, ['A', 'B'], T('09:00'));
  row('alpha', 'A', 'done', [0, 1], 'ok', { input: 1, output: 1, cost: 3 }, { merged: true, branch: 'escadrille/alpha/A' });
  row('alpha', 'B', 'done', [0], 'ok', { input: 1, output: 1, cost: 1.8 }, { merged: true, branch: 'escadrille/alpha/B' });
  log('alpha', 'A', '10:00', 'running', []);
  log('alpha', 'B', '10:00', 'running', []);
  msg('alpha', 'A', '10:10', 'ask', 'Bash: npm test', { id: 'ask-1', tool: 'Bash' });
  msg('alpha', 'A', '10:12', 'system', 'Autorisé : Bash: npm test', { answer: 'ask-1', allow: true });
  log('alpha', 'B', '10:20', 'running', [0]); // a stop crossed while running: no interruption
  log('alpha', 'A', '10:30', 'waiting', [0]);
  msg('alpha', 'A', '10:40', 'dev', 'Validé, continue.');
  log('alpha', 'A', '10:40', 'running', [0]);
  log('alpha', 'A', '11:00', 'done', [0, 1]);
  log('alpha', 'B', '11:00', 'done', [0]);

  plan('beta', 'Beta : une session reprise à la main', 'Une session qui a eu besoin de quelqu’un.', projectA, ['C'], T('11:30'));
  row('beta', 'C', 'done', [0], 'error', { input: 1, output: 1, cost: 6 }, { merged: false, branch: 'escadrille/beta/C' }, [{ n: 1, at: T('12:50'), file: '.escadrille/passation.md' }]);
  log('beta', 'C', '12:00', 'running', []);
  log('beta', 'C', '12:30', 'waiting', []);
  msg('beta', 'C', '12:45', 'dev', 'Non, pas comme ça.');
  log('beta', 'C', '12:45', 'running', []);
  log('beta', 'C', '12:55', 'running', [], 'error');
  msg('beta', 'C', '13:00', 'system', 'Plafond de 5,00 $ atteint (6,00 $) : processus arrêté. Écris-lui pour continuer au-delà.');
  log('beta', 'C', '13:00', 'waiting', [], 'error');
  msg('beta', 'C', '13:05', 'dev', 'Continue (repli).', { auto: true });
  log('beta', 'C', '13:05', 'running', [], 'error');
  log('beta', 'C', '13:35', 'done', [0], 'error');

  plan('gamma', 'Gamma : en cours ailleurs', 'Une session qui attend encore.', projectB, ['D'], T('13:50'));
  row('gamma', 'D', 'waiting', [], 'ok', { input: 1, output: 1, cost: 0.5 }, null);
  log('gamma', 'D', '14:00', 'running', []);
  log('gamma', 'D', '15:00', 'waiting', []);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.env.ESCADRILLE_DB; const [projectA, projectB = projectA] = process.argv.slice(2);
  if (!file || !projectA) { console.log('seed-metrics: ESCADRILLE_DB=<db> node test/seed-metrics.mjs <project> [<other project>]'); process.exit(0); }
  seedMetrics(new DatabaseSync(file), { projectA, projectB });
  console.log('seeded', file);
}
