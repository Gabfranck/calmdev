# La revue (phase 7, sessions R, S, Q, Y)

La demande de Dev (08:45–08:50, `docs/decisions.md`, « La revue et l'architecture ») : un outil de revue de PR
très proche de celui de GitHub mais plus simple, pour que le développeur ne s'épuise pas sous le code généré ; il
garde la carte de l'architecture et ses règles, il ne relit pas chaque ligne ; la génération suit ses règles, très
strictes ou full auto.

Ce fichier est **le contrat** que lisent S (la page « Files changed »), Q (la pré-revue) et Y (la carte de
l'architecture). Le serveur (R) le tient ; `test/review.test.mjs` le vérifie. Le code est dans `lib/review.mjs`
(le parseur, la base, les niveaux) et quelques routes dans `server.mjs`.

## Ce qu'est une revue

Une revue porte sur **une branche contre sa base dans un dépôt**, `base...head` (le diff depuis le point de
départ commun, comme une PR) :

- **une session d'un plan** : `head` = sa branche `escadrille/<plan>/<session>`, `base` = la branche d'où le
  worktree est parti (notée `worktree.base` au lancement ; pour un worktree d'avant, la branche courante du dépôt) ;
  `repo` = `worktree.root` ;
- **n'importe quelle paire** `base...head` d'un projet connu (`release/r01` contre `dev`, `design/teacher` contre
  `dev` dans Orchard), `repo` = la racine git du projet.

`id` = `sha1(repo + '\n' + base + '\n' + head)` en hexadécimal, les 16 premiers caractères. Stable : la même paire
rouvre la même revue, ses commentaires et ses cases « Vu ». `headSha` est le commit de `head` au moment de la
lecture ; la revue suit la branche, pas un commit.

## Les genres de revue (09:20, « Le flot du produit »)

Une revue porte un `kind` : `code` (le défaut, tout ce qui précède et suit), `image`, `doc`, `plan` ou `stop`.
`GET /api/review?…&kind=<kind>` ; sans `kind`, c'est `code`, avec le même `id` qu'avant : **rien ne change pour ce
que S lit déjà**. Un autre genre sur la même paire est une autre revue (`id` = `sha1(repo, base, head, kind)`), avec
son verdict et ses essais.

| `kind` | Ce qu'elle liste | Ajouts à la réponse |
| --- | --- | --- |
| `code` | tout le diff | rien |
| `image` | les `*.png` ajoutés, modifiés ou renommés de la branche | `files[].before`, `files[].after` |
| `doc` | les `*.md` ajoutés, modifiés ou renommés | idem, plus les hunks comme en code |
| `plan` | les `plans/*.json` ajoutés, modifiés ou renommés | idem |
| `stop` | le dernier `pending` de genre `reply` d'une session (`?plan=&session=&kind=stop`) | `stop` : l'entrée telle quelle (`{ id, stop, text, summary, at }`), `files: []`, `base`, `head`, `headSha` à `null` |

`before` et `after` sont des URL : `GET /api/review/:id/blob?path=<chemin>&side=old|new` rend le fichier lui-même
(`image/png`, `text/markdown`, `application/json`). `old` est lu par `git show <merge-base>:<chemin>` (l'avant que
compare `base...head`, l'ancien chemin pour un renommage) ; `new` à `headSha`. `before` vaut `null` pour un ajout ;
400 si l'on demande l'avant d'un ajout. Une revue d'arrêt est liée à une réponse : la suivante ouvre une autre revue.
Q et Y ne sont appelés que pour `code` ; `mergeAllowed` n'existe que pour `code` (null ailleurs).

Toute réponse de revue gagne `kind`, `retries` (les relances déjà faites), `retryMax` (le réglage du projet) et
`escalated` (vrai quand une relance a été refusée par le plafond : la décision revient au développeur).

## Le diff

`git diff --no-color --no-ext-diff -M --src-prefix=a/ --dst-prefix=b/ base...head`, parsé par le serveur, sans
dépendance. Un fichier :

```
{ path,                      // le chemin à head (à base pour un fichier supprimé)
  oldPath,                   // le chemin à base pour un renommage, sinon null
  status,                    // 'added' | 'modified' | 'deleted' | 'renamed'
  additions, deletions,      // lignes + et -
  binary,                    // true : pas de hunks, « Fichier binaire »
  generated,                 // lockfiles, snapshots, build/, dist/, *.min.*, *.map : replié par défaut
  collapsed,                 // null | 'large' (plus de 1 500 lignes de diff) | 'generated' : hunks à la demande
  viewed,                    // la case « Vu » (remise à false si le fichier a changé à head depuis)
  flagged,                   // null, ou la raison de Q / Y / L (« Domaine sous garde : auth/** »)
  hunks: [{ header,          // '@@ -12,7 +12,9 @@ function foo' tel quel
            oldStart, oldLines, newStart, newLines,
            lines: [{ kind: 'ctx' | 'add' | 'del', old, new, text, noEol? }] }] }
```

`old` et `new` sont les numéros de ligne de chaque côté (`null` du côté absent : `add` n'a pas de `old`, `del`
pas de `new`). `text` est la ligne sans son `+`, `-` ou espace. `noEol: true` sur la dernière ligne quand git
écrit `\ No newline at end of file`. Un fichier `collapsed` arrive avec `hunks: null` ; la page les demande à
`GET /api/review/:id/file?path=`.

**Générés** (motifs, sur le nom ou le chemin) : `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`,
`Cargo.lock`, `poetry.lock`, `composer.lock`, `Gemfile.lock`, `go.sum`, `*.snap`, `__snapshots__/`, `*.min.js`,
`*.min.css`, `*.map`, `dist/`, `build/`, `.next/`, `coverage/`.

## Les routes (du Mac seulement, comme tout ce qui n'est pas du téléphone)

```
GET  /api/review?project=<abs>&base=<branche>&head=<branche>
GET  /api/review?plan=<id>&session=<sid>
  → 200 { id, repo, project, plan, session, title, base, head, headSha, baseSha, level,
          files: [...], comments: [...], verdict, prereview, architecture, mergeAllowed }
  | 400 { error }  (branche inconnue, projet sans dépôt, session sans worktree)
GET  /api/review/:id                       la même chose pour une revue déjà ouverte
GET  /api/review/:id/file?path=<chemin>    → { path, hunks }  (le fichier replié, entier)
POST /api/review/:id/comment  { path, side: 'old'|'new', line, body }        → { ok, comment }
POST /api/review/:id/comment/:cid/resolve  { resolved?: true }              → { ok }
POST /api/review/:id/viewed   { path, viewed: true|false }                   → { ok }
POST /api/review/:id/submit   { verdict: 'comment'|'approve'|'changes'|'reject'|'retry', body, author? }
                              → { ok, sent, merged, escalated, retries, retryMax, mergeAllowed }
GET  /api/review/:id/blob?path=&side=old|new   le fichier lui-même (image, doc, plan)
GET  /api/reviews?project=<abs>            → { reviews: [...] }  (la file, triée)
```

- `title` : le nom de la session (`R · La revue`), sinon `head`.
- `level` : le niveau d'exigence du projet (plus bas).
- `verdict` : `null` ou le dernier `{ verdict, body, at, headSha }` ; un `approve` donné sur un autre `headSha` que
  l'actuel ne compte plus (la branche a bougé depuis) : `verdict.stale: true`.
- `prereview` : `null` tant que Q n'est pas fusionnée ; Q exporte `prereview({ repo, base, head, files })` de
  `lib/prereview.mjs` (async, rend `{ files: [{ path, flag, why }], summary }`), le serveur l'appelle s'il existe
  et recopie chaque `flag` dans `files[].flagged`.
- `architecture` : `null` tant que Y n'est pas fusionnée ; Y exporte `architectureDelta({ repo, base, head, files })`
  de `lib/architecture.mjs`, rendu tel quel.
- `mergeAllowed` : `{ allowed, why }` (voir les niveaux).
- Un commentaire : `{ id, review, path, side, line, body, author: 'dev'|'pilot'|'claude', at, resolved, headSha,
  snippet }`. `snippet` est la ligne commentée, lue au moment du commentaire (elle reste lisible si la branche
  bouge) ; `line` est le numéro du côté `side`. Une ligne hors du diff est refusée (400). `author` vaut `dev`
  depuis la page ; le pilote passe `author: 'pilot'` dans le corps.
- `submit` exige un `body` non vide pour `changes` et `comment` (comme GitHub) ; `approve` l'accepte vide.

## Les textes affichés (règle de Dev, 10:25)

Une ligne par élément (raison, risque, résumé), dix mots si possible, sans phrase d'introduction ; le détail au clic.
Le serveur s'y tient : `why` de `mergeAllowed` (« Approbation requise », « Branche modifiée après l'approbation »,
« Domaine sous garde : auth/** »), `flagged`, l'en-tête des messages aux sessions (« Revue : refusée. »). S et Q aussi.

## Le verdict, comme « Finish your review »

Trois choix, un corps :

- **Commenter** (`comment`) et **Demander des changements** (`changes`), sur une revue de session : le serveur
  envoie à la session un message, exactement comme `POST /api/plan/:id/session/:sid/message`, qui rassemble le
  corps puis chaque commentaire non résolu :

  ```
  Revue : changements demandés.

  <corps>

  - src/a.mjs:42 (`const x = foo()`) : <commentaire>
  - docs/b.md:7 (ancienne ligne, `texte supprimé`) : <commentaire>
  ```

  Une session arrêtée repart (comme un message) ; une session finie et fusionnée ne reçoit rien (`sent: false`).
  Sur une paire hors plan, rien n'est envoyé : le verdict est seulement noté.
- **Refuser** (`reject`) : motif obligatoire (400 sinon), envoyé à la session comme un message (« Revue : refusée. » puis le motif et les commentaires non résolus). Le travail n'est pas fusionné (en strict,
  seul un `approve` ouvre la fusion).
- **Relancer** (`retry`) : motif obligatoire ; la session reçoit « Revue : à refaire (n/max). » puis le motif (une session arrêtée repart, comme pour un message) ; `retries` augmente.
  Plafond : le réglage de projet `retryMax` (défaut 2, entier de 0 à 10). Au-delà, rien n'est envoyé, la revue
  prend `escalated: true` et passe **en tête de la file** : c'est au développeur. Tout autre verdict la désescalade.
  Le pilote passe `author: 'pilot'` ; la relance est faite pour lui.
- **Approuver une revue d'arrêt** : la session reçoit « Arrêt validé : continue. » (et le corps s'il y en a un).
- **Approuver** (`approve`) : rend la fusion possible quand le niveau l'exige. Une session au milieu d'un tour
  (`running`) garde « Approuver » seul. **Approuver et fusionner** (Dev, 6 novembre : « une décision, un geste ») : quand
  la session a fini son tour (`done`, ou `waiting` : elle attend le mot du développeur à son dernier arrêt, et
  l'approbation est ce mot), pas fusionnée et pas livrée en kit, la revue dit `mergeOnApprove: true`, le bouton principal devient
  « Approuver et fusionner » et envoie l'approbation d'un clic ; le serveur fusionne aussitôt par le chemin du bouton
  Fusionner du Flot (`mergeSession` : garde-fous, vie privée, niveau), en local seulement : rien n'est poussé, aucun
  appel à GitHub (le push reste `POST …/session/:sid/pr`, du développeur seul). Réponse `merged: true` ; une session
  `waiting` ainsi fusionnée passe `done`, sa question quitte « À toi » et son worktree est retiré. (Jusqu'au 6 novembre
  22:10, une session `waiting` gardait « Approuver » seul : APPS, FONT, ARCH et APP ont été approuvées sans être
  fusionnées.) Quand la fusion
  est impossible, l'approbation est gardée et la réponse porte `mergeBlocked: { kind, why }`, `kind` parmi `conflict`,
  `tests` (tests rouges sur ce commit), `guard` (garde-fou à accorder), `dirty` (changements non commités du dépôt sur
  les fichiers de la branche), `privacy`, `other` ; la page l'écrit en une ligne à côté du bouton, avec le geste qui
  débloque. Le bouton Fusionner du Flot reste pour qui n'ouvre pas la Revue.

## La barre de décision (phase 11, G)

Dev, 2 novembre, 01:10 : « j'ai beaucoup de mal à naviguer ». Les verdicts ne sont plus au pied d'un long rendu : une
barre collée au bas de l'écran (`.rv-bar`, `position: sticky; bottom: 0`) porte le fichier lu (« 3 / 7 · chemin »,
qui suit le défilement), « Précédent » et « Suivant », l'« Accepter · Refuser · Relancer » du document lu quand c'en est
un, et les trois verdicts : Commenter, Demander des changements, Approuver (le seul primaire de l'écran). Un verdict
ouvre « Terminer la revue » dans la barre, qui grandit vers le haut, son choix coché, le focus dans le champ ; Échap le
ferme et rend le focus au bouton. La ligne grise des touches part : `j` `k` `v` `c` et ↑ ↓ dans l'arbre sont dans
l'aide `?`. La file montre l'état de chaque revue en pastille (À relire, Commentée, Changements demandés, Approuvée).
Le repère d'un changement dans un rendu Markdown est une barre pleine hauteur à gauche, plus le ▪ qu'il dessinait
devant les titres courts.

Après « Envoyer la revue », la barre devient la réponse : la pastille du verdict (aussi dans l'en-tête), ce qui s'est
passé, puis « Revue suivante : … » (la première de la file encore à relire, focalisée) ou « Retour à la liste ». Dans la
file, « À relire » garde ce qui n'est pas approuvé sur son dernier commit ; le reste est replié dans « Relues · n » : c'est
là que finit la revue d'une session livrée en kit, que rien ne fusionne.

## Le résumé de fin et le fil (phase 16, PAIR)

Dev juge sur images : une session finie s'ouvre sur son résumé (`docs/sessions.md`, « Le résumé de fin ») et ses
captures, puis un fil où l'on écrit une correction qui la relance. REVUI construit l'écran depuis ce contrat.
`lib/donethread.mjs` tient les règles pures ; les routes sont dans `server.mjs`.

```
GET  /api/review/done?plan=<id>&session=<sid>
  → 200 { plan, session, title, status, done: null | { summary, journeys, tests, captures, at },
          captures: [{ path, url }], board: null | { path, url }, thread: [...] }
  | 404 { error }  (session inconnue)
GET  /api/review/thread?plan=<id>&session=<sid>     → { thread: [...] }
POST /api/review/thread  { plan, session, text, source?: 'qa', reopen?: true }
  → 200 { ok, entry, sent, held?, reopened? }  | 400 { error }  | 403 { error }
```

- `done: null` : la session n'a pas laissé de résumé ; la page garde l'affichage d'avant (exigence 6).
- `captures[].url` : `/api/review/done/file?plan=&session=&path=<chemin>`, le PNG lu dans le worktree, seulement sous
  `.escadrille/captures/` ou `.escadrille/qa/` (chemin réel, liens suivis), 404 sinon. `board` : la `planche.html`
  de `.escadrille/qa/*/` la plus récente du worktree, servie de même, ou `null`. Après une fusion le worktree
  disparaît : `url` vaut alors `null`, le chemin reste (le copier avant, `docs/flot.md`).
- Une entrée du fil : `{ id, source: 'dev' | 'qa' | 'github', author, body, path, line, url, at, sent, held }`.
  `path` et `line` : le fichier et la ligne d'un commentaire GitHub, sinon `null` ; `url` : le lien du commentaire
  GitHub, sinon `null`. Triées par `at`.

**Qui écrit.** `source: 'dev'` exige le cookie de garde de Dev (`docs/autonomy.md`) : une session sur 127.0.0.1 ne peut
pas écrire au nom de Dev (403). Sans cookie, seul `source: 'qa'` est accepté (le retour de la QA, `author: 'qa'`).

**GitHub.** Un message `review-comment` du connecteur (`docs/connectors.md`, `{ type: 'review-comment', body, path,
line, author, url, at }` ; `user.login`, `html_url`, `created_at`, `original_line` de l'API sont lus aussi) entre dans le
fil avec `source: 'github'`, son fichier et sa ligne, par deux portes :

- dans le serveur, `threadGithub(message)` (exporté de `server.mjs`) : la session est trouvée par `plan` et `session`,
  sinon par sa branche (`head` ou `branch`), sinon par sa PR (`pr`) ; rend l'entrée, ou `null` ;
- `POST /api/review/thread { plan, session, type: 'review-comment', … }`, avec le cookie de Dev seulement.

Rien n'est relancé pour un commentaire GitHub (`sent: false`) : Dev le reprend d'un clic (« Relancer avec ce
commentaire » = un `POST` `dev` qui le cite).

**La relance.** Le texte part comme `POST …/session/:sid/message` (même file, même reprise `--resume` d'un
processus arrêté), avec le texte en tête :

```
<texte>

— fil de la Revue (Dev)        ou (QA)
```

- Un message envoyé pendant un tour attend la fin du tour (la file de la phase 14) : `held` le dit, l'entrée est
  écrite dans le fil avant l'envoi, jamais perdue (tenu par `test/donethread.test.mjs`).
- Une session `done` ne reçoit rien sans `reopen: true` **et** le cookie de Dev : elle repasse `waiting` puis
  `running`, et `reopened: true`. Fusionnée (`worktree.merged`), elle ne se rouvre pas : 400 « Session fusionnée :
  ouvre une nouvelle session ». Un retour `qa` sur une session `done` est gardé dans le fil (`sent: false`), il
  attend le clic de Dev.

Exemple rendu par `GET /api/review/done` :

```json
{ "plan": "2026-11-02-phase-16-une-seule-fenetre-et-les", "session": "PAIR", "title": "PAIR · Le résumé de fin", "status": "done",
  "done": { "summary": "Le résumé de fin entre dans le bloc state. La Revue le montre avec un fil. Une correction relance la session.",
            "journeys": ["Revue › une session finie", "Revue › le fil"],
            "tests": ["validateDone tronque un résumé trop long", "un message du fil pendant un tour attend"],
            "captures": [".escadrille/captures/1-localhost-3078-review/1440.png"], "at": "2026-11-02T15:10:00.000Z" },
  "captures": [{ "path": ".escadrille/captures/1-localhost-3078-review/1440.png",
                 "url": "/api/review/done/file?plan=2026-11-02-phase-16-une-seule-fenetre-et-les&session=PAIR&path=.escadrille%2Fcaptures%2F1-localhost-3078-review%2F1440.png" }],
  "board": null,
  "thread": [{ "id": 1, "source": "github", "author": "octocat", "body": "Ce nom ne dit rien.", "path": "lib/blocks.mjs", "line": 172,
               "url": "https://github.com/…#discussion_r1", "at": "2026-11-02T15:20:00.000Z", "sent": false, "held": false },
             { "id": 2, "source": "dev", "author": "Dev", "body": "Renomme en validateDone.", "path": null, "line": null,
               "url": null, "at": "2026-11-02T15:21:00.000Z", "sent": true, "held": false }] }
```

Table : `review_thread (id integer primary key autoincrement, plan, session, source, author, body, path, line, url,
at, sent integer, held integer)`.

## Les niveaux d'exigence (réglage par projet `review`)

Deux réglages dans `SETTING_KEYS` : `retryMax` (plus haut) et `review: 'strict' | 'guided' | 'auto'`, défaut `guided`
(`GET|POST /api/project/settings`, comme les autres ; une autre valeur : 400).

| Niveau | Fusion d'une session | Ce que voit le développeur |
| --- | --- | --- |
| **Strict** | jamais sans un `approve` du développeur sur le `headSha` actuel ; `POST …/merge` rend 409 `{ error: 'Approbation requise', review: id }` ; le bouton Fusionner le dit | la revue en tête de À faire |
| **Guidé** (défaut) | sans `approve`, au bouton, comme avant ; une session qui touche un domaine sous garde (L, vague 2) repasse en strict | la revue s'ouvre en tête de À faire, les fichiers signalés par Q et le delta d'architecture de Y en premier |
| **Auto** | le serveur fusionne quand la session dit `done` (ses tests verts, comme cette nuit), comme `autoMerge` | la revue reste lisible après coup, rien n'attend |

`mergeAllowed(project, plan, session)` est exporté de `lib/review.mjs` (via le serveur qui lui passe sa base) et rend
`{ allowed, level, why }`. `mergeSession` le consulte avant toute fusion, celle du bouton comme celle de
`autoMerge`. Les tests rouges ne se règlent pas : ce garde-fou reste celui du pilote.

**Le point d'appel de L** (`lib/autonomy.mjs`, vague 2, non touché ici) : `lib/review.mjs` importe, s'il existe,
`guardedPaths(project)` de `lib/autonomy.mjs` (rend une liste de motifs glob `['auth/**', 'db/migrations/**']`) ;
un fichier du diff qui y correspond met `flagged: 'domaine sous garde : <motif>'` et fait passer la revue en strict.
Tant que L n'existe pas, aucun domaine n'est gardé.

## La file de revue

`GET /api/reviews?project=` → les revues ouvertes du projet :

- chaque session d'un plan du projet qui a un worktree non fusionné et au moins un commit d'avance sur sa base ;
- chaque paire ouverte à la main (déjà vue par `GET /api/review`) dont le dernier verdict n'est pas un `approve`
  à jour.

Une entrée : `{ id, title, plan, session, base, head, level, guarded, files, additions, deletions, viewed,
comments, verdict, waitingSince, kind, escalated, retries }` (`files` le nombre de fichiers, `viewed` combien sont vus, `comments` combien
ne sont pas résolus, `waitingSince` l'ISO du dernier commit de `head`). Les revues d'un autre genre n'y entrent qu'escaladées. **L'ordre** : les escaladées, puis ce qui bloque
(niveau strict, puis domaine sous garde), puis la plus petite (additions + suppressions) : une petite revue se
vide vite et dégage la file.

## Les tables

```sql
create table reviews (id text primary key, repo text, project text, base text, head text, plan text, session text,
                      head_sha text, verdict text, body text, verdict_sha text, verdict_at text, created text, at text,
                      kind text default 'code', retries integer default 0, escalated integer default 0, stop text);
create table review_comments (id integer primary key autoincrement, review text, path text, side text, line integer,
                              body text, author text, at text, resolved integer default 0, head_sha text, snippet text);
create table review_viewed (review text, path text, blob text, at text, primary key (review, path));
```

« Vu » retient le blob du fichier à `head` (`git rev-parse head:path`, ou `deleted`) : si le fichier change à
`head`, le blob diffère et la case se décoche seule, comme sur GitHub.

## Essai sur Orchard (lecture seule)

Le 1er novembre, serveur de test sur le port 3095 (base jetable), `release/r01` contre `dev` dans
`~/Dev/Orchard/Orchard-v2/Orchard-docker-api`. Le serveur n'y lance que `git diff`, `rev-parse`,
`rev-list` et `log` ; `git status` reste vide après l'essai.

```
GET /api/review?project=…/Orchard-docker-api&base=dev&head=release/r01   (128 ms à chaud)
{ "id": "23fbd063c43d9e31", "base": "dev", "head": "release/r01", "headSha": "45b1964d06…", "level": "guided",
  "verdict": null, "prereview": null, "files": 19, "additions": 1113, "deletions": 70, "hunkLines": 1487 }
```

Les mêmes chiffres que `git diff --shortstat dev...release/r01` (19 fichiers, +1113, −70). Les fichiers :

| Statut | Fichier | + | − | Hunks |
| --- | --- | --- | --- | --- |
| modifié | server/domains/groups/services/groupGameModes.service.ts | 6 | 4 | 2 |
| ajouté | server/domains/questions/\_\_tests\_\_/emptyAnswers.int.test.ts | 362 | 0 | 1 |
| ajouté | server/domains/questions/\_\_tests\_\_/teacherQuestionsSort.int.test.ts | 147 | 0 | 1 |
| modifié | server/domains/questions/controllers/ (8 contrôleurs) | 36 | 19 | 27 |
| modifié | server/domains/questions/services/listQuestions.ts | 49 | 5 | 4 |
| ajouté | server/domains/questions/services/questionValidation.test.ts | 145 | 0 | 1 |
| modifié | server/domains/questions/services/questionValidation.ts | 50 | 9 | 4 |
| ajouté | server/domains/quests/\_\_tests\_\_/dailyQuests.int.test.ts | 180 | 0 | 1 |
| modifié | server/domains/quests/controllers/listUserDailyQuests.ts | 16 | 2 | 3 |
| modifié | server/domains/quests/services/dailyQuests.service.ts | 109 | 30 | 3 |
| modifié | server/domains/userStats/models/UserAnswers.model.ts | 6 | 0 | 1 |
| modifié | server/scripts/addStatsIndexes.ts | 7 | 1 | 2 |

La file (`GET /api/reviews?project=…`) rend cette paire seule : `{ files: 19, additions: 1113, deletions: 70,
viewed: 0, comments: 0, verdict: null, waitingSince: "2026-11-01T06:34:06+01:00" }`. Rien n'est replié (aucun
fichier généré, aucun au-delà de 1 500 lignes). Le JSON complet se rejoue avec la même requête.

Note pour les sessions : dans le bac à sable de Claude Code, `node` ne trouve pas `git` si le `PATH` passe par un
dossier refusé (`spawnSync git EPERM`) ; `PATH=/usr/bin:/bin:$PATH` avant `node --test` règle ça.
