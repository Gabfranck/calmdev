// Test data for the phone app: a throwaway database and plans folder for server.mjs, holding the real
// phase 5 plan with made-up states (a permission, a reply, an alert, an info), a chat and a journal.
//   node phone/dev/seed.mjs <dir>     then   ESCADRILLE_DB=<dir>/db.sqlite ESCADRILLE_PLANS=<dir>/plans PORT=3191 node server.mjs
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('usage: node phone/dev/seed.mjs <dir>'); process.exit(1); }
const root = path.resolve(import.meta.dirname, '..', '..');
rmSync(dir, { recursive: true, force: true });
mkdirSync(path.join(dir, 'plans'), { recursive: true });
const PLAN = '2026-11-01-phase-5-le-telephone-en-trois';
copyFileSync(path.join(root, 'plans', PLAN + '.json'), path.join(dir, 'plans', PLAN + '.json'));
copyFileSync(path.join(root, 'plans', 'exemple.json'), path.join(dir, 'plans', 'exemple.json'));

const db = new DatabaseSync(path.join(dir, 'db.sqlite'));
db.exec(`
  create table plans (id text primary key, title text, created text, json text);
  create table sessions (plan text, id text, status text, stops text, health text, why text, claude text, note text, name text, at text,
    session_id text, mode text, worktree text, usage text, pending text, handoffs text, summary text, alerted text, primary key (plan, id));
  create table log (seq integer primary key autoincrement, plan text, session text, at text, status text, stops text, health text, why text, claude text, name text);
  create table session_messages (seq integer primary key autoincrement, plan text, session text, role text, text text, data text, at text);
`);

const t0 = Date.now() - 95 * 60e3;
const at = (min) => new Date(t0 + min * 60e3).toISOString();
const row = (id, name, f) => db.prepare(`insert into sessions (plan, id, status, stops, health, why, claude, note, name, at, session_id, mode, worktree, usage, pending, handoffs, summary, alerted)
  values (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, null, null, ?, ?, '[]', ?, '[]')`)
  .run(PLAN, id, f.status, JSON.stringify(f.stops), f.health || 'ok', f.why || '', f.claude || '', name, f.at, f.sid || null, JSON.stringify(f.usage || null), JSON.stringify(f.pending || []), f.summary || null);

row('A', 'Le serveur : garde LAN, appairage, notifications Expo', {
  status: 'running', stops: [0, 1], at: at(88), sid: 'sess-a1', usage: { input: 812000, output: 21400, cost: 2.41, weekly: 0.031, context: 0.47 },
  claude: 'Regarde lib/phone.mjs : l’appairage par code et les jetons',
  pending: [{ id: 'p1', kind: 'permission', tool: 'Bash', input: { command: 'curl -s https://exp.host/--/api/v2/push/send' }, text: 'Bash : curl -s https://exp.host/--/api/v2/push/send', network: true, at: at(93) }],
});
row('B', 'L’app Expo : appairage, flot, À faire, sessions, journal, notifications', {
  status: 'waiting', stops: [0], at: at(80), sid: 'sess-b1', usage: { input: 640000, output: 18200, cost: 1.92, weekly: 0.024, context: 0.62 },
  claude: 'Regarde docs/phase5-phone-appairage.jpg', summary: 'Fait : phone/ créé, l’écran d’appairage à 390 px.\nReste : À faire et le flot, les sessions, les notifications.',
  pending: [
    { id: 'r1', kind: 'reply', stop: 0, text: 'Regarde docs/phase5-phone-appairage.jpg', summary: 'Fait : phone/ créé, l’écran d’appairage à 390 px.\nReste : À faire et le flot, les sessions, les notifications.', at: at(80) },
    { id: 'a1', kind: 'alert', what: 'context', pct: 0.62, text: 'Contexte : 62 % de la fenêtre', at: at(80) },
  ],
});
row('C', 'La fusion, l’essai de bout en bout et les docs', { status: 'later', stops: [], at: at(0) });

const log = (min, s, status, stops, claude, health = 'ok', why = '') => db.prepare('insert into log (plan, session, at, status, stops, health, why, claude, name) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(PLAN, s, at(min), status, JSON.stringify(stops), health, why, claude, '');
log(2, 'A', 'running', [], 'Lancée dans …/.claude/worktrees/' + PLAN + '-A');
log(2, 'B', 'running', [], 'Lancée dans …/.claude/worktrees/' + PLAN + '-B');
log(31, 'A', 'waiting', [0], 'Regarde lib/phone.mjs : la garde LAN et ses tests');
log(36, 'A', 'running', [0], 'Je passe à l’appairage');
log(61, 'A', 'waiting', [0, 1], 'Regarde test/phone.test.mjs : 14 tests verts');
log(66, 'A', 'running', [0, 1], 'Les notifications Expo');
log(80, 'B', 'waiting', [0], 'Regarde docs/phase5-phone-appairage.jpg');

const msg = (s, min, role, text, data = null) => db.prepare('insert into session_messages (plan, session, role, text, data, at) values (?, ?, ?, ?, ?, ?)').run(PLAN, s, role, text, data && JSON.stringify(data), at(min));
const state = (o) => '\n\n```escadrille:state\n' + JSON.stringify(o) + '\n```';
msg('B', 2, 'system', 'Session lancée dans son worktree, branche escadrille/' + PLAN + '/B.');
msg('B', 3, 'activity', 'Read README.md · Read ROADMAP.md · Grep todo public/plan.html');
msg('B', 12, 'ask', 'Bash : npx create-expo-app@latest phone --template blank-typescript');
msg('B', 13, 'dev', 'Autorisé');
msg('B', 40, 'activity', 'Write phone/src/screens/Pair.tsx · Write phone/src/api.ts');
msg('B', 80, 'claude', 'L’arrêt 1 est franchi : **phone/** est créé (Expo SDK 58), l’écran d’appairage est rendu à 390 px en clair et en sombre.\n\nLe bac à sable n’a que Node 14 ; Node 22 vient de nvm.' + state({ stops: [0], health: 'ok', why: '', claude: 'Regarde docs/phase5-phone-appairage.jpg', done: false }));
msg('A', 2, 'system', 'Session lancée dans son worktree, branche escadrille/' + PLAN + '/A.');
msg('A', 31, 'claude', 'La garde LAN est en place : hors du Mac, chaque route demande un jeton.' + state({ stops: [0], health: 'ok', why: '', claude: 'Regarde lib/phone.mjs : la garde LAN et ses tests', done: false }));
msg('A', 35, 'dev', 'Ok, continue.');
msg('A', 61, 'claude', 'L’appairage par code marche : 6 chiffres, 5 minutes, un jeton de 90 jours.' + state({ stops: [0, 1], health: 'ok', why: '', claude: 'Regarde test/phone.test.mjs : 14 tests verts', done: false }));
msg('A', 65, 'dev', 'Vu, passe aux notifications.');
msg('A', 93, 'ask', 'Bash : curl -s https://exp.host/--/api/v2/push/send');
console.log('seeded', dir);
