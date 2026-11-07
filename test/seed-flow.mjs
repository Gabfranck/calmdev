// Seeds a running test server with a rich project for the Flot and the plan screens (phase 9, P2 ; not a test):
//   PORT=3142 ESCADRILLE_DB=.escadrille/seed/flow.sqlite ESCADRILLE_PLANS=.escadrille/seed/plans node --no-warnings server.mjs &
//   ESCADRILLE_DB=.escadrille/seed/flow.sqlite node --no-warnings test/seed-flow.mjs
// Writes straight into the database the server opened (its schema), never a copy of sessions.sqlite. No session has
// mode = 'page', so the server resumes nothing. The project « Carnet » gets a plan of 13 sessions over 7 waves in every
// state, a plan of 3 in flight, a plan of 3 to launch and two finished plans; « Vide » has nothing. Prints the URLs.
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const DB = process.env.ESCADRILLE_DB; if (!DB) { console.log('seed-flow: set ESCADRILLE_DB to the running server database'); process.exit(0); }
const ROOT = process.env.ESCADRILLE_SEED_ROOT ? path.resolve(process.env.ESCADRILLE_SEED_ROOT) : path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '.escadrille', 'seed'); // the click robot gives its own
const carnet = path.join(ROOT, 'Carnet'); const vide = path.join(ROOT, 'Vide');
for (const p of [carnet, vide]) mkdirSync(p, { recursive: true });
const db = new DatabaseSync(DB);
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const sess = (id, name, wave, budget, model, after, stops) => ({ id, name, wave, budget, model, after, stops, path: carnet, prompt: `Session ${id} : ${name}.` });
const OPUS = 'claude-opus-5-5', FABLE = 'claude-fable-5-1', SONNET = 'claude-sonnet-5-5';

const plans = [
  { id: '2026-11-01-phase-9', title: 'Phase 9 : lançable et wahou, sans limite', created: ago(5), goal: 'Le lancement', project: carnet, model: OPUS,
    waves: [{ n: 1, title: 'Direction' }, { n: 2, title: 'La barre' }, { n: 3, title: "L'accueil" }, { n: 4, title: 'Les passes' }, { n: 5, title: 'Vérification' }, { n: 6, title: 'Lancement' }, { n: 7, title: 'Vidéo' }],
    sessions: [
      sess('D', "La direction, l'app et le lancement", 1, 30, FABLE, undefined, ['La direction et les maquettes', 'Le jugement de Dev']),
      sess('K', "Lançable : l'installation, le README, les chiffres", 1, 15, OPUS, undefined, ['Le README', 'Un clone neuf installé']),
      sess('A', 'La barre latérale unique', 2, 25, FABLE, ['D'], ['La barre sur 7 pages', 'Planche avant/après']),
      sess('B', "L'accueil qui ouvre sur la Conversation", 3, 20, FABLE, ['A'], ['Les trois états en capture']),
      sess('P1', 'La passe Conversation, Ressources, panneau d’état', 4, 20, OPUS, ['B'], ['Le panneau aux quatre blocs', 'Captures 1440 et 390']),
      sess('P2', 'La passe Flot et plan, le canevas', 4, 20, FABLE, ['B'], ['Planche avant/après à 1440 et 390']),
      sess('P3', 'La passe Revue, Architecture, Accès, Rafale, Pilote', 4, 20, OPUS, ['B'], ['Titres et actions', 'Captures par écran']),
      sess('C', 'La vérification sur captures', 5, 15, FABLE, ['P1', 'P2', 'P3'], ['La planche de toutes les pages']),
      sess('E', 'La dernière passe de l’accueil', 6, 12, FABLE, ['C'], ['Les trois états']),
      sess('L', 'La landing avec les vraies captures', 6, 25, FABLE, ['C'], ['Le premier écran', 'Les quatre captures', 'Install']),
      sess('Q', 'Le plan de QA de fin de run', 6, 8, SONNET, ['C'], ['Le plan de QA']),
      sess('V', 'La vidéo de démo, 30 s', 7, 20, OPUS, ['L'], ['Les sept plans']),
      sess('M', 'La comm : kit de publication', 7, 10, FABLE, ['E', 'Q'], ['comm/PUBLIER.md']),
    ] },
  { id: '2026-11-01-export-csv', title: "L'export CSV des scores", created: ago(1.5), goal: 'Exporter les scores en CSV', project: carnet, model: SONNET,
    waves: [{ n: 1, title: 'Maintenant' }],
    sessions: [sess('A', 'Le point d’API /api/scores.csv', 1, 4, SONNET, undefined, ['Le test vert']), sess('B', 'Le bouton Exporter dans la page', 1, 3, SONNET, undefined, ['La capture']), sess('C', 'La doc et le changelog', 1, 2, SONNET, undefined, ['CHANGELOG'])] },
  { id: '2026-11-01-notifications', title: 'Les notifications de match', created: ago(0.5), goal: 'Prévenir avant un match', project: carnet, model: SONNET,
    waves: [{ n: 1, title: 'Maintenant' }, { n: 2, title: 'Ensuite' }],
    sessions: [sess('A', 'Le service push', 1, 5, SONNET, undefined, ['Le contrat']), sess('B', 'Le réglage par joueur', 1, 4, SONNET, undefined, ['L’écran']), sess('C', 'Le test de bout en bout', 2, 3, SONNET, ['A', 'B'], ['Le journal'])] },
  // merged whole, and its `next` (phase 13 FL) names a plan not launched: its end node waits for the click, it stays on the canvas
  { id: '2026-10-31-qa-semaine', title: 'Le guide de QA de la semaine', created: ago(30), goal: 'QA', project: carnet, model: SONNET, waves: [{ n: 1, title: 'Maintenant' }], next: '2026-11-01-notifications',
    sessions: ['A', 'B', 'C', 'D'].map((s) => sess(s, `QA ${s}`, 1, 3, SONNET, undefined, ['Fait'])) },
  { id: '2026-10-30-phase-8', title: 'Phase 8 : tout part du chat', created: ago(48), goal: 'Le chat', project: carnet, model: OPUS, waves: [{ n: 1, title: 'Maintenant' }],
    sessions: ['A', 'B', 'C', 'D', 'E'].map((s) => sess(s, `Phase 8 ${s}`, 1, 6, OPUS, undefined, ['Fait'])) },
];
const up = db.prepare('insert or replace into plans (id, title, created, json, project) values (?, ?, ?, ?, ?)');
for (const p of plans) up.run(p.id, p.title, p.created, JSON.stringify(p), carnet);

db.prepare('delete from sessions where plan in (' + plans.map(() => '?').join(',') + ')').run(...plans.map((p) => p.id));
db.prepare('delete from log where plan in (' + plans.map(() => '?').join(',') + ')').run(...plans.map((p) => p.id));
db.prepare('delete from session_messages where plan in (' + plans.map(() => '?').join(',') + ')').run(...plans.map((p) => p.id));
const ins = db.prepare('insert into sessions (plan, id, status, stops, health, why, claude, note, name, at, worktree, usage, pending, summary) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const log = db.prepare('insert into log (plan, session, at, status, stops, health, why, claude, name) values (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const act = db.prepare("insert into session_messages (plan, session, role, text, at) values (?, ?, 'activity', ?, ?)");
const row = (plan, id, name, { status, stops = [], health = 'ok', why = '', claude = '', at = ago(0.2), merged = null, cost = null, context = null, pending = [], summary = null, startedH = null, now = null }) => {
  ins.run(plan, id, status, JSON.stringify(stops), health, why, claude, '', name, at, merged === null ? null : JSON.stringify({ merged, branch: `escadrille/${plan}/${id}` }), cost === null ? null : JSON.stringify({ cost, context, input: Math.round(cost * 120000), output: Math.round(cost * 9000) }), JSON.stringify(pending), summary);
  if (startedH !== null) log.run(plan, id, ago(startedH), 'running', '[]', 'ok', '', 'Départ', name);
  log.run(plan, id, at, status, JSON.stringify(stops), health, why, claude, name);
  if (now) act.run(plan, id, now, ago(0.05));
};
const P9 = '2026-11-01-phase-9';
row(P9, 'D', "La direction, l'app et le lancement", { status: 'done', stops: [0, 1], merged: true, cost: 7.55, context: 0.31, startedH: 4.8, claude: 'Regarde docs/phase9/direction.md', summary: 'Fait : le cahier, la maquette de l’app, celle de la landing.\nReste : rien.' });
row(P9, 'K', "Lançable : l'installation, le README, les chiffres", { status: 'done', stops: [0, 1], merged: false, cost: 4.1, context: 0.42, startedH: 4.5, claude: 'Relis le README', summary: 'Fait : README, install.sh, les chiffres.\nReste : ta relecture.' });
row(P9, 'A', 'La barre latérale unique', { status: 'done', stops: [0, 1], merged: true, cost: 11.2, context: 0.55, startedH: 3.9, claude: 'La barre sur 7 pages', summary: 'Fait : sidebar.js partout.\nReste : rien.' });
row(P9, 'B', "L'accueil qui ouvre sur la Conversation", { status: 'running', stops: [0], merged: false, cost: 9.8, context: 0.48, startedH: 2.6, claude: 'Le fil stylé, les trois états', summary: 'Fait : / rend la Conversation.\nReste : la capture à 390.', now: 'édite public/mainchat.css' });
row(P9, 'P1', 'La passe Conversation, Ressources, panneau d’état', { status: 'running', stops: [], merged: false, cost: 3.2, context: 0.21, startedH: 0.9, claude: 'Le panneau d’état en cours', summary: 'Fait : le bloc Maintenant.\nReste : Claude, Coût, Garde.', now: 'lit public/mainchat.js' });
row(P9, 'P2', 'La passe Flot et plan, le canevas', { status: 'waiting', stops: [], merged: false, cost: 6.4, context: 0.37, startedH: 0.9, claude: 'Regarde http://localhost:3142/flow', pending: [{ id: 'r1', kind: 'reply', text: 'La planche avant/après est prête : CAPTURE…', at: ago(0.1) }], summary: 'Fait : canvas.js, le Flot.\nReste : le plan.' });
row(P9, 'P3', 'La passe Revue, Architecture, Accès, Rafale, Pilote', { status: 'running', health: 'error', why: 'node --test : 2 rouges dans review-page.test.mjs', stops: [], merged: false, cost: 5.1, context: 0.44, startedH: 0.9, claude: 'Les tests rouges', summary: 'Fait : Revue, Architecture.\nReste : Accès, Rafale, Pilote, Signaler.' });
for (const [id, name] of [['C', 'La vérification sur captures'], ['E', 'La dernière passe de l’accueil'], ['L', 'La landing avec les vraies captures'], ['Q', 'Le plan de QA de fin de run'], ['V', 'La vidéo de démo, 30 s'], ['M', 'La comm : kit de publication']]) row(P9, id, name, { status: 'later', at: ago(5) });

const CSV = '2026-11-01-export-csv';
row(CSV, 'A', 'Le point d’API /api/scores.csv', { status: 'running', stops: [], merged: false, cost: 1.12, context: 0.18, startedH: 0.4, claude: 'Le test s’écrit', now: 'écrit test/scores.test.mjs' });
row(CSV, 'B', 'Le bouton Exporter dans la page', { status: 'waiting', stops: [], merged: false, cost: 0.74, context: 0.12, startedH: 0.4, claude: 'Demande le réseau', pending: [{ id: 'p1', kind: 'permission', tool: 'Bash', text: 'curl -s https://registry.npmjs.org/papaparse', at: ago(0.05), reason: 'vérifier la version publiée' }] });
row(CSV, 'C', 'La doc et le changelog', { status: 'todo', at: ago(1.5) });
for (const s of ['A', 'B', 'C', 'D']) row('2026-10-31-qa-semaine', s, `QA ${s}`, { status: 'done', stops: [0], merged: true, cost: 1.55, context: 0.3, startedH: 29, at: ago(27) });
for (const s of ['A', 'B', 'C', 'D', 'E']) row('2026-10-30-phase-8', s, `Phase 8 ${s}`, { status: 'done', stops: [0], merged: true, cost: 3.74, context: 0.5, startedH: 47, at: ago(45) });

// --asks (or ESCADRILLE_SEED_ASKS=1): the « À toi » modal (docs/asks.md) gets a plan of three sessions, each waiting on a
// permission with its whole input: a local test run (asked 3 min ago), a network curl, a Write outside the project.
// No pilot is on in a fresh base: the three come back from GET /api/asks?project=<Carnet> with why 'dev'.
const ASKS = '2026-11-02-asks';
const withAsks = process.argv.includes('--asks') || process.env.ESCADRILLE_SEED_ASKS === '1';
if (withAsks) {
  const sessions = [sess('RYT', 'Le rythme des tests', 1, 4, SONNET, undefined, ['Les tests verts']), sess('MUET', 'Le mode muet', 1, 4, SONNET, undefined, ['La capture']), sess('OUT', 'Le fichier hors du projet', 1, 2, SONNET, undefined, ['Fait'])];
  up.run(ASKS, 'Les autorisations qui attendent', ago(0.3), JSON.stringify({ id: ASKS, title: 'Les autorisations qui attendent', created: ago(0.3), goal: 'La modale À toi', project: carnet, model: SONNET, waves: [{ n: 1, title: 'Maintenant' }], sessions }), carnet);
  for (const t of ['sessions', 'log', 'session_messages']) db.prepare(`delete from ${t} where plan = ?`).run(ASKS);
  const perm = (id, tool, input, text, network, minutes, suggest) => ({ id, kind: 'permission', tool, input, text, network, suggest, at: ago(minutes / 60) });
  const long = 'node --test test/asks.test.mjs test/pilot13.test.mjs && git add lib/asks.mjs test/asks.test.mjs docs/asks.md && git commit -m "asks: the explainer, the queue and the contract, written whole so the pilot and the developer read the same command"';
  row(ASKS, 'RYT', 'Le rythme des tests', { status: 'waiting', startedH: 0.3, cost: 0.6, context: 0.1, pending: [perm('ask-ryt', 'Bash', { command: long }, long.slice(0, 80), false, 3, { allow: true, reason: 'commande locale' })] });
  row(ASKS, 'MUET', 'Le mode muet', { status: 'waiting', startedH: 0.3, cost: 0.4, context: 0.1, pending: [perm('ask-muet', 'Bash', { command: 'curl -s https://registry.npmjs.org/papaparse' }, 'curl -s https://registry.npmjs.org/papaparse', true, 2, { allow: false, reason: 'accès réseau' })] });
  row(ASKS, 'OUT', 'Le fichier hors du projet', { status: 'waiting', startedH: 0.3, cost: 0.2, context: 0.05, pending: [perm('ask-out', 'Write', { file_path: path.join(ROOT, 'ailleurs', 'notes.md'), content: 'Une ligne.\n' }, 'écrit ailleurs/notes.md', false, 1, null)] });
}

const enc = encodeURIComponent;
console.log(`Carnet : ${carnet}\n  /flow?project=${enc(carnet)}\n  /plan/${P9}?project=${enc(carnet)}\n  /plan/${CSV}?project=${enc(carnet)}\n  /plan/2026-11-01-notifications?project=${enc(carnet)}${withAsks ? `\n  /api/asks?project=${enc(carnet)}  (3 autorisations, plan ${ASKS})` : ''}\nVide : ${vide}\n  /flow?project=${enc(vide)}`);
