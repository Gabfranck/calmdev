// Seeds the pilot's log (docs/pilotlog.md) with a plausible morning, for the screenshots of /#pilote (not a test):
//   PORT=3082 ESCADRILLE_DB=$TMPDIR/pl.sqlite ESCADRILLE_PLANS=$TMPDIR/pl-plans node --no-warnings server.mjs
//   ESCADRILLE_DB=$TMPDIR/pl.sqlite node --no-warnings test/seed-pilotlog.mjs
// The project lives in .escadrille/seed/escadrille of this worktree (never committed). Prints its URL.
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import * as pilotlog from '../lib/pilotlog.mjs';

// node --test picks up every file in test/: without ESCADRILLE_DB this is that run, and it does nothing
const DB = process.env.ESCADRILLE_DB; if (!DB) { console.log('seed-pilotlog: set ESCADRILLE_DB to the running server database'); process.exit(0); }
const project = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '.escadrille', 'seed', 'escadrille');
mkdirSync(project, { recursive: true });
const P7 = '2026-11-01-phase-7-connecteurs-robustesse-linux'; const P8 = '2026-11-01-phase-8-tout-part-du-chat-en-cinq';
const rows = [
  ['2026-10-31T22:40', 'launch', P7, null, 'Lancé la phase 7, dix-huit sessions\nGab a validé le plan à 22:35 ; budget 9 $ par session.'],
  ['2026-10-31T23:05', 'answer', P7, 'N', 'Répondu à N : le dossier Linux reste ~/.config\nN hésitait entre ~/.config et ~/.local/share ; XDG fixe ~/.config pour les réglages.'],
  ['2026-10-31T23:48', 'refuse', P7, 'K', 'Refusé un npm install hors bac à sable\nK voulait ajouter une dépendance de test ; la règle : Node sans dépendance pour le serveur.'],
  ['2026-11-01T00:30', 'merge', P7, 'N', 'Fusionné N dans main, tests verts'],
  ['2026-11-01T08:40', 'note', null, null, 'Repris le pilotage, onze sessions en cours\nLa nuit a laissé trois arrêts ouverts : B, K et P.'],
  ['2026-11-01T08:46', 'answer', P7, 'B', 'Répondu à B : garder le port 3078\nB voulait passer à 3079 pour ses essais ; CLAUDE.md fixe 3078, les essais prennent un port libre.'],
  ['2026-11-01T08:52', 'capture', P7, 'P', 'Capturé l’accueil de P aux trois largeurs\nP attendait l’avis du développeur sur la barre du haut ; captures dans docs/phase7-design/.'],
  ['2026-11-01T09:05', 'message', P7, 'K', 'Écrit à K : relance les tests de robustesse\nDeux tests échouaient sur un port déjà pris par une autre session.'],
  ['2026-11-01T09:20', 'memory', null, null, 'Noté la décision « Le flot du produit »\nTout part du chat ; tout ce qui se passe en coulisse doit se comprendre vite.'],
  ['2026-11-01T09:34', 'merge', P7, 'K', 'Fusionné K dans main'],
  ['2026-11-01T09:58', 'propose', P8, null, 'Proposé à Dev la phase 8 en cinq sessions\nA le pilote dans le chat, B la capture, C la fusion et le plafond, D ce journal, E la passe design.'],
  ['2026-11-01T10:25', 'memory', null, null, 'Noté « LA règle de la revue » : le moins de texte\nUn chiffre et deux mots, le détail au clic.'],
  ['2026-11-01T10:31', 'launch', P8, null, 'Lancé la phase 8, cinq sessions'],
  ['2026-11-01T10:47', 'answer', P8, 'D', 'Répondu à D : contrat validé, livre vite\nA attend la table pilot_actions et les deux routes.'],
  ['2026-11-01T11:02', 'refuse', P8, 'B', 'Refusé une commande hors bac à sable\nB voulait lancer Chrome sans le bac à sable ; la capture passe en headless.'],
  ['2026-11-01T11:18', 'merge', P7, 'P', 'Fusionné P, la passe design de la phase 7'],
  ['2026-11-01T11:40', 'message', P8, 'C', 'Écrit à C : le plafond suit docs/estimation.md'],
  ['2026-11-01T12:05', 'merge', P8, 'D', 'Fusionné le contrat de D pour débloquer A'],
];
const db = new DatabaseSync(DB); pilotlog.schema(db);
db.prepare('delete from pilot_actions where project = ?').run(project);
for (const [at, kind, planId, sessionId, text] of rows) pilotlog.record(db, { project, planId, sessionId, kind, text, at: at + ':00+01:00' });
console.log(`${rows.length} actions · /?project=${encodeURIComponent(project)}#pilote`);
