// Seeds a database for the guessed reply (lib/suggest.mjs; not a test). Run it before or after the server opened the file:
//   ESCADRILLE_DB=.escadrille/seed/suggest.sqlite node --no-warnings test/seed-suggest.mjs
//   PORT=3142 ESCADRILLE_DB=.escadrille/seed/suggest.sqlite ESCADRILLE_CLAUDE=/usr/bin/false node --no-warnings server.mjs
// One plan « Mots » in the project folder it prints, four sessions waiting at one stop each (no mode = 'page': the server
// resumes nothing), and Dev's past replies by kind. Prints, for each stop, the guess and its source.
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import * as suggest from '../lib/suggest.mjs';

export const PLAN = '2026-11-02-mots';
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();

export const seed = (db, project) => {
  db.exec(`
    create table if not exists plans (id text primary key, title text, created text, json text);
    create table if not exists sessions (plan text, id text, status text, stops text, health text, why text, claude text, note text, name text, at text, primary key (plan, id));
  `);
  if (!db.prepare('pragma table_info(plans)').all().some((c) => c.name === 'project')) db.exec('alter table plans add column project text');
  if (!db.prepare('pragma table_info(sessions)').all().some((c) => c.name === 'pending')) db.exec('alter table sessions add column pending text');
  suggest.schema(db);
  const sess = (id, name, stop) => ({ id, name, wave: 1, budget: 5, path: project, prompt: `Session ${id} : ${name}.`, stops: [stop] });
  const plan = { id: PLAN, title: 'Les mots de Dev', created: ago(3), goal: 'Démontrer la réponse devinée', project, waves: [{ n: 1, title: 'Maintenant' }],
    sessions: [
      sess('A', 'La revue du code', { title: 'La revue faite', kind: 'review', fallback: 'Validé, continue.' }),
      sess('B', 'La planche de design', { title: 'La planche en captures', kind: 'taste' }),
      sess('C', 'Le jeton du téléphone', { title: 'Le jeton créé', kind: 'security' }),
      sess('D', 'La migration de la base', { title: 'Le schéma migré', kind: 'data', fallback: 'Oui, fais-le.' }),
    ] };
  db.prepare('insert or replace into plans (id, title, created, json, project) values (?, ?, ?, ?, ?)').run(plan.id, plan.title, plan.created, JSON.stringify(plan), project);
  plan.sessions.forEach((s, i) => {
    const reply = { id: 'reply-seed-' + s.id, kind: 'reply', stop: 0, text: `Regarde ${s.stops[0].title}.`, summary: null, at: ago(2 - i * 0.1) };
    db.prepare("insert or replace into sessions (plan, id, status, stops, health, why, claude, note, name, at, pending) values (?, ?, 'waiting', '[0]', 'ok', '', ?, null, ?, ?, ?)").run(plan.id, s.id, reply.text, s.name, reply.at, JSON.stringify([reply]));
  });
  db.exec('delete from suggest_replies');
  const past = (kind, suggestion, sent, outcome, h) => db.prepare('insert into suggest_replies (project, plan, session, kind, suggestion, sent, outcome, at) values (?, ?, ?, ?, ?, ?, ?, ?)').run(project, 'old', 'X', kind, suggestion, sent, outcome, ago(h));
  // taste: four « refais la planche » a month ago weigh less than three « termine sur preuves » this week
  for (const h of [700, 710, 720, 730]) past('taste', null, 'Refais la planche', 'none', h);
  for (const h of [5, 30, 60]) past('taste', null, 'Termine sur preuves', 'none', h);
  past('taste', null, 'Oui fais-le', 'none', 2);
  past('taste', null, 'Voici ma réponse longue, très spécifique à cette planche-là : ' + 'x'.repeat(150), 'none', 1);
  // data: the fallback « Oui, fais-le. » corrected three times in a row to « Non, garde la base »
  for (const h of [50, 20, 3]) past('data', 'Oui, fais-le.', 'Non, garde la base', 'corrected', h);
  return plan;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const DB = process.env.ESCADRILLE_DB; if (!DB) { console.log('seed-suggest: set ESCADRILLE_DB'); process.exit(0); }
  mkdirSync(path.dirname(path.resolve(DB)), { recursive: true });
  const project = path.resolve(process.env.ESCADRILLE_SEED_ROOT || path.join(path.dirname(path.resolve(DB)), 'Mots')); mkdirSync(project, { recursive: true });
  const db = new DatabaseSync(DB); const plan = seed(db, project);
  const planOf = (id) => { const r = db.prepare('select json from plans where id = ?').get(id); return r && JSON.parse(r.json); };
  for (const s of plan.sessions) {
    const r = suggest.suggestFor(db, { project, plan: plan.id, session: s.id, planOf });
    console.log(`${s.id} · ${s.stops[0].kind.padEnd(8)} · ${r.text ? `« ${r.text} » (${r.source})` : 'rien'}`);
  }
  const m = suggest.suggestFor(db, { project, planOf });
  console.log(`fil principal · ${m.text ? `« ${m.text} » (${m.source}, arrêt de ${m.session})` : 'rien'}`);
  console.log(`projet : ${project}\nplan : /plan.html?id=${plan.id}`);
}
