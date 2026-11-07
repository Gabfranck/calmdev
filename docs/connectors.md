# Les connecteurs : GitHub et Linear

Phase 7, session A. La demande de Dev (06:45, `docs/decisions.md`) : quand la PR d'une session est prête, passer
son ticket en « À revoir ». D'abord sans OAuth ni service : le `gh` déjà connecté sur le Mac, et une clé Linear par
projet, hors dépôt. Tenu par `test/connectors.test.mjs`.

## Le geste

Sur une session `done` dont le résumé dit « PR prête », le bouton « Ouvrir la PR » (câblé par la session B) appelle
`POST /api/plan/:id/session/:sid/pr`. Le serveur :

1. pousse la branche de la session (`git push -u origin <branche>`) ;
2. ouvre la PR vers la branche de base du plan ;
3. pour chaque ticket de la session, le passe dans le statut du projet (« À revoir » par défaut) et y commente
   l'URL de la PR.

**Rien ne sort tant que personne n'a cliqué**, pour GitHub : aucun appel `gh` ni `git push` au démarrage, dans une
route GET (sauf le rafraîchissement explicite de l'état d'une PR), ni dans un test (les tests passent par un faux `gh`
et un faux Linear local). Pour Linear, la règle a changé le 2 novembre : avec une clé et la synchro allumée, le serveur
met à jour seul les tickets qu'une session cite (« La synchro », plus bas) ; « À revoir » et le commentaire « PR
prête » restent sur le clic « Ouvrir la PR ».

## Les routes (du Mac seulement)

```
POST /api/plan/:id/session/:sid/pr
  exige : la session est 'done' ; son worktree n'est pas supprimé, ou sa branche existe encore dans le dépôt
          (la fusion supprime le worktree et garde la branche)
  fait  : pushBranch, createPr (titre = nom de la session ; corps = le dernier résumé de son bloc state,
          puis « Plan Escadrille <id>, session <sid> »), puis pour chaque ticket moveToState et comment
  → 200 { ok: true, pr: { url, number, base, head, at }, tickets: [{ identifier, state, ok, error }] }
  → 400 { error } : session pas finie, pas de branche, gh absent ou non connecté, pas de remote…
  un second clic ne refait rien : il rend ce qui est gardé (colonne JSON 'pr' de sessions), y compris les
  tickets ; un ticket en échec ne bloque pas la PR (ok: false, error lisible)

GET  /api/plan/:id/session/:sid/pr
  rafraîchit l'état de la PR gardée par 'gh pr view --json' (à la demande seulement)
  → 200 { ok: true, pr: { url, number, base, head, at, state, merged, reviewDecision, checked } }
  → 400 { error } : aucune PR ouverte pour cette session
```

`GET /api/plan/:id` rend `pr` dans chaque entrée de `state` (l'objet gardé, ou `null`) ; il n'appelle jamais `gh`.

Chaque appel sortant écrit un message système dans la session : « Branche poussée : <branche> », « PR ouverte :
<url> » (ou « PR déjà ouverte : <url> »), « ORC-88 → À revoir », « ORC-88 : <erreur> ».

## Les réglages du projet

```
GET  /api/project/settings?project=…   … , linear: { key: true | false, state: "À revoir", sync: true | false }
POST /api/project/settings { project, linearKey?, linearState?, linearSync? }
  linearKey   : une chaîne (la clé API personnelle Linear), ou null pour l'effacer
  linearState : le nom du statut où passer un ticket ; null revient au défaut ; stocké dans project_settings
  linearSync  : false éteint la synchro (« La synchro ») ; true ou null revient au défaut (allumée dès qu'une clé est
                posée) ; `sync` de la vue est faux sans clé
```

La clé n'est **jamais renvoyée** par une route, jamais dans la base, jamais dans un log ni un message de session.

## Où vit la clé

`~/.config/escadrille/secrets.json` (ou `ESCADRILLE_SECRETS`, pour les tests), mode `0600`, dossier `0700`, hors de
tout dépôt :

```json
{ "~/Dev/orchard": { "linear": "lin_api_…" } }
```

`lib/secrets.mjs` : `get(project, name)`, `set(project, name, value)`, `clear(project, name)`. Le fichier n'est
pas chiffré : un chiffrement sans secret à côté (pas de trousseau, pas de mot de passe) ne protégerait rien. Le
dossier `~/.config/escadrille` est dans le `denyRead` du bac à sable des sessions (`lib/planner.mjs`) : une
session ne lit pas la clé.

## Le plan : `base` et `tickets`

```json
{ "id": "…", "base": "main", "sessions": [{ "id": "A", "tickets": ["ORC-88", "ORC-91"], … }] }
```

- `base` (facultatif) : la branche de base de la PR. Défaut : la branche d'où le worktree de la session est parti
  (`worktree.create` la rend dans `base` ; lue dans `worktree.base` de la session quand le lancement la garde),
  sinon la branche courante du dépôt au moment du clic, sinon `main`.
- `tickets` (facultatif, par session) : des identifiants Linear, motif `^[A-Z][A-Z0-9]+-\d+$` ; un identifiant mal
  formé fait refuser le plan. `validatePlan` garde tels quels les champs qu'il ne connaît pas.

## Les modules

`lib/github.mjs` : le programme est `ESCADRILLE_GH` (défaut `gh`), lancé par `execFile`, jamais par un shell ;
`git` aussi.

| Fonction | Ce qu'elle fait | Rend |
| --- | --- | --- |
| `pushBranch({ cwd, branch })` | `git push -u origin <branche>` : le seul push du serveur, sur le clic | `{ ok }` |
| `createPr({ cwd, base, head, title, body })` | `gh pr create --base --head --title --body` ; une PR déjà ouverte : `gh pr list --head <head> --json url,number` | `{ url, number, existing }` |
| `prState({ cwd, number })` | `gh pr view <n> --json state,mergedAt,url,reviewDecision` | `{ state, merged, url, reviewDecision }` |
| `ghPresent(env)` | cherche `gh` sur le PATH par `existsSync`, sans le lancer | booléen |

Erreurs lisibles : « gh introuvable (installe GitHub CLI) », « gh n'est pas connecté : lance gh auth login »,
« le dépôt n'a pas de remote origin », le texte de `gh` sinon.

`lib/linear.mjs` : `POST https://api.linear.app/graphql` (ou `ESCADRILLE_LINEAR_URL`), `fetch` natif, la clé dans
l'en-tête `Authorization`.

| Fonction | Rend |
| --- | --- |
| `viewer(key)` | `{ id, name, email }` : teste une clé |
| `listIssues({ key, project })` | `[{ identifier, title }]` (du projet Linear nommé, sinon les tickets assignés) |
| `issueByIdentifier({ key, identifier })` | `{ id, identifier, title, state, stateType, team: { id, key } }` (`stateType` : le type Linear du statut, `backlog`, `unstarted`, `started`, `completed`, `canceled`) |
| `teamStates({ key, teamId })` | `[{ id, name, type, position }]`, dans l'ordre de Linear |
| `moveToState({ key, identifier, stateName })` | cherche le statut par nom dans l'équipe du ticket : `stateName`, sinon « À revoir », sinon « In Review », sinon une erreur qui liste les noms disponibles ; rend `{ identifier, state }` ; refuse un statut de type `completed` ou `canceled` (« ne passe jamais en « Done » par Escadrille ») |
| `moveToStarted({ key, identifier })` | depuis `backlog` ou `unstarted` seulement, vers le premier statut de type `started` de l'équipe (In Progress en général) ; un ticket déjà commencé, fini ou annulé garde son statut (`moved: false`) ; une équipe sans statut `started` : une erreur qui liste les noms |
| `comment({ key, identifier, body })` | `{ ok, id }` |

## Partir des tickets (phase 16 TIX, lecture seule)

`lib/tickets.mjs` liste et lit les tickets d'un projet ; rien n'y change un statut ni n'écrit un commentaire.

```
GET  /api/tickets?project=&source=linear|github&q=   → [{ id, title, state, url, source }], 50 au plus
POST /api/plan/from-tickets { project, ids, idea?, model? } → { id } : la planification, comme POST /api/escadrille
```

- Linear : la clé du projet (`secrets`), `searchIssues` : les tickets ouverts de l'espace, ou ceux dont le titre
  contient `q`. GitHub : `gh issue list --state open --limit 50 --json number,title,state,url [--search q]` dans le
  dossier du projet ; une issue devient `GH-<n>`.
- `ids` : 1 à 8, motif `^[A-Z][A-Z0-9]+-\d+$`, dédoublonnés ; `GH-<n>` est lu par `gh issue view`, le reste par
  `issueDetail` (Linear). `validatePlan` accepte déjà `GH-12` (même motif), test à l'appui.
- Le premier message de la planification : l'idée du développeur (sinon « Planifie le travail des tickets … »),
  puis le bloc :

```
## Les tickets

Mets dans `tickets` de chaque session les identifiants qu'elle traite ; lecture seule : ne change ni statut ni commentaire.

### ORC-88 · Titre (Todo)
https://linear.app/…/ORC-88
<description, coupée à ce qui reste>
Derniers commentaires :
- Léa, 2026-10-01 : <300 caractères au plus>
```

- Taille : 2 000 caractères au plus par ticket (titre, URL et 3 derniers commentaires compris ; la description
  prend la place restante), 8 tickets : ~16 000 caractères, ~4 000 jetons au pire, payés une fois en écriture de
  cache puis en lecture à chaque appel de la planification. Rien n'entre dans le prompt système : le bloc est un
  message, il ne coûte qu'aux planifications parties des tickets.
- Les erreurs, une phrase et le geste : « Linear : aucune clé pour ce projet ; colle ta clé personnelle dans
  Réglages du projet, ligne Linear. », « gh n'est pas connecté : lance gh auth login ».

## La synchro (2 novembre, décision de Dev ; `lib/linearsync.mjs`, `test/linearsync.test.mjs`)

Le matin du 2 novembre, le pilote a passé 23 tickets Orchard en In Progress et y a commenté l'état et le coût à la
main, par le connecteur MCP. Dev a tranché : **pour Linear seulement**, quand le projet a une clé et que le réglage
`linearSync` n'est pas éteint (allumé par défaut dès qu'une clé est posée, une case dans le bloc Linear des Réglages,
la vue Accès le dit), calmdev met à jour seul les tickets qu'une session cite. GitHub ne change pas : push, PR et
fusion restent au clic.

Les tickets d'une session (`ticketsOf(session, row)`) : sa liste `tickets`, puis les identifiants lus dans son nom, son
prompt et son résumé (deux à cinq majuscules, un tiret, un nombre sans zéro de tête : `ORC-88` ; pas collé à un mot, un
chemin ou un code plus long comme `R02-R07` ou `claude-sonnet-5-5` ; `UTF-8`, `SHA-256`, `ISO-8601`, `RFC-2119`,
`HTTP-2`… ignorés). Chaque identifiant une fois.

| Événement | Ce qui part | Une fois par |
| --- | --- | --- |
| session lancée (`onLaunched`) | le ticket passe au statut de type `started` de son équipe, s'il était `backlog` ou `unstarted` ; sinon rien (« gardé : <statut> ») | session et ticket |
| session fusionnée dans la base du plan, ou livrée en kit (`onDelivered`, `how: 'merged' \| 'kit'`) | un commentaire « État au <date> (Escadrille) : <Fait>. Reste : <Reste>. Coût ≈ x $. » puis « Session <id> du plan <plan>, fusionnée dans la base du plan / livrée en kit. » ; `Fait :` et `Reste :` lus dans le `summary` du bloc state, le résumé entier sinon ; le coût de `usage.cost` | session et ticket : deux fusions, ou un kit puis une fusion, font un seul commentaire, l'id du commentaire gardé |
| la PR gardée vue fusionnée (`onPrMerged`, après `GET …/pr`) sur une branche de production (`base` parmi `main`, `master`, `production`, `prod`) | un commentaire « Fusionné en production par la PR <url> (Escadrille). » | session, ticket et URL de PR ; rien sur une PR ouverte ni fusionnée dans `dev` |

**Jamais Done** : Done veut dire livré et vérifié en production, c'est Dev qui le déclare ; `lib/linear.mjs` refuse tout
statut `completed` ou `canceled`, même demandé par nom. Aucun changement de titre, description, priorité, assigné ni
label : les seules mutations sont `issueUpdate(stateId)` et `commentCreate`.

**Une erreur Linear n'arrête rien** : la session continue, le ticket reçoit une ligne dans le journal du pilote
(`pilot_actions`, kind `note` : « Linear : ORC-88 non mis à jour (lancement) » puis l'erreur) et une alerte discrète va
dans « À toi » (« Regarde la clé Linear », badge L, lien vers Accès) une fois par jour et par projet au plus : la table
`linear_sync` garde une ligne `alert` par jour, le Flot (`GET /api/projectflow`, champ `linear`) la rend pendant 24 h,
`public/todo.js` en fait une ligne (`kind: 'linear'`). Un ticket inconnu de Linear (`introuvable`) n'est plus demandé
pour cette session ; chaque couple (session, ticket, événement) n'atteint Linear qu'une fois, échec compris.

La mémoire : `linear_sync (project, plan, session, identifier, kind, ref, result, at)`, clé primaire
`(plan, session, identifier, kind, ref)` ; `kind` parmi `started`, `delivered`, `production` (ref = l'URL de la PR),
`missing`, `alert` (ref = le jour) ; `result` le statut atteint, l'id du commentaire, ou « échec : … ». Jamais la clé.

**Le branchement dans `server.mjs`** (fichier relu par Dev à la fusion, docs/autonomy.md) : `linearsync.init({ db, keyOf, settingsOf,
log: pilotRecord })` au démarrage ; `settingsOf` ajoute `publicView` au bloc `linear`, `writeSettings` passe `linearSync` à
`applySetting` ; `onLaunched` dans `launchSession` (après l'état « running »), `onDelivered` dans `mergeSession` (après la
fusion, `how: 'merged'`) et dans `onDone` d'un plan en kit (`how: 'kit'`), `onPrMerged` dans `sessionPrState` (après la PR
gardée rafraîchie, si `merged`). Tous en « lance et oublie » (`.catch(() => {})`) : la session n'attend jamais Linear.
Prouvé par le serveur dans `test/connectors.test.mjs` (« the sync ») : réglage allumé par défaut, éteint par `false`,
relancé par `null` ; un lancement passe ORC-5 en In Progress ; deux fusions font un commentaire ; la PR gardée vue
fusionnée sur `main` fait un commentaire « Fusionné en production », un second rafraîchissement rien ; la clé absente des
logs et du journal du pilote.

Chaque appel rend `{ on, tickets: [{ identifier, result | error }] }` et ne lève jamais ; `on: false` sans clé, réglage
éteint ou avant `init`. Les tests (`test/linearsync.test.mjs`, faux Linear) prouvent : chaque transition (Todo → In
Progress, Todo → In Review dans une équipe qui n'a que celui-là, À revoir et Done gardés, RAW sans statut `started` en
erreur sans rien casser), l'idempotence (relance, deux fusions, kit après fusion, rafraîchissement de PR revu), jamais
Done (aucun `issueUpdate` vers un statut `completed`, le refus par nom), éteint sans clé et réglage à `false`, la clé
jamais dans le journal, l'alerte, la vue ni un résultat, l'alerte une fois par jour, Accès ambre avec la synchro.

Dans Accès (`lib/access.mjs`) : le connecteur Linear porte `sync: true | false` et dit sa portée réelle ; avec la synchro,
`api.linear.app` passe de « sur clic seulement » à « seul, quand une session citant un ticket est lancée, fusionnée ou
sa PR fusionnée en production » (`onClick: false`, la ligne « Ce qui sort » devient ambre, comme le relais d'équipe) ;
réglage éteint ou sans clé, rien ne change.

## Les faux, pour les tests

- `test/fake-gh.mjs` : un exécutable Node posé dans `ESCADRILLE_GH`. Il ajoute ses arguments (une ligne JSON) au
  fichier `FAKE_GH_LOG`, et répond : `pr create` → l'URL `https://github.com/acme/demo/pull/7` ; `pr list` → `[{
  url, number }]` ; `pr view` → `{ state: "OPEN", mergedAt: null, url, reviewDecision: "REVIEW_REQUIRED" }` ;
  `FAKE_GH_MODE=exists` fait échouer `pr create` (« already exists »), `unauth` répond « not logged in ».
- `git push` part vers un dépôt nu local (`origin` = un dossier) : aucun réseau.
- Un faux Linear : un serveur `node:http` sur 127.0.0.1 qui répond au GraphQL (`viewer`, `issues`,
  `workflowStates` avec `type` et `position`, `issueUpdate`, `commentCreate`), garde chaque requête (corps et en-tête
  `Authorization`) et chaque commentaire par ticket (`comments`) pour les assertions ; `issueState[id]` prérègle un
  statut, `stateName(id)` le lit. Équipes : AGO (Todo, In Progress, À revoir, Done), OPS (Todo, In Review, Done), RAW
  (Backlog, Done : aucun statut `started`).

## La vue Accès

`extensions.connectors` (`lib/access.mjs`) :

```js
{ name: 'GitHub', kind: 'gh', scope: 'pousser la branche d'une session, ouvrir et lire ses PR',
  where: 'le gh de ce Mac et sa connexion', ready: <gh sur le PATH, sans l'appeler>, key: false }
{ name: 'Linear', kind: 'api', scope: 'lire les tickets, passer un ticket en « À revoir », commenter' (ou la portée de la synchro),
  where: '~/.config/escadrille/secrets.json (0600, hors dépôt, non chiffré : un chiffrement sans secret ne protégerait rien)',
  ready: <clé présente pour ce projet>, key: <clé stockée>, sync: <clé et réglage linearSync non éteint> }
```

`out` ajoute `api.github.com` et `api.linear.app`, avec `onClick: true` et `why` « sur clic seulement … » ; ils ne
rendent pas la ligne ambre (rien n'est ouvert maintenant). Avec la synchro, `api.linear.app` est joint seul et la ligne
est ambre (« La synchro »). Aucun secret ne sort. `connectorsOf({ project, env, linearSync })` est exporté pour les
tests.

Pour la page (session B) : le bouton « Ouvrir la PR » se montre sur une session `done` sans `pr` ; avec `pr`, le lien
`pr.url` et les tickets (`pr.tickets`, un ticket `ok: false` dit son `error`). Le second appel rend la même chose.

## Les limites

- Un seul remote, `origin` ; pas de fork.
- La PR n'est pas mise à jour si la session reprend après : le second clic rend la PR gardée (le push suivant se
  fait à la main, ou par un nouveau clic quand on l'aura voulu).
- La clé Linear est une clé personnelle ; pas d'OAuth (il viendra avec le relais hébergé, l'app OAuth est à Dev).
- `ready` de GitHub dit que `gh` est installé, pas qu'il est connecté (le savoir demanderait de le lancer).

- Deux clics simultanés : le second reçoit « la PR est déjà en cours d'ouverture » (400), pas la PR.

## Reporté

- **`worktree.base` gardé au lancement** : `worktree.create` rend `base`, mais `launchSession` (région de la session
  C) ne recopie que `path, branch, cwd, root, merged`. Ajouter `base: w.base` à cette ligne ; d'ici là, le défaut
  est la branche courante du dépôt au clic (le plus souvent la même).
- `listIssues` et `viewer` existent sans route : un « Tester la clé » et un choix de tickets dans la page viendront
  avec la page (session B ou suivante).
- Le test `the five kinds of push` de `test/phone.test.mjs` échoue par délai dans la suite complète quand le Mac est
  chargé (constaté aussi sur la base, sans ce travail) ; il passe seul.

## Phase 16 GH : lire les PR, relayer les corrections, fusionner sur un clic

Le serveur seul parle à GitHub, par le `gh` déjà connecté (les sessions n'ont pas le réseau). Il lit l'état des PR
d'un projet, renvoie à la session ce qu'elle doit corriger, et fusionne une PR **sur le clic de Dev seulement**
(cookie de page) : jamais une session, le pilote, un réglage ni le relais. Tenu par `test/github-prs.test.mjs` et
`test/ghrelay.test.mjs`, contre `test/fake-gh.mjs`.

### Les fonctions ajoutées à `lib/github.mjs`

Toutes par `execFile`, arguments fixes, numéro de PR vérifié entier positif, branches par `checkBranch`.

| Fonction | Appel | Rend |
| --- | --- | --- |
| `prList({ cwd, sessions })` | `gh pr list --state open --json number,title,headRefName,headRefOid,baseRefName,author,reviewDecision,statusCheckRollup,mergeable,url` | `[{ number, title, branch, base, head, author, reviewDecision, ci, mergeable, url, session }]` |
| `prChecks({ cwd, number })` | `gh pr checks <n> --json name,state,bucket,link,workflow` (les codes 1 et 8 de gh, rouge et en cours, gardent la sortie) | `{ ci, checks: [{ name, workflow, bucket, link }] }` |
| `failedLog({ cwd, number, secrets })` | le premier check `fail` dont le lien porte `/actions/runs/<run>/job/<job>`, puis `gh run view <run> --job <job> --log-failed` | `{ check, run, job, log }` : les 200 dernières lignes, secrets masqués ; `null` si rien n'est rouge |
| `prReviewComments({ cwd, number })` | `gh api graphql -f query=<requête fixe> -F owner={owner} -F repo={repo} -F n=<n>` : `gh` remplit lui-même `{owner}` et `{repo}` depuis le remote, la requête est une constante, rien n'est interpolé | `[{ id, path, line, author, body, url, at }]` : les fils non résolus et non périmés (premier commentaire, réponses jointes), et le corps des revues « changes requested » (`path: null`) |
| `prMerge({ cwd, number, method, deleteBranch })` | relit la PR (`gh pr view <n> --json state,mergeable,reviewDecision,statusCheckRollup,headRefOid`), refuse par `mergeBlock` ou lance `gh pr merge <n> --merge\|--squash\|--rebase [--delete-branch] --match-head-commit <oid>` | `{ ok, number, method, deleted }` |
| `mergeBlock(pr)` | pur : la phrase de refus, ou `null` | chaîne ou `null` |
| `conflicts({ cwd, base, head })` | local, sans réseau : `git merge-tree --write-tree --name-only --no-messages <base> <head>` (base : `origin/<base>` s'il existe, sinon `<base>`) | `{ conflict, files }` |

`ci` résume les checks : `green` (tous `pass` ou `skipping`), `red` (au moins un `fail` ou `cancel`), `pending` (au
moins un en cours, aucun rouge), `none` (aucun check). `mergeable` : `MERGEABLE`, `CONFLICTING` ou `UNKNOWN`, tel que
gh le dit. `session` : `{ planId, sessionId }` de la session dont `pr.number` est ce numéro, sinon dont la branche est
`headRefName`, sinon `null`.

Masquage du journal, comme `hide` de `lib/qarun.mjs` : les valeurs connues du projet (`secrets`, environnement de dev
et comptes de test) deviennent `•••`, puis les motifs de jetons (`gh[pousr]_…`, `github_pat_…`, `sk-…`, `lin_api_…`,
`AKIA…`, `xox[abp]-…`, `Bearer …`, `password=…`, `token=…`, `secret=…`) ; les `***` de GitHub restent.

Les refus de `mergeBlock`, une phrase chacun, dans cet ordre : « La PR n'est plus ouverte. », « La CI est rouge :
corrige-la avant de fusionner. », « La CI tourne encore : attends qu'elle finisse. », « Des changements sont demandés
en revue. », « La PR est en conflit avec sa base. », « GitHub ne sait pas encore si la PR est fusionnable : réessaie
dans un instant. ». Une méthode hors `merge`, `squash`, `rebase` : « méthode : merge, squash ou rebase ».

### Les routes (du Mac seulement)

```
GET  /api/github/prs?project=…
  lit gh pr list sur la demande (aucun appel au démarrage)
  → 200 { ok: true, prs: [{ number, title, branch, base, head, author, reviewDecision, ci, mergeable, url,
          session: { planId, sessionId } | null }] }
  → 400 { error } : gh absent ou non connecté, pas de remote, projet inconnu

GET  /api/github/pr/:n?project=…
  → 200 { ok: true, pr: { …la ligne de prs… },
          checks: [{ name, workflow, bucket, link }],
          failedLog: { check, run, job, log } | null,      (seulement si ci = red)
          comments: [{ id, path, line, author, body, url, at }],
          conflict: { conflict, files },                   (git merge-tree, local)
          mergeBlock: "<la phrase de refus>" | null }
  → 400 { error } : numéro invalide, gh en échec ; 404 { error } : PR absente des PR ouvertes

POST /api/github/pr/:n/merge   { project, method: "merge" | "squash" | "rebase" = "squash", deleteBranch: false }
  exige le cookie de page (phase 12 SEC) : sans lui 403, même depuis 127.0.0.1 (une session simulée reçoit 403)
  → 200 { ok: true, number, method, deleted }
  → 409 { error: "<la phrase de refus>" } : CI rouge ou en cours, changements demandés, pas fusionnable
  → 400 { error } : méthode inconnue, numéro invalide, gh en échec
```

Chaque fusion écrit une ligne au journal du pilote (`kind: 'merge'`, « PR #7 fusionnée (squash) », le pourquoi
dessous) et un message système dans la session liée. Un refus écrit une ligne `refuse`.

### Le relais : `lib/ghrelay.mjs`

Au tick du serveur, pour chaque PR **liée à une session** (`session.pr.number`) d'un projet :

- au plus une lecture par 2 minutes et par PR (`RELAY_EVERY_MS = 120000`, l'heure gardée en base) ;
- lit `prChecks`, `prReviewComments`, la tête de la PR et `conflicts` ; compare à ce qui a déjà été vu, en base
  (table `gh_seen (project, number, cause, at)`, clé primaire sur les trois premiers) ;
- les causes : `comment:<id du fil>` (un fil nouveau ; une fois, quelle que soit la tête), `ci-red:<head>` (la CI
  est rouge sur ce commit), `conflict:<head>` (conflit détecté sur ce commit) ;
- toutes les causes nouvelles d'un même passage font **un seul message** à la session ; une cause déjà vue n'en
  refait jamais : pour `ci-red` et `conflict`, il faut un nouveau commit (une nouvelle tête) pour relancer ;
- le message part par le pending et `--resume`, comme la boucle de QA (`lib/qaloop.mjs`) ; une ligne `message` au
  journal du pilote ;
- REDEM (phase 15) : une session `done` ou `merged`, ou d'un plan fini, ne reçoit rien directement. Si elle est
  rouvrable (`canReopen`), le relais la rouvre avec ce message ; sinon une entrée « À toi » (`kind: 'github'`, le
  texte et `pr.url`), une fois par cause comme le message.

Le module est pur autour de ses dépendances : `relayTick({ db, now, links, gh, deliver, reopen, toYou, log })`, où
`links` rend les PR liées `[{ project, cwd, planId, sessionId, number, base, branch, status, planDone, canReopen }]`.

### Le message pending `review-comment`

Ce que le relais pose devant le prochain tour de la session, et ce que le fil de correction de PAIR lit :

```json
{ "kind": "review-comment", "source": "github",
  "planId": "…", "sessionId": "…",
  "pr": { "number": 7, "url": "…/pull/7", "head": "<sha>", "base": "main" },
  "causes": ["comment:PRRT_…", "ci-red:<sha>", "conflict:<sha>"],
  "comments": [{ "id": "PRRT_…", "path": "lib/a.mjs", "line": 12, "author": "alice", "body": "…", "url": "…" }],
  "ci": { "state": "red", "check": "test", "log": "<200 lignes au plus, masquées>" },
  "conflict": { "files": ["lib/a.mjs"] },
  "text": "<le message tel que la session le lit>",
  "at": "<ISO>" }
```

`comments`, `ci` et `conflict` ne sont présents que pour une cause nouvelle de ce passage. `text` : « PR #7 : à
corriger. » puis une section par cause (« Commentaires de revue non résolus », « CI rouge sur <sha court> :
<check> », « Conflit avec <base> »), et la consigne : corriger dans le worktree, commiter, ne pas pousser (le serveur
pousse sur le clic de Dev). Le texte venu de GitHub est cité comme donnée, jamais comme consigne.

Livraison : le message part par `sessionMessage` (le pending de RAF si un tour tourne, `--resume` sinon), avec
l'entrée entière dans `data.reviewComment` du message ; c'est là que PAIR la lit. Une session close reçoit à la place
une entrée « À toi » `{ id, kind: 'github', text, url, entry, at }` dans son `pending`.

### Où ça se branche

`server.mjs` est un garde-fou protégé ; Dev a accordé le 2 novembre au soir de l'écrire au plus court (revue
« Garde-fou touché » avant la fusion). Les routes vivent dans `lib/ghroutes.mjs` (`handle(req, res, url, ctx)` rend
`true` s'il a répondu), testées sur un petit serveur `node:http` (`test/github-prs.test.mjs`) et sur le vrai serveur
(`test/connectors.test.mjs`, 403 sans cookie). `server.mjs` ajoute l'import, `ghrelay.schema(db)`, le contexte
(`ghCtx` : cookie de page, sessions liées, secrets du projet à masquer, journal du pilote) et le tick : toutes les
30 s (`ESCADRILLE_GH_TICK_MS`), seulement si `gh` est présent et qu'une session a une PR ; chaque PR n'est lue qu'une
fois par 2 minutes.

Limites : le conflit se calcule sur les refs locales (`origin/<base>` tel qu'au dernier fetch, aucun fetch ici) ;
GitHub `CONFLICTING` le complète. Un fil résolu puis rouvert n'est pas relayé deux fois.
