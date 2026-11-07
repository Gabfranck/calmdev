// Seeds a running test server, already seeded by test/seed-flow.mjs, with the limits of docs/limits.md (not a test):
//   PORT=3157 ESCADRILLE_DB=.escadrille/seed/flow.sqlite ESCADRILLE_PLANS=.escadrille/seed/plans ESCADRILLE_CLAUDE=/nulle/part node --no-warnings server.mjs &
//   ESCADRILLE_DB=.escadrille/seed/flow.sqlite node --no-warnings test/seed-flow.mjs
//   ESCADRILLE_DB=.escadrille/seed/flow.sqlite PORT=3157 node --no-warnings test/seed-limits.mjs [weekly share, default 0.62]
// Writes one weekly reading as a planner would (escadrilles.weekly, reset in three days), a burst of « Carnet » running
// at 7.40 $ of 10 $, then the Mac's thresholds through the API (weekly soft 70, hard 90). The 5-hour window and Fable
// stay unmeasured, as on Dev's Mac on 1 November. Prints the two pages to look at, in both languages.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const DB = process.env.ESCADRILLE_DB; const PORT = process.env.PORT || '3157';
if (!DB) { console.log('seed-limits: set ESCADRILLE_DB to the running server database'); process.exit(0); }
const carnet = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '.escadrille', 'seed', 'Carnet');
const db = new DatabaseSync(DB);
const weekly = Number(process.argv[2] || 0.62); const iso = (ms) => new Date(ms).toISOString();
db.prepare('insert or replace into escadrilles (id, title, project, model, session_id, plan_id, status, install, usage, weekly, reset_at, created, at) values (?, ?, ?, ?, null, null, ?, null, null, ?, ?, ?, ?)')
  .run('seed-limits-reading', 'Lecture du quota', carnet, 'claude-opus-5-5', 'done', weekly, iso(Date.now() + 3 * 864e5 + 5 * 36e5), iso(Date.now() - 36e5), iso(Date.now()));
db.exec("create table if not exists bursts (id text primary key, project text, created text, status text, cap_usd real, spent_usd real default 0, until text, drain_at text, model text, tasks text, log text)");
db.prepare('insert or replace into bursts (id, project, created, status, cap_usd, spent_usd, until, drain_at, model, tasks, log) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run('burst-seed-limits', carnet, iso(Date.now() - 2 * 36e5), 'running', 10, 7.4, iso(Date.now() + 3 * 36e5), iso(Date.now() + 2.25 * 36e5), 'claude-opus-5-5', JSON.stringify([{ n: 1, text: 'Les exports CSV', status: 'running', escadrille: null, plan: null, cost: 7.4 }]), '[]');
const r = await fetch(`http://127.0.0.1:${PORT}/api/limits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'mac', limits: { weekly: { soft: 70, hard: 90 } } }) }).then((x) => x.json()).catch((e) => ({ error: e.message }));
if (r.error) console.log('seed-limits: thresholds not set,', r.error);
const enc = encodeURIComponent;
console.log(`/?project=${enc(carnet)}&lang=fr\n/?project=${enc(carnet)}&lang=en\n/?project=${enc(carnet)}&lang=fr#acces\n/?project=${enc(carnet)}&lang=en#acces`);
