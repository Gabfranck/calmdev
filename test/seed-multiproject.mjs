// Seeds a running worktree server with two projects for the phase 6 screenshots (not a test):
//   PORT=3081 ESCADRILLE_DB=$TMPDIR/d.sqlite ESCADRILLE_PLANS=$TMPDIR/plans node --no-warnings server.mjs
//   ESCADRILLE_DB=$TMPDIR/d.sqlite node --no-warnings test/seed-multiproject.mjs [http://localhost:3081]
// The projects live in .escadrille/seed/ of this worktree (never committed; /tmp is hidden from /api/projects).
// Escadrilles go straight into the database (creating one through the API starts a planner); plans go
// through POST /api/plan; one project gets a docs/decisions.md, the other none. Prints the encoded project URLs.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3081';
// node --test picks up every file in test/: without ESCADRILLE_DB this is that run, and it does nothing
const DB = process.env.ESCADRILLE_DB; if (!DB) { console.log('seed-multiproject: set ESCADRILLE_DB to the running server database'); process.exit(0); }
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '.escadrille', 'seed');
const orchard = path.join(ROOT, 'Orchard'); const acme = path.join(ROOT, 'Acme');
for (const p of [orchard, acme]) mkdirSync(p, { recursive: true });
mkdirSync(path.join(orchard, 'docs'), { recursive: true });
if (!existsSync(path.join(orchard, 'docs', 'decisions.md'))) writeFileSync(path.join(orchard, 'docs', 'decisions.md'), `# Décisions

- **2026-10-28 (09:12)** : les avatars restent en PNG 512, un fond transparent.
- **2026-10-29 (14:40)** : le simulateur iOS est la référence pour la QA, Android suit.
- **2026-10-30 (18:05)** : les sessions peuvent pousser sur \`dev\`, jamais sur \`main\`.
- **2026-10-31 (10:30)** : une PR par ticket Linear, une branche qui rassemble les Quick wins.
- **2026-11-01 (06:20)** : la passe design se lance après les avatars.
`);

const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

const db = new DatabaseSync(DB);
const esc = db.prepare('insert or replace into escadrilles (id, title, project, model, session_id, plan_id, status, install, usage, weekly, reset_at, created, at) values (?, ?, ?, ?, null, ?, ?, null, null, null, null, ?, ?)');
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const plan = (id, title, project, h) => ({ id, title, project, created: ago(h), goal: title, waves: [{ n: 1, title: 'Vague 1' }],
  sessions: ['A', 'B'].map((s) => ({ id: s, name: `${title} ${s}`, wave: 1, path: project, model: 'claude-sonnet-5-5', stops: ['Le plan', 'La PR prête'], prompt: 'Seed.' })) });
const plans = [plan('2026-10-31-avatars-studio', 'Le studio des avatars', orchard, 20), plan('2026-11-01-quick-wins', 'Quick wins de Linear', orchard, 3), plan('2026-10-30-onboarding', 'L’onboarding', acme, 40)];
for (const p of plans) { const r = await post('/api/plan', p); console.log(r.status, p.id, r.body.error || ''); }
esc.run('seed-orchard-1', 'Quick wins de Linear', orchard, 'claude-opus-5-5', '2026-11-01-quick-wins', 'planned', ago(3.2), ago(3));
esc.run('seed-orchard-2', 'Les avatars, un studio complet', orchard, 'claude-opus-5-5', '2026-10-31-avatars-studio', 'planned', ago(20.5), ago(20));
esc.run('seed-orchard-3', 'La page d’accueil élève', orchard, 'claude-sonnet-5-5', null, 'waiting', ago(1), ago(0.5));
esc.run('seed-acme-1', 'L’onboarding', acme, 'claude-sonnet-5-5', '2026-10-30-onboarding', 'planned', ago(41), ago(40));
esc.run('seed-acme-2', 'Les notifications', acme, 'claude-fable-5-1', null, 'stopped', ago(30), ago(30));
const s = await post('/api/project/settings', { project: orchard, budget: 4, model: 'claude-opus-5-5' }); console.log(s.status, 'settings', s.body.error || '');
for (const p of [orchard, acme]) console.log(`${BASE}/?project=${encodeURIComponent(p)}`);
