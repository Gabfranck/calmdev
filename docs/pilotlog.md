# Le journal du pilote

Ce que le pilote a fait, une ligne par action, pour que la coulisse se comprenne vite (décision « Le flot du
produit », 09:20). Le pilote écrit, la page lit ; rien d'autre n'en dépend. Code : `lib/pilotlog.mjs`,
`public/pilotlog.js`, `public/pilotlog.css` ; dans `server.mjs`, la table et les deux routes sous « Phase 8 D ».

## La table

```sql
pilot_actions (seq integer primary key autoincrement, project text not null, plan_id text, session_id text,
               kind text not null, text text not null, at text not null)
index (project, at, seq)
```

Créée au démarrage, comme les autres (`pilotlog.schema(db)`).

`kind` vaut l'un de :

| kind | le verbe affiché | quand |
|---|---|---|
| `answer` | Répondu | le pilote répond à l'arrêt ou à la question d'une session |
| `propose` | Proposé | il propose un plan ou une décision à Dev |
| `launch` | Lancé | il lance un plan ou une session |
| `message` | Écrit | il envoie un message à une session |
| `memory` | Noté | il écrit une ligne de mémoire |
| `capture` | Capturé | il prend une capture d'écran |
| `refuse` | Refusé | il refuse une demande (réseau, hors bac à sable…) |
| `merge` | Fusionné | il fusionne une branche |
| `note` | Noté | le reste |

`text` : **la première ligne est l'action, dix mots au plus** (au-delà, la ligne est coupée et la fin passe au
détail) ; **les lignes suivantes sont le pourquoi**, montré au clic. 4 000 caractères au plus.

## L'API (`lib/pilotlog.mjs`)

- `record(db, { project, planId, sessionId, kind, text })` → la ligne, telle que la rend `list` ; lève une
  erreur (`status` 400) sur un `kind` inconnu, un texte vide ou sans `project`.
- `list(db, { project, before, limit })` → `{ actions, more, total }`, la plus récente d'abord ; `before` est le
  `seq` de la plus ancienne déjà montrée ; `limit` de 1 à 200, 50 par défaut.

Une action rendue : `{ seq, kind, text, detail, planId, sessionId, at, href }`, où `text` est la ligne (dix mots)
et `detail` le pourquoi (`''` sans).

## Les routes

- `GET /api/pilot/log?project=&before=&limit=` → `{ actions, more, total }`.
- `POST /api/pilot/log { project, kind, text, plan, session }` → `{ ok, action }` ; 400 sur un projet qui n'est
  pas un dossier, un `kind` inconnu, un texte vide.

Les deux sont **au Mac seulement** : 401 depuis le LAN sans jeton, 403 avec le jeton du téléphone. Un POST
réveille la Conversation du projet (`main:<projet>` dans `/api/events`).

`href` est construit par le serveur à partir de `plan` et `session`, jamais lu dans le texte :
`/plan/<plan>?project=<projet>#s-<session>` (le nœud de la session dans le Flot), `/plan/<plan>?project=<projet>`
sans session, `null` sans plan.

Le pilote à la main écrit ainsi :

```sh
curl -s localhost:3078/api/pilot/log -H 'content-type: application/json' \
  -d '{"project":"~/Dev/escadrille","kind":"answer","plan":"2026-11-01-phase-8-tout-part-du-chat-en-cinq","session":"B","text":"Répondu à B : garder le port 3078\nB voulait 3079, la règle fixe 3078."}'
```

## L'écran

`/#pilote`, sans onglet : une ligne repliée sous le fil de la Conversation, « Le pilote · 12 actions », y mène.
Regroupé par jour, une ligne par action : l'heure, le verbe, la ligne, la session en puce (sa lettre, lien vers
son nœud dans le Flot) ; un clic sur la ligne déplie le pourquoi. Aucune phrase en tête. `public/pilotlog.js`
insère la ligne repliée et rend la vue ; `public/index.html` n'a qu'une ligne pour le charger.

Pour un écran rempli : `node test/seed-pilotlog.mjs <projet>` écrit une matinée plausible dans la base
(`ESCADRILLE_DB`).

## Les tests (`test/pilotlog.test.mjs`)

`record` (le lien construit, jamais lu dans le texte ; la ligne de dix mots, le reste au détail ; les refus),
`list` (pagination, un projet à la fois), contre le serveur : POST et GET, 400, 401 et 403 depuis le LAN ; puis
l'écran sans navigateur (vm) : les jours, le verbe dit une fois, la puce vers la session, le pourquoi au clic, la
ligne repliée sous le fil.
