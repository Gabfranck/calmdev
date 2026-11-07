# La lecture frugale du planificateur

Le skill de planification dit : « n'ouvre pas un fichier de plus de 300 lignes en entier ; n'ouvre ni
images, ni transcriptions, ni données ». La session de planification ne le respectait pas : 363 000
tokens pour poser les questions de la phase 3. La règle tient maintenant par l'outil : un hook
PreToolUse de Claude Code refuse la lecture et dit quoi faire à la place.

## La règle

Un `Read` est refusé quand :

- le fichier a plus de 300 lignes et le `Read` n'a pas de `limit` (ou un `limit` > 300) ;
- c'est une image ou un PDF (`.png .jpg .jpeg .gif .webp .pdf`), une transcription (`.jsonl`), une
  base (`.sqlite .sqlite3 .db`) ;
- le fichier pèse plus de 200 Ko (même avec `limit`).

Le refus dit le nombre de lignes du fichier, propose `offset` et `limit` (300 au plus) ou un `Grep` de
ce qui touche à l'idée. Tout le reste passe. Un fichier absent passe (le `Read` dira lui-même qu'il
n'existe pas) ; une entrée illisible passe aussi : le hook économise des tokens, ce n'est pas un verrou.

## Le hook

- `lib/frugal.mjs` : `decide({ file_path, offset, limit }, cwd)` → `{ allow }` ou `{ allow: false, reason }`.
  Les lignes se comptent par morceaux de 64 Ko (`countLines`), jamais le fichier entier en mémoire, et
  seulement si le `Read` n'a pas déjà un `limit` ≤ 300. `FRUGAL_SETTINGS` est le fragment de settings ;
  `withFrugal(settings)` l'ajoute à d'autres settings en gardant leurs hooks.
- `lib/frugal-hook.mjs` : lit le JSON du hook sur stdin, appelle `decide`, et sur un refus écrit
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`
  avec le code de sortie 0. Sur une lecture permise il n'écrit rien : répondre `allow` ferait sauter
  les règles de permission de la session (`.env` refusé, lectures hors du dossier).
- La commande du hook est `"<process.execPath>" "<chemin absolu de lib/frugal-hook.mjs>"` plutôt
  qu'un `node` nu : le hook ne dépend pas du PATH qu'hérite la session (dans le bac à sable de cette
  session, `node` du PATH est un v14).

Claude Code 2.1.316 : la doc des hooks n'est pas lisible hors ligne (binaire natif), la forme JSON a
été vérifiée par l'essai ci-dessous. Un hook passé dans `--settings '<json>'` tourne : pas besoin de
fichier temporaire ni de `.claude/settings.json` dans le projet planifié.

Tests : `node --test test/frugal.test.mjs` (8 verts : 301 lignes sans limit refusé, avec limit 100
passe, image / .jsonl / .sqlite / > 200 Ko refusés, petit fichier passe, chemin relatif résolu sur
`cwd`, fusion des hooks, le script en sous-processus avec un JSON sur stdin).

## La preuve

`claude -p` avec les arguments de `startPlanner` (`--input-format stream-json --output-format
stream-json --verbose --permission-mode dontAsk --allowedTools Read Glob Grep 'Bash(git log:*)' …
--settings <SANDBOX_SETTINGS + FRUGAL_SETTINGS>`), modèle `claude-sonnet-5-5`, prompt : « Lis
public/plan.html en entier, puis dis en une phrase ce que contient la page. » (`public/plan.html` :
552 lignes). Les lignes du flux, coupées :

```
tool_use    Read {"file_path":".../public/plan.html"}
tool_result is_error "PreToolUse:Read hook error: Lecture refusée par Escadrille : .../public/plan.html
            a 552 lignes, plus de 300. Lis seulement la partie utile avec offset et limit (limit 300
            au plus, par exemple offset 1 limit 60 pour l'en-tête), ou Grep ce qui touche à l'idée."
text        "Le hook limite chaque lecture à 300 lignes. Je lis donc la page en deux morceaux."
tool_use    Read {"file_path":".../public/plan.html","offset":1,"limit":300}
tool_result "1\t<!doctype html>\n2\t<html lang=\"fr\">…"
tool_use    Read {"file_path":".../public/plan.html","offset":301,"limit":252}
tool_result "301\t    if (code !== null) …"
result      4 tours, input 6 + cache_creation 67 037 + cache_read 62 621, output 668, 0,28 $
```

Le refus marche et la session relit avec `offset`/`limit`. Mais une session à qui l'on demande
« en entier » découpe le fichier et lit tout quand même : le hook rend la lecture complète
délibérée, il ne l'interdit pas. La mesure ci-dessous dit si ça suffit quand personne ne le demande.

C'est un garde-fou, pas un mur : chaque refus rappelle le but (« Un plan vaut par ses questions, pas
par la quantité lue : ne lis que ce qui touche à l'idée »), mais une session décidée à tout lire le
peut, 300 lignes à la fois.

## La mesure

L'avant : la planification de la phase 3 (escadrille `phase-3-les-sessions-7e93`, Fable 5.1, sans
hook), jusqu'à la première réponse avec les questions, comptée dans sa transcription par
`message.id` : 7 appels au modèle, 21 outils, input 194 + cache_creation 70 942 + cache_read 292 103
= **363 239** tokens lus, output 12 335. Ses `Read` : ROADMAP.md, README.md, trois fichiers de
mémoire et lib/planner.mjs en entier (tous sous 300 lignes), public/plan.html (offset 275 limit 4,
puis 334/12), un fichier de launch/ (14/13), server.mjs (100/60). Elle lisait déjà par morceaux :
le hook n'y aurait rien refusé. Les 363 k sont surtout le contexte relu à chaque appel
(cache_read : 80 %), pas un gros fichier.

Premier essai d'après (2026-11-01, Fable 5.1, même prompt d'idée, même skill en
`--append-system-prompt`, hook branché, dans ce worktree) : 9 tours, input 98 + cache_creation
41 485 + cache_read 135 422 = 177 005, output 4 210, 1,08 $. Lus : ROADMAP.md, README.md,
docs/frugal.md, docs/sessions.md (limit 60), deux Grep dans plans/. **Aucun refus du hook.**
**Ce chiffre ne compte pas** : la session a vu que la phase 3 était déjà faite et fusionnée, et ses
questions demandent s'il s'agit d'une mesure. Elle a moins lu parce qu'il n'y avait rien à planifier,
pas grâce au hook.

## Le levier : le rythme, pas la taille

Ce qui coûte, c'est le nombre d'allers-retours avant les questions : chaque appel au modèle relit
tout le contexte (skill, CLAUDE.md, tout ce qui a été lu). 7 appels pour 21 outils, c'est 7 relectures
d'un contexte qui grossit. Le hook reste en garde-fou ; la règle qui porte est dans le skill
(`.claude/skills/plan/SKILL.md`, section 1, « Le rythme ») : lire en un ou deux tours au plus,
plusieurs `Read`, `Grep` et `ls` lancés ensemble dans le même tour, décidés d'avance depuis
`CLAUDE.md` et la structure, puis poser les questions ; viser moins de 4 appels au modèle avant les
questions, et demander ce qu'on n'a pas lu.

Ce qui reste trop lu dans l'avant : trois fichiers de mémoire que les consignes résument déjà, et
des lectures de quelques lignes (plan.html 275/4, 334/12) qui coûtent chacune un appel. Si la
phase 5 dépasse encore 4 appels, l'étape suivante est de donner au planificateur, dans le prompt
système, la structure du dépôt (`ls`, `git log --oneline -15`, `wc -l` des fichiers cités par
CLAUDE.md) pour que son premier tour soit déjà le tour de lecture.

## La mesure d'après : la prochaine planification réelle

Pas de seconde planification payée pour la mesure : la prochaine planification réelle (phase 5) sert
d'« après ». Méthode, pour F ou Dev, une fois qu'elle a posé ses questions :

1. Son `session_id`, en lecture seule :
   `node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("sessions.sqlite",{readOnly:true});console.log(db.prepare("select id,session_id from escadrilles where title like ?").get("Phase 5%"))'`
2. Le compte du premier tour (usage compté une fois par `message.id`, jusqu'au deuxième prompt) et
   la liste des `Read` : `node lib/frugal.mjs ~/.claude/projects/-Users-gab-Dev-escadrille/<session_id>.jsonl`
3. Le coût : `usage` de l'escadrille dans la même table, ou les tokens × les prix de `lib/usage.mjs`
   (Fable : 10 $ / M en entrée, 50 $ / M en sortie, cache lu ×0,25… voir `PRICES`).
4. Remplir la ligne ci-dessous.

| | Avant (phase 3, sans hook ni rythme) | Après (phase 5, hook + rythme) |
|---|---|---|
| Tours avant les questions | (non relevé) | 1 |
| Appels au modèle avant les questions | 7 | non relevé |
| Outils | 21 | 4 (les 4 `Read`) |
| Tokens lus (input + cache_creation + cache_read) | 363 239 | 219 069 (−40 %) |
| Output | 12 335 | non relevé |
| Refus du hook | (pas de hook) | non relevé |
| Fichiers lus | 10 `Read` (voir plus haut) | 4 `Read` |

Mesure « après » relevée le 2026-11-01 sur la planification de la phase 5 (« le téléphone en trois »),
avec la méthode ci-dessus, et donnée à la session C : 219 069 tokens lus en 4 lectures et 1 tour avant
les questions. Les cases « non relevé » n'ont pas été transmises ; la session C ne lit pas les
transcriptions (`~/.claude/projects` est hors de son bac à sable). L'ordre de grandeur est là : 5 fois
moins d'outils, 40 % de tokens en moins, sur un projet plus gros qu'en phase 3. 4 lectures, c'est
le seuil fixé plus haut : l'étape « structure du dépôt dans le prompt système » n'est pas nécessaire
pour l'instant.

L'idée n'est pas la même, le projet a grandi : la comparaison vaut pour l'ordre de grandeur et le
nombre d'appels, pas au token près.

## Le contexte fixe (phase 14, session FIX)

Ce qui coûte dans une conversation de pilote ou une session, c'est ce que **chaque appel relit avant tout
travail** : le prompt système et les outils, CLAUDE.md, MEMORY.md, la liste des skills, la consigne des
sessions, le prompt du plan. calmdev le mesure maintenant, et le dit.

### La mesure

Le premier appel au modèle d'une transcription n'a encore rien lu : son `usage` (`input_tokens` +
`cache_creation_input_tokens` + `cache_read_input_tokens`) est exactement le contexte fixe de la session.
`lib/usage.mjs` (`parseTranscript`) le garde dans `first` (`{ input, cacheWrite, cacheRead, context, model, at }`,
le premier message `assistant` hors sidechain) ; `GET /api/usage` le rend par session (`firstContext`).

`lib/context.mjs` (`fixedContext`) en tire, par projet (même dépôt, worktrees compris) : la **médiane du premier
appel des sessions des 7 derniers jours** (`tokens`), la médiane des 7 jours d'avant (`before`), la croissance
(`growth` = tokens ÷ before − 1) et l'**alerte** au-delà de +20 % (`alert`, `threshold: 0.2`). Un projet trop jeune
pour avoir une semaine d'avant compare avec les sessions de son premier jour (`since` dit la date). Une seule session
donne le chiffre sans croissance ; aucune transcription donne `null`, jamais 0.

`contextPieces` trouve sur le disque ce que ce premier appel contient, en caractères et en tokens estimés à
**4 caractères par token** (un ordre de grandeur, dit comme tel) : CLAUDE.md du projet (et `~/.claude/CLAUDE.md`),
`MEMORY.md` du projet (`~/.claude/projects/<dossier>/memory/MEMORY.md`), la **liste** des skills (nom et description
de chaque SKILL.md de `~/.claude/skills`, des plugins installés et de `.claude/skills` du projet : c'est ce que le
prompt système porte ; le corps n'est lu qu'à l'appel), le prompt médian des sessions du projet (plan et consigne,
`promptChars`), et `rest` : ce que le premier appel contient en plus (prompt système, outils, ce que Claude Code
ajoute : les skills intégrés, les rappels système).

### L'écran

L'écran Apprentissage (`/learning`) a une seule ligne repliée, au-dessus des préférences :
« **Contexte fixe : 41 k tokens par appel, +12 % depuis 7 jours** » (ou « depuis le 31 oct. » sur un projet jeune).
Au-delà de +20 %, la ligne porte une pastille rouge « plus de 20 % de hausse ». Ouverte : les morceaux trouvés sur
le disque, un par ligne, la base de la médiane, la dernière session. `GET /api/learning` rend tout ça dans `context`
(le pilote peut le lire). Rien n'est lancé, rien n'est dépensé : les transcriptions sont déjà lues pour l'estimation.

### Ce que ça pèse sur calmdev, chiffré le 2 novembre 2026

Mesuré depuis le worktree de la session FIX (`lib/context.mjs` sur ce dépôt, les plans de `plans/`, les fichiers) ;
les tokens sont des caractères ÷ 4, sauf mention. Le total réel du premier appel se lit sur l'écran, sur le Mac
(la transcription n'est pas lisible depuis le bac à sable).

| Morceau | Chiffre | Par appel, estimé | Qui le relit |
|---|---|---|---|
| CLAUDE.md | 2 671 caractères | 0,7 k tokens | toutes les sessions et le pilote |
| MEMORY.md (l'index seul, 27 lignes) | ≈ 5 400 caractères | ≈ 1,4 k tokens | toutes les sessions sur ce Mac |
| Liste des skills sur le disque | 35 skills, 7 939 caractères de nom + description (corps : 630 000, non chargés) | 2,0 k tokens | toutes les sessions |
| Skills intégrés à Claude Code (dataviz, code-review, anthropic-skills:*, hyperframes…) | une soixantaine d'entrées dans le prompt système de cette session | ≈ 3 à 5 k tokens (non mesurable sur le disque : dans `rest`) | toutes les sessions |
| Consigne des sessions (`stateInstruction`, server.mjs) | 1 871 caractères | 0,5 k tokens | chaque session planifiée |
| Prompt de la session FIX (phase 14) | 1 969 caractères | 0,5 k tokens | cette session |
| Prompts de la phase 13 | 6 sessions, 24 642 caractères, médiane 3 400 | 0,9 k tokens par session | chacune |
| … dont le paragraphe « Contexte (Dev, 2 novembre 2026) » répété tel quel | 996 caractères × 5 sessions | 0,25 k tokens par session, 1,0 k en tout | cinq fois |
| Skill de planification (`.claude/skills/plan/SKILL.md`, `--append-system-prompt`) | 16 084 caractères | 4,0 k tokens | chaque planification et chaque distillation |
| Prompt système du pilote (`lib/pilot.mjs`) + mémoire du projet (40 dernières lignes de `docs/decisions.md`) | 1 850 + 15 258 caractères | 0,5 k + **3,8 k** tokens | chaque réveil du pilote |

Et ce que CLAUDE.md fait **lire** à chaque session avant de coder, qui reste ensuite dans sa fenêtre et se relit à
chaque appel : `docs/flot.md` 12 386 caractères (3,1 k tokens), `ROADMAP.md` 16 862 (4,2 k), `docs/decisions.md`
**117 195 caractères (29 k tokens, 497 lignes)**, `docs/sessions.md` 50 434 (12,6 k). Une session qui obéit à la
lettre (« lire docs/decisions.md avant de proposer ») part avec 40 à 50 k tokens de docs dans chaque appel, dix fois
le reste du contexte fixe.

### Les pistes de coupe, chiffrées, pas appliquées (Dev choisit)

1. **`docs/decisions.md` lu en entier** : 29 k tokens par appel pour la session qui l'ouvre. Piste : garder les
   décisions du mois en tête du fichier (ou un `docs/decisions-recentes.md` de 40 lignes, ≈ 3,8 k tokens) et
   archiver le reste ; CLAUDE.md pointe vers le court. Gain : ≈ 25 k tokens par appel, soit, sur une session de
   40 appels en Fable (cache lu à 2,50 $ / M), **≈ 2,5 $ par session**. Même piste pour le pilote, qui reçoit les
   40 dernières lignes (15 k caractères) à chaque réveil : des lignes de 100 caractères au lieu de 380 ramèneraient
   3,8 k à 1 k tokens.
2. **Le paragraphe de contexte répété dans les prompts d'un plan** (phase 13 : 996 caractères × 5). Piste : le
   planificateur l'écrit une fois dans `goal` du plan et le serveur l'ajoute au prompt de chaque session, ou chaque
   prompt ne garde que ce qui le concerne. Gain : 0,25 k tokens par appel et par session ; petit (≈ 0,02 $ par
   session de 40 appels), mais c'est le signe d'un prompt écrit pour le lecteur humain, pas pour la session.
3. **La liste des skills** : 35 skills sur le disque, dont 21 de hyperframes (vidéo), 11 de stripe, logo-design,
   shadcn, taste-skill, frontend-design, 2,0 k tokens à chaque appel de chaque session, plus la soixantaine
   d'entrées intégrées. Une session de calmdev n'en appelle qu'un ou deux (`plan`, `taste-skill` pour un écran).
   Piste : désinstaller les plugins qui ne servent pas à ce Mac (hyperframes et stripe : ≈ 1,6 k tokens, 80 % de la
   liste sur le disque), ou les garder dans un profil à part. Gain : ≈ 1,6 k tokens par appel, **≈ 0,16 $ par
   session de 40 appels**, et autant par réveil du pilote.
4. **MEMORY.md** : 27 lignes, ≈ 1,4 k tokens par appel ; plusieurs entrées sont des comptes rendus de nuits
   (« Night 2026-11-01 outcome », « Run 08:40 ») que `docs/decisions.md` tient déjà. Piste : ne garder que les règles
   de travail (une douzaine de lignes, ≈ 0,6 k tokens). Gain : ≈ 0,8 k tokens par appel, ≈ 0,08 $ par session.
5. **CLAUDE.md** : 0,7 k tokens, déjà court ; la coupe n'est pas là, c'est ce qu'il fait lire (piste 1).
6. **Le skill de planification** : 4 k tokens par appel du planificateur et de la distillation. La distillation
   (Sonnet, 1 $) n'en a besoin que pour la section « Ce qu'Escadrille a appris » : lui passer les 30 lignes utiles
   plutôt que le skill entier. Gain : ≈ 3,5 k tokens par appel de distillation.

Ce qui ne bouge pas tant que la mesure d'après n'est pas faite : la ligne de l'écran dit le chiffre avant, et le
redira après chaque coupe. La règle de la phase : **un gain non mesuré ne compte pas**.

## Pour la session F : brancher le hook dans startPlanner

Dans `lib/planner.mjs`, `import { withFrugal } from './frugal.mjs';` puis :

```js
export const startPlanner = (opts) => startSession({ allowedTools: READ_ONLY_TOOLS, permissionMode: 'dontAsk', permissionPrompt: false, settings: withFrugal(SANDBOX_SETTINGS), ...opts });
```

`withFrugal(SANDBOX_SETTINGS)` vaut `{ ...SANDBOX_SETTINGS, ...FRUGAL_SETTINGS }` aujourd'hui
(SANDBOX_SETTINGS n'a pas de hooks), et garde les hooks des deux si SANDBOX_SETTINGS en reçoit un
jour. Les sessions de travail (`startSession`) ne prennent pas le hook : elles ont le droit de lire
un fichier entier pour le modifier.

## Les rafales (phase 14, session RAF)

Chaque tour relit tout le contexte. Trois messages écrits pendant un tour coûtent trois tours s'ils partent
un par un, un seul s'ils partent ensemble ; trois événements à une minute d'écart réveillent le pilote trois
fois, ou une seule.

### Ce qui marchait déjà (vérifié le 2 novembre)

- **Le pilote** : un message de Dev arrivé pendant un tour est retenu (`pilotHeld` dans `server.mjs`) et
  part en tête du réveil suivant, avec tous les autres : un seul réveil (`createWaker` : `again`, un réveil à
  la fois par projet). Le fil le dit par une ligne système (`msgtriage.busyLine`), maintenant : « ton message
  part avec ceux qui attendent, en un seul réveil à la fin de ce tour ».
- **Les sessions de plan : non.** `lib/planner.mjs` met en file ce qui arrive pendant un tour et l'envoie
  **un message par tour** (`state.queue.shift()`) : quatre messages pendant un tour, quatre tours.
- **Les réveils du pilote** : chaque événement (arrêt, fin, alerte) réveille après 1,5 s de calme
  (`ESCADRILLE_PILOT_DEBOUNCE_MS`) ; deux événements à une minute d'écart, deux réveils.

### Ce que fait la phase 14

- `lib/coalesce.mjs` : `joinMessages` fait un seul tour de plusieurs messages (« 3 messages arrivés pendant
  ton tour, envoyés ensemble : réponds à tous dans ce tour », puis `### Message 1`…) ; un seul message
  reste tel quel. `createInbox` est la même boîte aux lettres pour un autre processus.
- `lib/pilot.mjs` `createWaker` : `wake(project, { urgent: false })` pour un événement attend 2 min 30 de
  calme (`eventWindowMs`), jamais plus de 10 min après le premier (`eventMaxMs`) ; `wake(project)` reste
  urgent (un message de Dev : 1,5 s, et il emporte les événements qui attendent) ; `now(project)` part tout
  de suite. `eventWindowMs` 0 garde l'ancien comportement (c'est le défaut de la fonction).
- **Le branchement** (`lib/planner.mjs`, `server.mjs`, protégés à la fusion : revue du pilote ; le diff posé reste dans
  `docs/phase14/raf-protege.diff`) :
  `docs/phase14/raf-protege.diff`, pas posé, pour la revue de Dev. Il fait :
  - `planner.mjs` : `flush` envoie `joinMessages(state.queue.splice(0))` (tout ce qui attend, en un tour) ;
    `p.held` (combien attendent) ; `p.interrupt()` (un `control_request` `interrupt` du flux stream-json).
  - `server.mjs` : un message de session écrit pendant un tour ajoute la ligne « En attente de la fin du
    tour : N messages partiront ensemble. « Envoyer maintenant » coupe le tour. » ;
    `POST /api/plan/:id/session/:sid/now` coupe le tour ; `POST /api/main/now { project }` coupe le tour du
    pilote ou réveille tout de suite ce qui attend sa fenêtre ; `pilotHook` passe `{ urgent: false }` ;
    `ESCADRILLE_PILOT_EVENT_WINDOW_MS` (150 000 par défaut, 0 dans les tests serveur).
  - Tests : `test/rafale-session.test.mjs` (quatre messages dont trois pendant le premier tour : deux tours ;
    « Envoyer maintenant » coupe le tour), `coalesce`, `planner`, `pilot`, `pilot13`, `measure-rafale`.
  - **Pas vérifié** : que le vrai Claude Code 2.1.316 accepte `{"type":"control_request","request":{"subtype":"interrupt"}}`
    sur stdin et termine le tour par un `result` (c'est le protocole du SDK ; le faux `claude` des tests le
    simule). Un tour coupé finit en `error_during_execution` : la page dira « la session a échoué » une fois.
  - Reste : le bouton « Envoyer maintenant » dans le fil (Conversation et page du plan), sur
    la ligne d'attente, qui appelle ces deux routes ; il passe par l'écran et sa capture.

### La mesure (2 novembre, relevée par le pilote hors du bac à sable)

`scripts/measure-rafale.mjs` rejoue sur le papier, en lecture seule (base ouverte `readOnly`) :

- A. les conversations Claude Code de Dev dans `~/.claude/projects/-Users-gab-Dev-escadrille/`
  (entrypoint `cli`) du 1er et du 2 novembre : un tour va d'un message de Dev à la réponse dont le
  `stop_reason` le ferme ; un message écrit pendant un tour est en rafale ; un par un il coûte un tour,
  groupés tous ceux d'un même tour en font un. Tokens évités : contexte médian du premier appel d'un tour ×
  tours évités ; dollars au prix du cache lu (`lib/usage.mjs`) ;
- B. les sessions de plan : les messages du développeur de `session_messages` contre les tours de leur transcription ;
- C. les réveils du pilote du 2 novembre : les événements du journal (`eventsOf`, filtre « travaille encore »
  de la phase 13), urgents quand c'est un message de Dev, 1,5 s contre la fenêtre de 2 min 30.

Commande : `node scripts/measure-rafale.mjs > .escadrille/rafale.json` (le JSON n'est pas commité).

| | Avant | Après | Gain |
|---|---|---|---|
| Conversations du pilote (6, Opus 5.5) : messages de Dev | 344 | — | — |
| dont écrits pendant un tour | 50 | — | — |
| Tours (un par message → groupés) | 344 | 323 | **21 tours (−6 %)** |
| Contexte relu évité (médiane du premier appel × tours évités) | — | — | 7,34 M tokens |
| Sessions de plan (124 sessions, 1er-2 nov.) : messages du développeur | 480 (141 pendant un tour) | — | — |
| Tours des sessions de plan | 480 | 453 | **27 tours (−6 %)**, 5,21 M tokens relus |
| Réveils du pilote le 2 novembre (287 événements, 29 messages, 2 projets) | 249 | 110 | **139 réveils (−56 %)** |
| Attente ajoutée à un événement (médiane, max) | 1,5 s | 150 s, 600 s | — |

Lecture honnête :

- **Les réveils sont le vrai gain** : 56 % de réveils en moins le 2 novembre. Le prix : un arrêt ou une fin
  attend 2 min 30 de plus (10 min au pire) avant d'être jugé ; un message de Dev, lui, n'attend pas.
- **Les messages en rafale gagnent peu** : 50 des 344 messages arrivent pendant un tour, mais la plupart
  seuls dans leur tour (un message en attente, c'est déjà un tour). Les 21 tours évités viennent tous d'une
  conversation (`f9086a12`, 1er novembre, 235 messages, dont une rafale de 15 messages pendant un même tour) ;
  les cinq autres n'ont aucun groupe. Au prix du cache lu d'Opus, les 7,34 M tokens font environ 1,5 $ :
  le gain se compte surtout en tours (et en attente de Dev), pas en dollars.
- Le rejeu ne compte que la relecture du contexte au premier appel d'un tour évité, pas les réponses
  plus courtes ni le fait qu'un tour groupé peut être plus long.
- Le script est testé sur une transcription et une base construites (`test/measure-rafale.test.mjs`).

# Phase 14 : le pilote et les sessions de plan (session SOR)

Une sortie d'outil entre une fois dans le contexte et y est relue à chaque appel suivant : un fichier
de 30 000 tokens lu dans une conversation qui fait encore 50 appels coûte 50 lectures de cache. Le hook
ne garde plus seulement le planificateur : le pilote et les sessions de plan l'ont aussi, avec des
seuils réglables par projet, et un second essai explicite passe toujours. Il garde `Read` ; les
commandes Bash tournent entières (« La réécriture de Bash, écartée », plus bas).

## Les règles

| Ce qui arrive | Ce que fait le hook | Ce que la session reçoit | Pour l'avoir quand même |
|---|---|---|---|
| `Read` de plus de 300 lignes sans `limit`, ou d'un fichier de plus de 200 Ko | refus, une ligne | le nombre de lignes, `offset`/`limit` ou `Grep` | le même `Read` une seconde fois |
| `Read` d'un `.json` de plus de 8 Ko | refus | un filtre prêt : `jq '.clé'` ou `node -e …` | idem |
| `Read` d'une image (`.png .jpg .jpeg .gif .webp .pdf`) | refus : « une capture de contrôle se juge par son rapport texte ; une capture à montrer, relis-la » | — | la relire : Haiku la regarde d'abord (ci-dessous) |
| `Read` de `.jsonl .sqlite .db` | refus | `Grep`, `node -e`, `node:sqlite` | idem |
| Commande Bash | rien | sa sortie entière | — |

Chaque refus finit par « Si tu en as vraiment besoin, refais exactement la même lecture : elle
passera. » Le hook garde ses refus par session (`$TMPDIR/escadrille-frugal/<session_id>.json`, 30
minutes) ; le même `Read` (même chemin, même `offset`, même `limit`) repasse. Une session qui a vraiment
besoin de lire paie un appel de plus, jamais un mur.

Les seuils par projet, dans `<projet>/.escadrille/frugal.json` (cherché depuis le dossier de la session en
remontant : un worktree sous `<projet>/.claude/worktrees/` prend celui de son projet), ou
`ESCADRILLE_FRUGAL` (JSON) pour un lancement :

```json
{ "readLines": 300, "readBytes": 204800, "jsonBytes": 8192, "images": "triage", "off": false }
```

`images` : `triage` (refus, puis Haiku), `ask` (refus, puis ouverte), `allow`.

## La réécriture de Bash, écartée

Le but était de couper une commande à grosse sortie (tête et queue, le fichier entier à côté). Un hook
PreToolUse ne voit pas la sortie, seulement la commande : il fallait la réécrire (`updatedInput`) pour
que la sortie aille dans un fichier et qu'un petit script (`lib/frugal-cap.mjs`) en montre le début et la
fin. Quatre essais réels sur Claude Code 2.1.316 le 2 novembre (`scripts/frugal-live.mjs`, lancé par le
pilote hors du bac à sable) :

| Essai | Forme réécrite | Ce qu'a fait Claude Code |
|---|---|---|
| 1 | `{ cmd\n} > fichier 2>&1; node cap fichier $? …` | refusée : « A group in braces or double parentheses in this command can't be checked before it runs » |
| 2 | `cmd > fichier 2>&1; node cap fichier $? …` | refusée : « A variable in this command can't be checked before it runs » |
| 3 | `cmd > fichier 2>&1 && node cap … 0 \|\| node cap … 1` | syntaxe acceptée, mais chaque partie demande une approbation (« contains multiple operations… require approval ») : un refus en `-p` |
| 4 | la même, avec les outils d'une session de plan et la commande seule en témoin | le témoin (`seq` seule, sans hook) déjà refusé : en `-p`, l'essai ne reproduit pas une session de plan, dont les permissions passent par le canal du serveur |

Branchée sur `server.mjs`, la forme 1 aurait refusé chaque commande Bash des sessions ; la forme 3
aurait fait de chaque commande une demande d'approbation de plus. Les mêmes essais ont vérifié qu'une
règle `deny` refusait encore la commande réécrite, et que Haiku dit `vide` d'une capture blanche.
Décision du pilote : on arrête, le hook ne réécrit plus Bash (aucun `updatedInput`). `lib/frugal-cap.mjs`
reste comme outil de la mesure (ce qu'une sortie coupée aurait coûté). Pour une sortie de commande, la
règle reste dans les consignes (`| head`, `--oneline -n 20`, un filtre `jq` / `node -e`).

## Le pré-tri des captures par Haiku

Le 2 novembre, le pilote a ouvert une capture bloquée sur la connexion de l'app élève : 1 600 tokens
relus à chaque appel pour une image à refaire. Au second essai sur une image, le hook lance
`claude -p --model claude-haiku-5-5 --allowedTools Read --permission-mode dontAsk --max-budget-usd 0.05`
(avec `ESCADRILLE_FRUGAL_OFF=1`, pour que le hook ne se garde pas lui-même) : une ligne, `bonne`,
`vide`, `connexion` ou `erreur`. Bonne : l'image s'ouvre. Sinon refus avec la ligne de Haiku et
« Ne montre pas cette capture : refais-la (CAPTURE: <url> compte=<nom>) ; pour l'ouvrir quand même,
relis-la » ; un troisième essai passe. Haiku muet ou en erreur (45 s au plus) : l'image s'ouvre. Un
réveil Haiku coûte moins d'un centime ; une image écartée en économise 1 600 tokens par appel suivant.

## Où le hook se branche

| Qui | Comment | État |
|---|---|---|
| Le planificateur | `startPlanner` → `withFrugal(SANDBOX_SETTINGS)` (`lib/planner.mjs`) | branché depuis la phase 4 ; prend les règles de la phase 14 |
| Le pilote du serveur | `startPlanner` aussi (`server.mjs`, `pilotWake`) | branché de même |
| Les sessions de plan | `startProcess` dans `server.mjs` : `settings: withFrugal(settings)` | branché (phase 14, SOR) ; `test/api.test.mjs` vérifie que la session lancée reçoit le hook |
| La conversation de pilote de Dev (Claude Code dans `~/Dev/escadrille`) | un hook dans `.claude/settings.json` du dépôt | Dev décide (extrait ci-dessous) |

Le hook pour `.claude/settings.json` (le chemin de Node 22 de Dev, pas un `node` nu) :

```json
"hooks": { "PreToolUse": [{ "matcher": "Read", "hooks": [{ "type": "command", "command": "~/.nvm/versions/node/v22.23.4/bin/node \"$CLAUDE_PROJECT_DIR/lib/frugal-hook.mjs\"", "timeout": 60 }] }] }
```

## La preuve

`node --test test/frugal.test.mjs test/frugal-outputs.test.mjs` (verts) et `test/api.test.mjs` (une
session de plan lancée reçoit le hook) : le refus puis le second essai, par session ; les seuils du
projet trouvés depuis un worktree ; le gros JSON refusé avec un filtre ; le hook muet sur toute commande
Bash ; le tri d'image avec un faux `claude` (connexion refusée avec sa ligne, troisième essai ouvert,
bonne capture ouverte au second). Sur le vrai Claude Code : Haiku dit `vide` d'une capture blanche
(`node scripts/frugal-live.mjs`, moins d'un centime, ne fait plus que cet essai). Le refus d'un `Read` par
le hook et la relecture avec `offset`/`limit` sont prouvés depuis la phase 4 (plus haut).

## La mesure : les 20 plus grosses sorties des 1er et 2 novembre

`node scripts/frugal-outputs.mjs --days 2026-11-01,2026-11-02` (lecture seule de `~/.claude/projects`,
toutes les conversations, sous-agents compris). Pour chaque sortie : ses tokens (caractères divisés
par un ratio mesuré dans les mêmes transcriptions, la croissance du contexte après un résultat
d'outil seul ; une image par la formule de Claude), le nombre d'appels qui la relisent jusqu'à la
fin ou au prochain compactage, et son coût = tokens × (écriture de cache + lectures × prix de lecture),
aux prix de `lib/usage.mjs`. Avec plafond : la sortie coupée telle que `capText` la rendrait, une
image remplacée par la ligne de refus. Limite connue : un appel de plus quand la session relit une
partie coupée n'est pas compté ; la ligne « auraient été coupées » le borne.

Relevé le 2026-11-02 (lancé hors du bac à sable par le pilote) : 568 transcriptions, 19 315 sorties
d'outils les 1er et 2 novembre ; 1,91 caractère par token (médiane de 13 518 mesures) ; 68 sorties déjà
mises de côté par Claude Code lui-même.

| # | Sortie | Lignes | Tokens | Relue | Sans plafond | Avec plafond |
|---|---|---|---|---|---|---|
| 1 | `Read ~/Dev/Orchard/Orchard-v2/Orchard-teacher/.claude/worktr` | 1060 | 40680 → 7459 | 41 fois | 0,66 $ | 0,12 $ |
| 2 | `Read ~/Dev/Orchard/Orchard-v2/Orchard-teacher/.claude/worktr` | 1063 | 38362 → 7704 | 40 fois | 0,61 $ | 0,12 $ |
| 3 | `Read ~/Dev/Orchard/Orchard-v2/qa/2026-11-02/parcours.json` | 1953 | 33238 → 3457 | 28 fois | 0,90 $ | 0,09 $ |
| 4 | `Read ~/.claude/plugins/cache/taste-skill/taste-skill/2.1.5/skills/` | 817 | 31317 → 7816 | 29 fois | 0,43 $ | 0,11 $ |
| 5 | `Read ~/.claude/plugins/cache/taste-skill/taste-skill/2.1.5/skills/` | 817 | 31317 → 7816 | 39 fois | 0,93 $ | 0,23 $ |
| 6 | `Read ~/.claude/plugins/cache/taste-skill/taste-skill/2.1.5/skills/` | 817 | 31317 → 7816 | 41 fois | 0,95 $ | 0,24 $ |
| 7 | `Read ~/.claude/plugins/cache/taste-skill/taste-skill/2.1.5/skills/` | 817 | 31317 → 7816 | 52 fois | 1,03 $ | 0,26 $ |
| 8 | `Read ~/.claude/plugins/cache/taste-skill/taste-skill/2.1.5/skills/` | 817 | 31317 → 7816 | 24 fois | 0,81 $ | 0,20 $ |
| 9 | `Read ~/.claude/plugins/cache/taste-skill/taste-skill/2.1.5/skills/` | 817 | 31317 → 7816 | 42 fois | 0,96 $ | 0,24 $ |
| 10 | `Read ~/.claude/plugins/cache/taste-skill/taste-skill/2.1.5/skills/` | 817 | 31317 → 7816 | 35 fois | 0,90 $ | 0,22 $ |
| 11 | `Read ~/.claude/plugins/cache/taste-skill/taste-skill/2.1.5/skills/` | 817 | 31317 → 7816 | 44 fois | 0,97 $ | 0,24 $ |
| 12 | `Read ~/.claude/plugins/cache/taste-skill/taste-skill/2.1.5/skills/` | 817 | 31317 → 7816 | 46 fois | 0,99 $ | 0,25 $ |
| 13 | `Read ~/.claude/plugins/cache/taste-skill/taste-skill/2.1.5/skills/` | 817 | 31317 → 7816 | 52 fois | 1,03 $ | 0,26 $ |
| 14 | `Read ~/.claude/plugins/cache/taste-skill/taste-skill/2.1.5/skills/` | 817 | 31317 → 7816 | 60 fois | 1,10 $ | 0,27 $ |
| 15 | `Read ~/.claude/plugins/cache/taste-skill/taste-skill/2.1.5/skills/` | 817 | 31317 → 7816 | 19 fois | 0,78 $ | 0,19 $ |
| 16 | `Read ~/.claude/plugins/cache/taste-skill/taste-skill/2.1.5/skills/` | 817 | 31317 → 7816 | 48 fois | 1,00 $ | 0,25 $ |
| 17 | `Read ~/.claude/plugins/cache/taste-skill/taste-skill/2.1.5/skills/` | 817 | 31317 → 7816 | 39 fois | 0,93 $ | 0,23 $ |
| 18 | `Read ~/.claude/plugins/cache/taste-skill/taste-skill/2.1.5/skills/` | 817 | 31317 → 7816 | 19 fois | 0,78 $ | 0,19 $ |
| 19 | `Read ~/.claude/plugins/cache/taste-skill/taste-skill/2.1.5/skills/` | 817 | 31317 → 7816 | 58 fois | 1,08 $ | 0,27 $ |
| 20 | `Read ~/Dev/escadrille/.claude/worktrees/2026-11-01-phase-4-les-tok` | 597 | 31152 → 8709 | 57 fois | 0,60 $ | 0,17 $ |

| | Sans plafond | Avec plafond | Gain |
|---|---|---|---|
| Les 20 plus grosses (toutes des `Read`, donc gardées par le hook) | 17,44 $ | 4,17 $ | −76 % au plus |

Les lignes « toutes les sorties » (555,76 $ → 443,72 $) et « 1 504 coupées » (212,01 $ → 99,92 $) de ce
relevé coupaient aussi les sorties Bash : elles ne valent plus depuis l'abandon de la réécriture.
`scripts/frugal-outputs.mjs` ne coupe plus que les `Read` et les images ; le relancer (hors du bac à
sable) donne le total de ce qui reste.

Ce que disent les chiffres :

- Les 20 plus grosses sont toutes des `Read`, aucune commande Bash : 16 sont la même référence de
  `taste-skill` (817 lignes, ~31 000 tokens), relue dans 16 sessions d'écran parce que CLAUDE.md impose
  de suivre `references/app-screens.md`. Une économie là se trouve aussi dans le skill (une version
  courte de la référence) : le hook la refuse une fois, mais une session qui doit la suivre la relira au
  second essai.
- Le chiffre « avec plafond » est donc une **borne haute** du gain pour les `Read` : le hook refuse
  une fois et laisse passer le second essai, la mesure compte la sortie coupée.
- L'appel de plus quand une session relit la partie coupée n'est pas compté.
- 1,91 caractère par token est bas (texte français, code, JSON ; le ratio sort de la croissance du
  contexte, qui inclut les rappels système joints au résultat) : les tokens sont peut-être
  surestimés, les deux colonnes dans la même proportion, les pourcentages tiennent.
- Le gain par la conversation de pilote seule n'est pas isolé ici ; il ne vaudra qu'avec le hook dans
  `.claude/settings.json` (Dev décide).
