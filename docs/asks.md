# « À toi » : les autorisations qui attendent le développeur

Le 2 novembre au soir, RYT et MUET ont attendu une heure une autorisation sans que Dev le sache. La modale « À toi »
les lui montre, entières, avec une phrase écrite par du code. Côté serveur : `lib/asks.mjs` (fonctions pures) et
`GET /api/asks` dans `server.mjs`. Côté page : `public/asks.js` et `public/asks.css` (session MOD).

## Changements du contrat

- 6 novembre au soir (session ATOI) : la réponse gagne `replies`, `kept` et `count`. `replies` : les arrêts qui
  attendent une réponse du développeur, un par session (`{ plan, session, sessionName, project, kind: 'reply',
  pendingId, stop, human, at, why: 'dev' }`) ; une session en `waiting` sans rien en attente y est aussi
  (`pendingId: null`), une session qui demande une autorisation n'y est pas (elle est dans `asks`). `kept` : ce
  qu'un pilote présent garde (arrêts ordinaires, autorisations de moins de 90 s), visible, jamais perdu. `count` =
  `asks.length + replies.length`. Pilote éteint, `kept` est vide : tout revient au développeur. La modale ne lit
  toujours que `asks`. Côté accueil, « À toi » montre les mêmes lignes et replie celles du pilote en une ligne
  « n gardés pour le pilote » ; le « n t'attend » du titre est la longueur de la liste (public/mainchat.js).
  Cause du défaut : la route ne lisait que les autorisations, et `lib/projectflow.mjs` donnait au pilote toute
  session en `waiting` sans entrée en attente, même pilote éteint.

## Le contrat

`GET /api/asks?project=<chemin>` → `{ asks: [...], remote: [...] }`. Sans `project` : tous les projets du serveur.

`asks`, de la plus ancienne à la plus récente, seulement ce qui doit ouvrir la modale :

| champ | valeur |
|---|---|
| `plan`, `session`, `sessionName`, `project` | où attend la demande |
| `pendingId` | l'`id` de l'entrée de `row.pending`, à renvoyer à la route answer |
| `tool` | `Bash`, `Write`, `Edit`, `WebFetch`… |
| `command` | la commande ou l'entrée entière, jamais coupée (Bash : la commande ; Write : chemin, ligne vide, contenu ; Edit : chemin, `--- avant`, `+++ après` ; WebFetch : l'URL ; sinon le JSON de l'entrée) |
| `explain` | `{ line, scope, known }` : `line` une phrase en français, `scope` `'local' \| 'outside' \| 'network'`, `known` booléen |
| `network` | `null` si la demande ne sort pas ; sinon la liste des hôtes lus (`[]` : elle sort, sans hôte lisible) |
| `suggest` | `{ allow, reason }` de `lib/policy.mjs`, ou `null` |
| `at` | l'heure ISO de la demande |
| `why` | `'dev'` (pour le développeur tout de suite) ou `'pilot-late'` (un pilote est allumé et n'a pas répondu en 90 s) |

`remote` : `[{ name, url, count }]` pour le Studio appairé que ce serveur connaît ; `[]` sinon (voir « Le Studio » plus bas).

`explain.line` est en français, sans clé i18n : `public/` est gelé pour cette session. La traduire demandera des clés
dans `public/i18n` et un `explain.key` à côté de `line`, sans retirer `line`.

Répondre : rien de neuf, la route answer de la session (`sessionApi(sid, 'answer', { id: pendingId, allow, always, reason })`).
Rafraîchir : le flux `/api/events` émet déjà `change` quand `pending` bouge ; la page n'ouvre pas de nouveau flux
(`public/events.js`, docs/terrain.md).

Gardes : la route passe par la garde commune de `server.mjs`, comme `/api/plan` : jeton d'appareil au LAN, poste par
cookie, et le refus des origines étrangères quand `escadrille/pare-feu-navigateur` (test/crosssite.test.mjs) sera sur main.

## Qui va dans la file (`queue`)

Décision de Dev et de son pilote, 2 novembre :

- tout de suite (`why: 'dev'`) quand `needsDev` (public/todo.js) la donne au développeur : pas de pilote sur le projet,
  une demande qui sort sur le réseau (`pending.network` ou une portée `network` trouvée par l'explicateur), un garde-fou
  touché (un fichier de `lib/guardrails.mjs` PROTECTED écrit ou modifié) ;
- pilote allumé : seulement après 90 s sans réponse (`why: 'pilot-late'`, `PILOT_LATE_MS`) ; à 90 s pile, c'est encore au pilote.

`queue(rows, { pilotOn, now, guard })` prend l'horloge en paramètre : les tests jouent les deux côtés.

## L'explicateur (`explain(tool, input, { cwd })`)

Écrit par du code, sans modèle. La portée la plus large l'emporte : `local` < `outside` < `network`. Dans le doute, la
large : un chemin avec une variable (`$TMPDIR`), une sous-commande `$( … )`, `sudo`, `node -e`, `find -exec` donnent
`outside` et `known: false`.

Reconnu : git (status, diff, log, show, add, commit, checkout, switch, restore, worktree add/list/remove/prune, push
« vers GitHub » en `network`, pull/fetch/clone en `network`, reset, clean, stash, config, et les sous-commandes locales
courantes) ; `node --test`, `node <script>` ; npm, npx, pnpm, yarn, bun (`network` sauf `--offline`) ; rm (ce qui est
effacé), mkdir, cp, mv ; curl, wget (l'hôte ; localhost reste local) ; cd (la suite se lit depuis le nouveau dossier) ;
`>`, `>>`, `<` ; `sh -c "…"` relu ; ls, cat, grep, find, sed -i et les lectures courantes ; les outils Write, Edit,
Read, Glob, Grep, WebFetch, WebSearch. Une commande composée (`&&`, `||`, `;`, `|`) s'explique par parties.
Inconnu : `known: false`, la ligne « Commande non reconnue : lis-la avant d'autoriser », portée `outside` ; une partie
connue et une inconnue : les deux dites, puis « : lis-la avant d'autoriser ».

## Le pilote voit la commande entière

`lib/wake.mjs` donne au pilote la commande entière de chaque autorisation, ou sa longueur et son empreinte sha256
au-delà de 2 000 caractères (arrêt 1).

## Le Studio (`remote`)

Aucune configuration existante ne donne à un serveur l'adresse de l'app d'un Studio appairé ni de quoi compter ses
demandes sans ajouter de confiance : le poste garde son cookie dans le navigateur, pas dans le serveur, et la présence
d'équipe (docs/team.md) dit « waiting » sans distinguer une autorisation. `remote` vaut donc `[]` (question posée à Dev
dans l'arrêt 0).

## Semer une autorisation pour la vérification (VER)

`test/seed-flow.mjs --asks` (ou `ESCADRILLE_SEED_ASKS=1`) ajoute au projet « Carnet » le plan `2026-11-02-asks` :
trois sessions en attente, chacune avec une autorisation entière, sans pilote donc toutes `why: 'dev'` :

| session | pendingId | ce qui attend | portée |
|---|---|---|---|
| RYT | `ask-ryt` | `node --test … && git add … && git commit -m "…"` (plus de 200 caractères, il y a 3 min) | local |
| MUET | `ask-muet` | `curl -s https://registry.npmjs.org/papaparse` | network |
| OUT | `ask-out` | Write d'un fichier hors du projet | outside |

S'y ajoute l'ancienne autorisation du plan « export CSV » (`p1`, texte seul, réseau). Dans le bac, depuis la racine
du worktree :

```
PORT=3142 ESCADRILLE_DB=$TMPDIR/asks/db.sqlite ESCADRILLE_PLANS=$TMPDIR/asks/plans ESCADRILLE_CLAUDE=/usr/bin/false node --no-warnings server.mjs
ESCADRILLE_DB=$TMPDIR/asks/db.sqlite ESCADRILLE_SEED_ROOT=$TMPDIR/asks/seed node --no-warnings test/seed-flow.mjs --asks
```

Le script affiche l'adresse `/api/asks?project=…`. Une réponse se donne par la route answer ; aucune session ne tourne
derrière (`mode` n'est pas `page`), donc la réponse peut être refusée faute de processus : pour VER, vérifier que la
modale lit la liste et envoie le bon `{ id, allow }`. Le test `test/asks.test.mjs` démarre le même serveur et le sème
de la même façon.

## Les fichiers

`lib/asks.mjs`, `lib/wake.mjs` (`pilotCommand`, `commandsSection`), `server.mjs` (`asksNow`, la route, les commandes
dans la liste des attentes et le réveil du pilote), `test/asks.test.mjs`, `test/seed-flow.mjs --asks`.
