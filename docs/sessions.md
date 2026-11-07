# Les sessions dans la page : le côté serveur

Depuis la phase 3, « Lancer la multi-session » n'ouvre plus de terminal : le serveur lance chaque
session du plan comme la session de planification, un processus `claude -p` en stream-json
(`lib/planner.mjs`, `startSession`), dans un worktree git qu'il crée (`lib/worktree.mjs`), et il lit
dans le flux l'état, les arrêts, l'usage et les demandes d'autorisation. Le bloc `curl` et la route
`/api/update` ont disparu. Vérifié le 2026-11-01 avec Claude Code 2.1.316.

## Le canal de contrôle (vérifié par `node test/control.probe.mjs`)

`claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio
--permission-mode default --allowedTools …` émet, pour un outil hors liste blanche, une ligne
`control_request` et attend notre `control_response` sur stdin. Le processus reste vivant entre deux
tours (même `session_id`) et `result` arrive à chaque tour.

Reçue :

```json
{"type":"control_request","request_id":"b44678b4-…","request":{"subtype":"can_use_tool","tool_name":"Bash",
 "input":{"command":"touch /tmp/x && curl -s -o /dev/null -w \"%{http_code}\" http://localhost:3078/api/plans"},
 "permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"touch /tmp/x"},…],"behavior":"allow","destination":"localSettings"}],
 "decision_reason_type":"subcommandResults","tool_use_id":"toolu_01Nf…"}}
```

Envoyée : `{"type":"control_response","response":{"subtype":"success","request_id":"…","response":{"behavior":"allow","updatedInput":{…}}}}`,
ou `"response":{"behavior":"deny","message":"Refusé par le développeur."}` ; la session reçoit alors un
`tool_result` en erreur avec le message et le dit dans son texte.

Deux pièges : sans `--permission-mode default` la session hérite du mode de l'utilisateur (`autoMode`
chez Dev) et rien ne remonte ; et la liste sûre de Claude Code (`echo`, `ls`…) passe sans demander,
même hors liste blanche.

## Le pilote (`lib/planner.mjs`)

`startSession({ cwd, model, systemPrompt, resume, allowedTools, permissionMode, permissionPrompt, onEvent })`
rend `{ send(text), answer(id, { allow, always, message }), stop(), busy, sessionId, exited }`.
`startPlanner` est le même pilote en lecture seule et sans canal (`dontAsk`). Événements : `init`,
`text`, `block` (un bloc `escadrille:*` fermé dans un texte), `activity`, `ask`, `turn`, `quota`,
`error`, `exit`.

- **Liste blanche** d'une session lancée (`SESSION_TOOLS`) : Read, Glob, Grep, Edit, Write, MultiEdit,
  NotebookEdit, `git add/commit/status/diff/log/branch/checkout/rebase/merge/worktree list`, node, npm
  test, npm run, ls, cat, head, wc. Tout le reste remonte à la page (rm, open, mkdir, un chemin hors du
  worktree…).
- **Règle réseau** (`isNetwork`) : tout accès hors localhost demande l'autorisation, sans exception :
  curl, wget, git push/pull/fetch/clone, npm install et consorts, npx, pip, brew, ssh, scp, gh, WebFetch,
  WebSearch. Seul un curl qui ne vise que localhost passe. Un « toujours » ne couvre jamais le réseau.
  Limite : un script lancé par `node` ou `npm run` peut sortir seul sur le réseau.
- **La règle locale** (`lib/policy.mjs`, `docs/policy.md`) : chaque entrée `permission` de `pending` porte
  `suggest: { allow, reason, rule }`, ou `null` quand la règle n'a rien à dire. `allow: true` pré-coche
  « Autoriser », `false` « Refuser » ; la page attend toujours le clic. Le serveur propose, le
  développeur décide.
- **« Toujours »** : les règles suggérées par Claude Code (`rm:*`…) sont gardées en mémoire du pilote,
  rien n'est écrit dans les settings du projet ; une demande couverte passe en `activity`
  « autorisé d'office ».

La consigne dit aussi, depuis la phase 13, la ligne `ENV: up | down | reset | status` : le serveur exécute la commande
que le projet a déclarée pour son environnement de dev et rend le résultat en tête du message suivant (`docs/devenv.md`).

## Le bloc state

La session termine chaque tour par un bloc que le serveur ajoute en consigne au prompt (le plan ne
l'écrit pas) et lit dans le flux (`lib/blocks.mjs`, `validateState`) :

```
```escadrille:state
{"stops":[0],"health":"ok","why":"","claude":"Regarde … dans …","done":false}
```
```

État d'une session : `running` pendant un tour, `waiting` quand `result` arrive, `done` quand le bloc
dit `done:true`. L'usage (`input`, `output`, `cost`, `weekly`, `context` = part de la fenêtre 0..1) vient
de `result` et `rate_limit_event`.

Depuis la phase 4, le bloc porte un champ facultatif `summary` : deux lignes, ce qui est fait et ce qui
reste (`"summary":"Fait : …\nReste : …"`). `validateState` le garde tel quel (chaîne, `null` s'il
manque) ; la ligne de session le tient dans `summary` et l'attente `reply` le porte aussi, pour que la
page montre où en est une session sans ouvrir son chat.

## Le résumé de fin, « Ce qui a été fait » (phase 16, PAIR)

Au dernier tour, une session laisse ce qu'un collègue met en tête de sa PR. `done` passe de `true` à un objet :
l'objet vaut `done: true`, plus le résumé. `done: true` seul reste valable (rien ne change pour l'affichage).

```
```escadrille:state
{"stops":[0,1],"health":"ok","why":"","claude":"…","summary":"Fait : …\nReste : rien","done":{
 "summary":"Le résumé de fin entre dans le bloc state. La Revue le montre avec un fil. Une correction relance la session.",
 "journeys":["Revue › une session finie","Revue › le fil"],
 "tests":["validateDone tronque un résumé trop long","un message du fil pendant un tour attend"],
 "captures":[".escadrille/captures/1-localhost-3078-review/1440.png"]}}
```
```

`validateDone` (`lib/blocks.mjs`) ; un champ faux est corrigé ou retiré, jamais une erreur du bloc :

| Champ | Forme | Règle |
| --- | --- | --- |
| `summary` | chaîne | obligatoire pour qu'il y ait un résumé ; coupé à 3 phrases et 600 caractères |
| `journeys` | liste de chaînes | les parcours touchés, nom d'écran › geste ; 8 au plus, 80 caractères chacun |
| `tests` | liste de chaînes | une puce par test ajouté, coupée à 10 mots ; 20 au plus |
| `captures` | liste de chemins | relatifs au worktree, sous `.escadrille/captures/` ou `.escadrille/qa/`, `.png` ; 12 au plus ; les autres écartés. Facultatif : une session sans écran (le back) laisse `[]` ou l'omet |

Sans `summary` lisible, la session est quand même finie et le résumé vaut `null` : l'affichage reste celui d'avant.
`validateState` rend le résumé validé dans `report` ; le serveur le range dans la table `review_done (plan, session,
json, at)` (`lib/donethread.mjs`). Une session rouverte par le fil le garde jusqu'à son prochain résumé, qui le
remplace.

La consigne (`stateInstruction`) gagne deux lignes, à la suite de `done` :

```
- au dernier tour, done devient {"summary":"3 phrases au plus","journeys":["écran › geste"],"tests":["10 mots par test ajouté"],"captures":["chemins .escadrille/…png"]} ;
  captures vide sans écran.
```

## Les fusions de release (phase 10, `lib/release.mjs`)

Un sprint livré en kit (`delivery: "kit"`) donne une branche par ticket, et une branche `release/rNN` par dépôt les
rassemble pour une seule QA. Une session ne peut pas écrire dans `.git` depuis son bac à sable : elle écrit la liste
des fusions dans son bloc state, et le serveur les fait lui-même, hors du bac, avec git seulement.

```
```escadrille:state
{"stops":[1],"health":"ok","why":"","claude":"…","summary":"…","done":false,
 "releases":[{"repo":"~/Dev/Orchard-v2","release":"release/r02","base":"main","branches":["r02/t1","r02/t2","r02/t3"]},
             {"release":"release/r02","base":"main","branches":["r02/api"]}]}
```
```

- `releases` : un tableau (20 dépôts au plus) ; `repo` un chemin absolu, ou absent pour le dépôt de la session ;
  `release` la branche à construire, `base` son point de départ, `branches` les branches à fusionner, dans l'ordre
  (1 à 50, sans doublon). Un nom de branche qui commence par `-`, contient `..`, un espace ou `~^:?*[\` est refusé.
- Seul un plan en kit est servi ; un autre reçoit une ligne « ignorées ». Le dépôt doit être un dépôt du plan (son
  projet, le dossier d'une de ses sessions, ses `addDirs`).
- Le serveur fait la liste à la fin du tour, un dépôt après l'autre (une seule construction à la fois par dépôt) :
  un worktree détaché temporaire sous le dossier temporaire du système, parti de la branche release si elle existe
  (une relance ne fusionne que ce qui est nouveau), sinon de `base` ; `git merge --no-ff` de chaque branche, message
  « Merge <branche> into <release> » ; puis `git update-ref` de la release, qui vérifie son ancienne valeur. Le
  worktree temporaire est retiré par son chemin, jamais de `prune`. Rien n'est poussé, aucune autre commande.
- Un conflit arrête ce dépôt : `merge --abort`, la branche release reste comme elle était (absente si elle
  n'existait pas), et la session reçoit la branche fautive et les fichiers en conflit. Les autres dépôts continuent.
  Refusés aussi : une branche introuvable, une release qui est la branche courante d'un worktree.
- Chaque résultat est une ligne système dans la page (traduite, clés `srv.rel.*`) et une ligne `[système]` en
  français pour la session ; comme après ses captures, le serveur la reprend seul si le tour n'a franchi aucun arrêt
  et que rien n'attend le développeur (« Les fusions de release sont faites : reprends. »), sinon les lignes mènent
  son prochain message.
- La session écrit `releases` seulement dans le tour où elle veut les fusions, puis l'enlève. Pour un conflit :
  le résoudre sur la branche du ticket (ou une branche de résolution placée avant dans la liste), commiter, renvoyer
  la liste.

## Le plafond, les alertes et la passation (phase 4)

Quatre constantes en tête de `server.mjs`, chacune surchargée par une variable d'environnement :

| Constante | Variable | Défaut | Rôle |
| --- | --- | --- | --- |
| `DEFAULT_BUDGET_USD` | `ESCADRILLE_BUDGET_USD` | 5 | le plafond en dollars d'une session dont le plan ne dit rien |
| `ALERT_BUDGET` | `ESCADRILLE_ALERT_BUDGET` | 0.8 | part du plafond qui déclenche l'alerte « budget » |
| `ALERT_CONTEXT` | `ESCADRILLE_ALERT_CONTEXT` | 0.6 | part de la fenêtre de contexte qui déclenche l'alerte « contexte » |
| `HANDOFF_CONTEXT` | `ESCADRILLE_HANDOFF_CONTEXT` | 0.75 | part de la fenêtre qui déclenche la passation |

`MAX_HANDOFFS` (5, sans variable) borne le nombre de passations d'une session : au-delà, elle attend comme une autre, la boucle d'un seuil trop bas s'arrête.

### Le plafond

Une session du plan peut porter `budget` (nombre, dollars US) ; `validatePlan` le garde quand il est un
nombre positif, sinon le défaut s'applique. Le plan peut porter `network` (liste de domaines), gardé tel
quel et rendu vide par défaut : ce sont les domaines ouverts au bac à sable de ses sessions (« La garde du Mac », plus bas). `GET /api/plan/:id` rend le
plafond effectif dans `state[].budget`.

Le serveur passe `--max-budget-usd <budget>` à `claude -p` (Claude Code 2.1.316 : « Maximum dollar amount
to spend on API calls, only works with --print », vérifié par Dev le 2026-11-01) : Claude Code arrête
lui-même la session quand le plafond est atteint, le tour finit en erreur et la ligne passe en `error`.
Le serveur tient aussi le plafond lui-même : à chaque fin de tour, si `usage.cost >= budget`, il arrête le
processus (`mode: null`), laisse la session en `waiting` avec son attente `reply`, et un message `system`
dit « Plafond de 0,06 $ atteint (0,06 $) : processus arrêté. Écris-lui pour continuer au-delà. » ; un
message du développeur la reprend (`--resume`). `usage.cost` est le coût cumulé de la session : le
`total_cost_usd` de Claude Code compte le processus en cours, le serveur y ajoute ce que la ligne
avait avant (après une passation, un arrêt, un redémarrage).

### Les alertes

À chaque événement `turn`, le serveur compare `usage.cost / budget` à `ALERT_BUDGET` et `usage.context` à
`ALERT_CONTEXT`. Un seuil franchi ajoute dans `pending` une entrée

```
{ id: 'alert-budget-…', kind: 'alert', what: 'budget' | 'context', pct, text, at }
```

`pct` est une fraction (0.82 = 82 %), comme tout dans ce serveur ; `text` est la phrase prête à montrer
(« Budget : 4,10 $ sur 5 $ (82 %) », « Contexte : 62 % de la fenêtre »). Chaque seuil ne sonne qu'une
fois par session : les seuils déjà franchis sont dans la colonne `alerted` (JSON) de la ligne ; la
passation efface `context` de cette liste (la session fraîche repart d'une fenêtre vide), jamais
`budget`. Le SSE `pending { session }` part comme pour une autorisation. `POST …/dismiss { id }` retire
une entrée `alert` ou `info` ; une autorisation ou une `reply` ne se retire pas ainsi.

### La passation

Le schéma, dans l'ordre. Rien n'est demandé au développeur ; il est seulement prévenu.

1. **Le déclencheur.** À la fin d'un tour (`turn`), `usage.context >= HANDOFF_CONTEXT`, la session n'est
   pas `done` et aucune passation n'est en cours pour elle.
2. **La demande** (le serveur → la session, un tour de plus, rôle `system` dans le chat). Le serveur
   envoie un message qui demande d'écrire `<worktree>/.escadrille/passation.md` (en français, moins de
   150 lignes : ce qui est fait, ce qui reste, les fichiers touchés, les pièges, les arrêts franchis),
   de commiter le travail en cours, et de finir par le bloc state, rien d'autre. Ligne de journal :
   `claude` = « Passation n°N demandée (contexte 76 %) ». Le dossier `.escadrille/` est dans
   `.git/info/exclude` du dépôt (une ligne ajoutée par `lib/worktree.mjs` à `create`) : le commit de la
   session ne l'emporte pas.
3. **La lecture** (à la fin de ce tour, événement `turn`). Le serveur arrête le processus (`stop()`),
   lit le fichier, et ajoute `{ n, at, file, text }` à la liste `handoffs` de la ligne (colonne JSON) :
   `n` compte à partir de 1, `file` est le chemin lu, `text` son contenu. Le fichier est ensuite effacé :
   lu une fois, jamais réutilisé par la passation suivante si la session oublie d'écrire le sien. Si le
   fichier manque, `text` est la fin du dernier message de la session (ses 40 dernières lignes), `file`
   vaut `null`, et le journal le dit (« fichier absent »). Si ce tour dit `done:true`, la session est
   finie : pas de relance.
4. **La relance.** Un processus frais (`startSession` sans `--resume`, même worktree, même branche, même
   modèle, même plafond) reçoit pour prompt la passation puis le prompt d'origine, l'instruction state
   ajoutée comme toujours :

   ```
   # Passation n°N, laissée par la session précédente

   <texte de passation.md>

   # Le prompt d'origine

   <prompt du plan>
   <instruction state>
   ```

   Le `sessionId` de la ligne devient celui du nouveau processus (événement `init`). `usage` garde
   `input`, `output` et `cost` cumulés ; `context` repasse à `null` jusqu'au premier tour. Les attentes
   `reply` et l'alerte `context` sont retirées de `pending` ; une entrée `{ id, kind: 'info', text:
   'Passation n°N faite, session fraîche relancée', at }` (sans bouton, une croix « Vu » qui appelle
   `/dismiss`) est ajoutée ; ligne de journal : `claude` = « Passation n°N faite (contexte 76 %), session
   fraîche relancée » ; un message `system` dans le chat. Le SSE `pending` part.
5. **Après.** La session fraîche travaille comme les autres ; si son contexte remonte à 75 %, une
   passation n°N+1 suit. Un redémarrage du serveur pendant l'étape 2 perd la demande en cours (elle vit
   en mémoire) : la session est reprise avec `--resume` et la passation se redéclenche au tour suivant si
   le contexte est toujours au-dessus du seuil.

Pourquoi le serveur arrête le processus plutôt que de continuer : au-delà de 75 % de la fenêtre, chaque
tour relit tout le contexte ; une session fraîche qui repart d'une passation de 150 lignes coûte une
fraction de cela, c'est le point 5 du flot du README.

Colonnes ajoutées à `sessions` (JSON, `null` ou `[]` par défaut) : `handoffs`, `summary`, `alerted`.

### L'essai du 2026-11-01 contre le faux claude

`test/fake-claude.mjs` sait jouer un contexte qui monte (`FAKE_CLAUDE_CONTEXT_WINDOW=1000`,
`FAKE_CLAUDE_CONTEXT_STEP=250` : 36 %, 61 %, 86 % de la fenêtre aux tours 1, 2, 3 ; 0,01 $ de plus par
tour) et écrire `passation.md` quand on le lui demande. Sur un serveur de test (port 3334, session H
avec `budget: 0.06`), le journal d'une session menée au plafond :

```
03:34:25  running  Lancée dans …/.claude/worktrees/essai-H (branche escadrille/essai/H)
03:34:26  waiting  Tour 1                      contexte 0,362 · 0,01 $ · pending : reply
03:34:26  waiting  Tour 2                      contexte 0,612 · 0,02 $ · pending : alert:context « Contexte : 61 % de la fenêtre », reply
03:34:26  running  Tour 3
03:34:26  running  Passation n°1 demandée (contexte 86 %)
03:34:26  running  Passation écrite
03:34:26  running  Passation n°1 faite (contexte 86 %), session fraîche relancée
03:34:26  waiting  Tour 1                      session sess-10, contexte 0,362 · 0,05 $ · pending : info « Passation n°1 faite… », alert:budget « Budget : 0,05 $ sur 0,06 $ (83 %) », reply
03:34:26  waiting  Tour 2                      0,06 $ : « Plafond de 0,06 $ atteint (0,06 $) : processus arrêté. »
```

`handoffs[0]` : `{ n: 1, file: "…/essai-H/.escadrille/passation.md", text: "Fait : les tours 1 à 3 de la
session sess-9.\nReste : la fin.\nFichiers : docs/essai.txt" }` ; le prompt du processus `sess-10` commence
par « # Passation n°1, laissée par la session précédente », puis ce texte, puis « # Le prompt d'origine »
et le prompt du plan avec son instruction state. Le test `test/api.test.mjs` rejoue cette séquence.

### L'essai de bout en bout de la session F (2026-11-01, faux claude)

Fait **avec le faux claude** (`test/fake-claude.mjs`), pas avec un vrai Sonnet : le bac à sable de la session F n'a ni `claude` ni réseau. Un serveur sur le port 3192, une base jetable, un dépôt jetable de quatre fichiers de notes, `ESCADRILLE_HANDOFF_CONTEXT=0.5` (un seuil de 0,02 ferait repasser la session fraîche au-dessus du seuil dès son premier tour : voir le garde-fou plus bas), contexte qui monte de 250 sur 1000 par tour. Deux sessions : H (budget 0,5 $, la passation) et C (budget 0,01 $, le plafond). Le journal complet est dans `docs/phase4-essai-journal.json` (export de la page) ; en voici l'essentiel :

```
04:09:54  H running  Lancée dans …/.claude/worktrees/essai-bout-en-bout-H
04:09:54  H waiting  Tour 1                                  contexte 0,362
04:09:54  C waiting  Tour 1        0,01 $ sur 0,01 $ : alerte budget, processus arrêté (mode null)
04:09:56  H running  Tour 2                                  contexte 0,612 : alerte contexte
04:09:56  H running  Passation n°1 demandée (contexte 61 %)
04:09:56  H running  Passation écrite
04:09:56  H running  Passation n°1 faite (contexte 61 %), session fraîche relancée   (sess-9 → sess-11)
04:09:56  H waiting  Tour 1 de sess-11   pending : info « Passation n°1 faite… », reply
04:10:04  H done     Tour 2 : docs/essai.txt écrit et commité par la session fraîche
04:10:08  H done     Fusionnée dans …/repo (bouton) : commit de fusion --no-ff, worktree retiré, dépôt propre
04:10:08  C waiting  un message au-delà du plafond : un tour, 0,02 $, arrêtée de nouveau
```

Vérifié : `.escadrille/passation.md` lu puis effacé, `handoffs[0]` rempli, le commit de la session fraîche
ne l'emporte pas, la ligne `sessionId` change, `GET /api/running` voit la session (puis plus rien
que le worktree de C), le serveur écoute sur `127.0.0.1` seul (`lsof`).

**Ce que le bac à sable ne permet pas**, à vérifier sur le Mac : `ps` y est refusé (`others()` vide ;
Dev l'a vérifié hors bac à sable, il liste les `claude` du Mac sans le pont Chrome), et Chrome n'y
démarre pas (`inspect.mjs` tourne hors bac à sable : `docs/phase4-flot-reel*.jpg`).

**Défauts trouvés**

- Corrigé : `safeEnv` retirait `GIT_CONFIG_KEY_0` (le nom contient « KEY ») mais laissait `GIT_CONFIG_COUNT` :
  tout `git` lancé par une session échouait (« missing config key »). Toute la famille `GIT_CONFIG_*`
  est maintenant retirée.
- Corrigé : une session fraîche dont le premier tour dépasse déjà le seuil repassait en passation à
  chaque tour, sans fin hors le plafond en dollars. `MAX_HANDOFFS = 5` : au-delà, elle attend comme une autre.

## La garde du Mac (phase 4)

Ce que le serveur ouvre, ce qu'il laisse sortir, ce qui tourne à cause de lui, et comment ouvrir ce
qu'une session a fait.

### L'écoute

Le serveur écoute sur `127.0.0.1` par défaut : seul le Mac l'atteint. `ESCADRILLE_HOST=0.0.0.0` (ou
`./run.sh --lan`) l'ouvre au réseau local, pour le téléphone. La ligne de démarrage dit sur quoi il
écoute :

```
escadrille on http://localhost:3078, listening on 127.0.0.1 only (./run.sh --lan or ESCADRILLE_HOST=0.0.0.0 opens the LAN), database …
escadrille on http://localhost:3078, listening on 0.0.0.0 (LAN open: http://192.168.1.x:3078), database …
```

Même ouvert au LAN, lancer, fusionner et arrêter ce qui tourne se font depuis le Mac seulement. Depuis
la phase 5, une seule garde en tête du handler décide (voir « Le téléphone (phase 5) ») ;
`SM_LAUNCH_LAN` n'existe plus. Depuis la phase 12, « depuis le Mac » ne suffit plus : une session joint `127.0.0.1` depuis
son bac, et toute route qui agit demande le cookie de garde, un appareil appairé ou le jeton du pilote (`docs/gate.md`).

### Les domaines

Chaque `claude -p` lancé reçoit en `--settings` `SANDBOX_SETTINGS` (`lib/planner.mjs`), dont
`sandbox.network.allowedDomains` vaut `plan.network` : vide par défaut, donc aucune sortie réseau.
`sandboxSettings(network)` construit ces settings ; les domaines sont relus dans le plan à chaque
démarrage de processus (lancement, reprise, message après un arrêt, passation). Une session en vol
garde ceux de son démarrage et prend les nouveaux à sa prochaine relance, rien de plus.

`POST /api/plan/:id/settings { network }` valide la liste (`validateDomains`) : des noms d'hôte
(`api.github.com`, `*.npmjs.org`), mis en minuscules, sans doublon ; refusés (400, l'erreur nomme le
fautif) : une URL, un schéma, un port, un chemin, un joker seul (`*`) ou sur un domaine de premier
niveau (`*.com`), une adresse IP, `localhost` (le local est déjà ouvert par `allowLocalBinding`), une
liste qui n'en est pas une. La liste est gardée dans `plans/<id>.json` et dans la table `plans`.

### Ce qui tourne (`lib/running.mjs`)

- `ours()` : les processus `claude` vivants du serveur (`live`), les worktrees des plans (une ligne
  de session dont le worktree n'est pas fusionné et existe encore sur le disque ; `since` est sa date
  de création) et les dev servers lancés par le serveur. La session de planification n'y est pas.
- `others()` : `ps -axo pid=,ppid=,lstart=,command=`, filtré sur Claude Code (`claude …`, `node
  …/claude …`, `…/@anthropic-ai/claude-code/cli.js` ; pas l'app Claude.app), moins les pid du
  serveur (le sien, ses sessions, ses sessions de planification, ses dev servers) et leurs enfants ;
  le dossier de chacun par un seul `lsof -a -p <pid,…> -d cwd -Fn`. `args` est coupé à 300 caractères.
  Lecture seule : rien ne tue jamais un de ces processus. Si `ps` est refusé (le bac à sable d'une
  session, par exemple), `others` est vide et la console le dit une fois ; si `lsof` l'est, `cwd`
  vaut `null`.
- Arrêter (`POST /api/running/stop`) : `session` passe par l'arrêt d'une session (`sessionStop`) ;
  `devserver` envoie SIGTERM au groupe de processus de `npm run dev`, SIGKILL après 3 s ; `worktree`
  refuse tant que la session ou son dev server tourne, ou que `git status --porcelain` du worktree n'est
  pas vide, sinon retire le worktree (`worktree.remove`) et garde la branche. `stop-all` arrête tous les
  processus `claude` et dev servers du serveur ; les worktrees restent (en retirer un n'est pas
  l'arrêter). L'arrêt du serveur (SIGINT, SIGTERM) tue aussi les dev servers.

### Les serveurs des sessions meurent avec elles (2026-11-07, `lib/sessionprocs.mjs`)

Le but : rien ne tourne sans maître, et rien de ce que le développeur a lancé lui-même ne meurt sans son clic.

**La propriété.** Table SQLite `session_procs (plan, session, pid, started, port, command, cwd)`. À chaque fin
de tour d'une session et à chaque balayage de 5 min, le serveur y enregistre tout processus qui écoute en TCP
(`lsof -iTCP -sTCP:LISTEN`) et qui, soit descend du processus `claude` de la session (ancêtres lus par
`ps -axo pid=,ppid=,lstart=,command=`), soit a son dossier courant dans le worktree de la session.
`started` est l'heure de départ lue par `ps` : un pid réutilisé (même pid, autre `started`) n'appartient plus à
personne. Le dossier racine du projet ne suffit jamais à rattacher un serveur à une session. Un serveur
détaché (`node x &`, rattaché à launchd quand son shell finit) reste à sa session parce qu'il a été enregistré
pendant qu'elle vivait.

**La fermeture.** Est une fermeture : la fin (`done`), la fusion, l'abandon ou le retrait du plan, le
worktree retiré. « Arrêter le processus » (`sessionStop`) n'en est pas une : la session attend. À la fermeture,
SIGTERM puis SIGKILL après 3 s à chaque ligne de `session_procs` encore vivante (même pid **et** même
`started`) et à chaque serveur qui écoute dans son worktree (`lib/testapps.mjs`, appelé, pas copié). Si
quelque chose a été arrêté, une ligne système dans le récit de la session (clé i18n
`system.closeProcsStopped`), par exemple « Serveurs arrêtés à la fermeture : :3190 (node demo.mjs), :8082
(expo start). » ; rien sinon. Les lignes de la session sont ensuite retirées de la table.

**L'environnement (`ENV: up`).** À la fermeture d'une session qui a démarré l'environnement du projet, le
serveur lance `ENV: down` (`stopDevEnv`) seulement si aucune autre session vivante du même projet ne tourne ni
n'attend. Sinon l'environnement reste : il appartient au projet, il n'est pas orphelin.

**L'orphelin.** Un serveur qui écoute est orphelin si son dossier courant est dans une racine de projet
enregistrée (`testRoots()`), s'il n'est possédé ni par une session vivante (`running`, `waiting` ou `paused`)
ni par un environnement marqué `ENV: up`, et s'il n'est pas calmdev (`process.pid`, ni le port du serveur). Un
orphelin n'est jamais arrêté seul, seulement par le clic du développeur. Un serveur hors de toute racine de
projet n'est ni orphelin ni touché, jamais : ni à la fermeture, ni par la route.

**Les tests.** Un serveur lancé par `node --test` (`NODE_TEST_CONTEXT`) ne tue que des pid enregistrés par lui
dans sa propre base, et `ps`/`lsof` s'injectent dans `lib/sessionprocs.mjs` comme dans `test/running.test.mjs`.

#### Le contrat (pour l'écran)

`GET /api/running` → chaque entrée de `servers` porte toujours :

```
{ pid, port, command /* coupée à 300 caractères */, cwd, since /* ISO, départ lu par ps */,
  role, orphan /* booléen */, plan?, session? /* présents quand une session la possède */ }
```

`POST /api/running/stop-orphan { pid, port }` :

- sans cookie de garde (ni appareil appairé, ni jeton du pilote) : `403 { error: "…utilise le bouton Arrêter
  dans la page de calmdev sur le Mac." }` ;
- le serveur recalcule que `pid` écoute encore sur `port` et est encore orphelin ; sinon `409 { error }`
  avec la raison (`not listening`, `owned by <plan>/<session>`, `owned by ENV: up`, `outside every project`,
  `calmdev itself`) ;
- sinon SIGTERM, SIGKILL après 3 s, et `200 { ok: true, stopped: { pid, port, command } }`.

### Ouvrir le projet

Chaque entrée de `state` porte `open { folder, dev, url }` : `folder` est le cwd du worktree (ou le
dossier du plan sans worktree), `dev` dit si un `package.json` y a un script `dev`, `url` est celle
du dev server s'il tourne (sinon `null`).

- `POST …/session/:sid/open` ouvre le dossier dans le Finder (`open`, `xdg-open` hors macOS).
- `POST …/session/:sid/devserver` lance `npm run dev` dans le dossier (groupe de processus à part,
  `NO_COLOR`, `BROWSER=none`) et lit sa sortie jusqu'à la première `http://localhost:<port>` ou
  `http://127.0.0.1:<port>`, 20 s au plus (`ESCADRILLE_DEV_TIMEOUT_MS`) ; sans URL, `url` vaut `null`
  et un message `system` du chat le dit avec les dernières lignes lues. Un seul dev server par session :
  un second appel rend le même. Le SSE `change` part quand il démarre, donne son URL ou s'arrête
  (clé du plan, et `/api/events?running=1` pour qui ne suit que ce qui tourne).
- **Le dev server n'est pas dans le bac à sable de Claude Code.** Il hérite de `safeEnv` (aucune clé
  du shell du développeur), mais rien ne l'empêche de sortir sur le réseau ni de lire hors de son
  dossier : c'est le code du projet, lancé par le développeur depuis la page.
- `ESCADRILLE_NPM` remplace `npm` (les tests donnent un faux npm, `test/fake-npm.mjs`).

## Le téléphone (phase 5)

Le contrat entier est dans `docs/phone.md`, tenu par `test/phone.test.mjs` ; l'app dans `phone/`.

### La garde par jeton

- Le Mac, c'est `isLoopback(req)` : `127.0.0.1`, `::1` ou l'une des adresses du Mac lui-même. Tout le
  reste est le LAN.
- Le LAN sans jeton d'appareil valable : `401 { error: 'appairage requis' }` partout, pages et fichiers
  de `public/` compris. Seuls `POST /api/pair` et `OPTIONS` passent.
- Le LAN avec jeton (`Authorization: Bearer`, ou `?token=` sur `/api/events`) : une liste blanche, les
  routes du téléphone ; tout le reste `403 { error: 'depuis le Mac seulement' }` (lancer, fusionner,
  arrêter, réglages, pages, export…).
- `SM_LAUNCH_LAN` a disparu : le jeton est la seule façon de piloter depuis le LAN, et il ne pilote que
  la liste blanche.
- Dans les tests seulement, `ESCADRILLE_TEST_REMOTE=1` fait compter l'en-tête `x-escadrille-remote: 1`
  comme le LAN ; `run.sh` ne la pose jamais.

### Les routes

- Mac : `POST /api/pair/code` → `{ code, expires, address, lan }` (6 chiffres, 10 min, usage unique, en
  mémoire) ; `GET /api/devices` → `{ devices, address, lan, code }` ; `POST /api/devices/:id/forget`.
- Sans jeton : `POST /api/pair { code, name }` → `{ token, device }` ; 5 essais faux annulent le code.
  Le jeton (43 caractères) n'est rendu qu'une fois, le serveur n'en garde que le sha256 ; il vaut 90 jours.
- Avec jeton : `GET /api/phone` (le battement de cœur, met `last_seen` à jour), `POST /api/phone/push-token`,
  `POST /api/phone/forget`, et sans changement `GET /api/plans`, `GET /api/plan/:id`, les messages,
  `/api/events`, `answer`, `message`, `dismiss`.
- CORS : l'`Origin` reçu est renvoyé (l'app web sur `localhost:8081`), `OPTIONS` répond 204.

### Le push

- Le serveur poste sur `ESCADRILLE_PUSH_URL` (défaut `https://exp.host/--/api/v2/push/send`, le seul
  service externe), un message par appareil avec jeton push ; jamais relancé, rien n'attend.
- Cinq genres : `waiting`, `permission`, `budget`, `error`, `done`, chacun une fois par (plan, session,
  genre, repère) ; les repères vivent dans la colonne `pushed` de `sessions`, marqués avant l'envoi.
- **La règle des 15 s** : un appareil vu (`GET /api/phone`) il y a moins de 15 s ne reçoit rien ; l'app au
  premier plan l'appelle toutes les 3 s et se met à jour seule.
- `DeviceNotRegistered` dans la réponse d'Expo efface le jeton push de l'appareil.

### L'essai de bout en bout de la session C (2026-11-01, faux claude)

Le serveur sur le port 3710 avec `ESCADRILLE_HOST=0.0.0.0` (`lsof` : `TCP *:3710 (LISTEN)`), une base et un
dépôt jetables, le faux claude, un faux service push sur 3711 qui répond comme Expo, l'app web
(`npx expo start --web`, port 8082, le 8081 tenu par l'Expo de B). Le Mac n'a que `127.0.0.1` et
`192.168.1.x`, sa propre adresse, que la garde compte à raison comme le Mac (200) : le LAN est simulé par
`x-escadrille-remote`. Script : `/private/tmp/claude-501/phase5-e2e/trial.mjs` (hors dépôt). Le journal
de l'export : `docs/phase5-essai-journal.json`. L'essentiel :

```
05:10:18  LAN sans jeton : / /plan/… /app.css /api/plans /api/phone /api/running /api/export → 401 ; POST answer → 401
05:10:18  code 649600 (lan: true, http://192.168.1.x:3710) ; demandé depuis le LAN → 401 ; un code faux → 401 « code faux »
05:10:18  appairé « 649 600 » → d-4dc1b01a ; push-token ExponentPushToken[test] ; / et /api/launch avec jeton → 403 ; SSE ?token= → 200
05:10:34  16 s sans GET /api/phone, puis A et B lancées
05:10:38  push permission A et B : « A demande : Bash curl -s http://x », data.id = req-1
          capture de l'app à 390 px avec ces deux autorisations : docs/phase5-phone-reel.jpg, docs/phase5-phone-reel-suite.jpg
05:12:33  le téléphone autorise A : A débloquée, tour fini, reply en attente ; refuse B avec un motif (« Refusé : Pas de réseau ici »)
05:12:34  app vue il y a moins de 15 s : aucun push
05:12:50  16 s plus tard : reply à l'arrêt de A depuis le téléphone → push permission, puis waiting « A attend ta réponse »
05:12:50  tour 3 : push budget « A : 86 % du plafond » ; « Vu » depuis le téléphone ; A done, pas de push done tant que B tourne
05:12:50  B menée au bout depuis le téléphone → push done « Plan fini : Essai du téléphone » (session: null)
05:12:51  12 push, aucun en double ; forget → 401 sur /api/phone et /api/plan ; la ligne Téléphone : aucun appairé
```

Un seul vrai envoi vers `exp.host` (jeton factice, aucun compte) : `HTTP 200` et
`{ data: [{ status: 'error', message: '"ExponentPushToken[test]" is not a valid Expo push token', details:
{ error: 'DeviceNotRegistered', expoPushToken: 'ExponentPushToken[test]' } }] }` : la forme que le
serveur traite déjà (il efface le jeton push). Aucune erreur dans la console du serveur.

Pas vérifié ici : un vrai iPhone (Expo Go, la permission iOS, une notification reçue), une vraie adresse
LAN distincte du Mac. C'est la marche de 14 h (`docs/phone.md`). La fusion reste au Mac : depuis le
téléphone, `…/merge` répond 403 (`test/phone.test.mjs`).

### L'essai de bout en bout de la session G (phase 6, 2026-11-01, faux claude)

Le serveur sur le port 3084, une base jetable préparée avant le démarrage (un plan de la phase 5, sans
`project`, et son escadrille), le faux claude (`test/fake-claude.mjs`), un faux service push sur 3085.
Deux projets : Alpha (un dépôt git jetable avec un `docs/decisions.md` de 50 lignes) et Bravo (un dépôt
sans). Le LAN est simulé par `x-escadrille-remote`. Script : `$TMPDIR/p6/trial.mjs` (hors dépôt). Journal :
`docs/phase6-essai-journal.json` (les lignes ci-dessous, les push reçus, l'export du plan lancé). Vingt
vérifications, aucune en écart :

```
07:36:30  migration : le plan sans project reçoit Bravo (par son escadrille) ; plan.project dit Bravo
07:36:30  deux escadrilles, une par projet
07:36:33  --append-system-prompt d'Alpha : « Fichier : …/docs/decisions.md » puis les lignes 11 à 50 (40 lignes)
07:36:35  --append-system-prompt de Bravo : aucune section « La mémoire du projet »
07:36:35  POST /api/memory : Alpha écrit dans docs/decisions.md ; Bravo crée .escadrille/memoire.md
07:36:35  réglages d'Alpha (budget 2, réseau api.github.com) : le plan écrit après les porte, le budget 1 d'une
          session est gardé ; budget 9 et réseau null ensuite : le plan écrit ne bouge pas
07:36:35  plan de Bravo : project = Bravo, rien de pré-rempli (aucun réglage stocké)
07:36:35  appairage, jeton push, 16 s sans battement
07:36:51  plan Alpha lancé (A, B) → push « Alpha · A demande : Bash curl -s http://x », corps « Plan Alpha »
07:36:51  ?project= : /api/plans (Alpha 1, Bravo 2, sans filtre 3), /api/escadrilles (2 et 3), /api/running
          (ours d'Alpha seulement, others entier), /api/phone (1, 2, 3, chaque plan dit son project)
07:36:51  depuis le LAN avec jeton : /api/memory et /api/project/settings → 403 ; console du serveur vide
```

Aussi : `test/speech.test.mjs` 3 verts (sans `SpeechRecognition` le bouton est désactivé avec sa raison,
rien n'est lancé ; avec, le texte entre au curseur et Échap arrête ; `not-allowed` donne une ligne sous le
champ). `node --test 'test/*.test.mjs'` : **85 tests, 85 verts** (hors bac à sable, voir plus bas).

**Écarts trouvés** (aucun dans le code de calmdev)

- **Le bac à sable d'une session fait échouer les tests, pas le code.** (1) Node y lance `git` par le PATH
  de Dev, dont une entrée (`~/.altimate/bin`) est refusée : `spawnSync git EPERM`. Avec
  `PATH=<node>/bin:/usr/bin:/bin` cela passe. (2) `$TMPDIR` y est sous `/private/tmp/claude-501/`, que
  `GET /api/projects` écarte exprès (`/tmp`, `/private/tmp`) : `test/multiproject.test.mjs` ne retrouve
  pas son projet jetable. Sur le Mac (`$TMPDIR` sous `/var/folders`) ou hors bac à sable : 85 verts.
- **`node --test` sans motif ramasse `test/control.probe.mjs`** (une sonde qui demande un vrai `claude`) :
  une ligne rouge qui n'en est pas une. Le motif `'test/*.test.mjs'` de CONTRIBUTING.md est le bon.
- Le journal d'un essai voit le premier push d'un plan seulement si l'on attend ; le script s'arrête au
  premier, A et B en émettent chacune un (voir l'essai de la phase 5 pour le compte complet).

Pas vérifié ici : un vrai `claude` (le sandbox n'en a pas), un vrai envoi push, l'iPhone, un second Mac.

## Les worktrees (`lib/worktree.mjs`)

`create` fait `git worktree add <root>/.claude/worktrees/<plan>-<session> -b escadrille/<plan>/<session>`
depuis la branche courante, ajoute `.claude/worktrees/` et `.escadrille/` (le fichier de passation) à
`.git/info/exclude`, et rend le cwd de la
session (le même sous-dossier si le dossier du plan est un sous-dossier du dépôt). `merge` exige un
`git status --porcelain` vide, fait `git merge --no-ff`, et sur conflit `git merge --abort` puis rend
`{ conflict: true, files }`. `remove` supprime le worktree et garde la branche. Un dossier sans dépôt
git est lancé sans worktree, dans le dossier du plan.

Après la fusion d'une session finie, le serveur arrête son processus et supprime le worktree. Une
fusion avant `done` laisse tout en place.

## Les vagues, la reprise, l'arrêt

Une session `later` démarre quand toutes celles qu'elle attend (`after`, ou toute la vague précédente)
sont `done` et fusionnées. Avec `autoMerge: true` sur le plan (`POST /api/plan/:id/settings`), la
fusion suit `done` ; sinon elle attend le bouton. Au démarrage, le serveur relance avec `--resume` les
sessions en mode `page` non finies (un tour interrompu passe en `waiting` avec une attente qui le
dit). Sur SIGINT et SIGTERM, il ferme le stdin de tous les processus, tue après 3 s, puis quitte.
`/terminal` arrête le processus et ouvre `claude --resume <session_id>` dans le worktree (mode
`terminal`) ; `/resume` revient dans la page.

## La robustesse (phase 7)

Trois défauts vus la nuit du 2026-11-01, tenus par `test/robustness.test.mjs` (faux claude, base jetable).

### Le reste du plafond

Le `budget` d'une session dans le JSON du plan est le contrat : ce que la session peut dépenser en tout,
passations, arrêts et redémarrages compris. Chaque démarrage d'un processus (lancement, message qui
reprend, passation, reprise au démarrage, relèvement) reçoit le **reste** :
`--max-budget-usd = max(min(budget, 0,50), budget − usage.cost)`, arrondi au cent (jamais sous 0,50 $, ni au-dessus d'un plafond plus petit) (`remaining(budget, spent)` de
`lib/queue.mjs`). `usage.cost` est le coût cumulé de la ligne (ce que `live.costBase` porte). Le plancher
de 0,50 $ laisse à une session plafonnée de quoi finir un tour ; le serveur tient le plafond lui-même à
chaque fin de tour, comme avant.

**La reprise** (défaut de phase 8) : sous `--resume`, Claude Code repart du coût déjà payé par cette session
Claude, dans `total_cost_usd` comme pour `--max-budget-usd` (vu par le pilote le 2026-11-01 : la reprise
retombait aussitôt au plafond ; le faux claude des tests fait de même). Le serveur garde donc `usage.claude =
{ id, cost }`, le coût de la session Claude en cours ; une reprise de cet `id` reçoit
`--max-budget-usd = reste + usage.claude.cost`, et `usage.cost = costBase + total_cost_usd` avec
`costBase = usage.cost − usage.claude.cost` : le passé compté une fois, le plafond du plan jamais dépassé. Un
premier tour sous le coût restauré (un Claude Code qui ne restaurerait pas) repasse au compte du processus seul.

`POST /api/plan/:id/session/:sid/budget { budget }` (nombre > 0, Mac seulement, 400 `{ error }` sinon)
→ `{ ok, budget, remaining, restarted }`. Le serveur écrit `budget` dans la session du JSON du plan
(`plans/<id>.json`, comme `/settings` pour `network`), puis :

- si la session est **plafonnée** (pas de processus vivant et `usage.cost >= ancien plafond`, ou santé
  `error` dont `why` parle du plafond : le tour que Claude Code a lui-même coupé par `--max-budget-usd`),
  il redémarre le processus en `--resume` avec le reste, envoie « Ton plafond passe à <N> $ ; continue. »,
  la session repasse `running`, l'attente `reply` est retirée ; `restarted: true` ;
- sinon le nouveau plafond s'applique au prochain démarrage ; `restarted: false`.

Dans les deux cas un message `system` le dit (« Plafond relevé à 8 $ (reste 3,20 $) : processus
relancé. » ou « … : il s'appliquera au prochain démarrage. »). La page : dans la carte d'une session
plafonnée, une ligne repliée « Plafond atteint · relever à … $ » (un champ, un bouton).

### La fusion en conflit

Quand la fusion **automatique** d'une session finie (`autoMerge` ou `autoMergeIfGreen`, tests verts après le clic
`run-tests`) est en conflit, le serveur écrit à cette session seule, après son tour : « Ta fusion dans main est en conflit :
merge main dans ta branche, résous, `node --test`, puis redis-toi finie. » (message `system` dans la page,
processus repris s'il était arrêté). Elle quitte `done` (`running`, puis `waiting` à la fin du tour) ; son
prochain `done` redemande les tests, puis retente la fusion. Un message par conflit, clé (tête de la branche, fichiers) gardée dans
`worktree.conflictTold`, trois au plus : une session qui se redit finie sans rien commiter ne reçoit rien de
plus et reste en `error` pour le développeur. Le bouton Fusionner n'envoie rien. Les fusions d'un même dépôt
passent une à une (`lib/worktree.mjs`) : deux sessions finies ensemble ne voient plus le conflit de l'autre.

### Le plan non suivi du checkout

Un fichier **non suivi** du checkout principal que la branche apporte aussi (un plan que le serveur vient
d'écrire dans `plans/`) ne bloque plus : `merge` le met de côté (en mémoire et copié sous
`<git-common-dir>/escadrille-aside/`), fusionne, puis remet la version du disque (telle quelle sur un conflit,
par-dessus la fusionnée si elles diffèrent, qui apparaît alors modifiée). Choisi plutôt qu'un commit du plan par
le serveur : rien ne s'écrit dans l'historique du projet sans session, pas de course sur `index.lock` avec une
fusion, et la règle vaut pour tout fichier non suivi sans en perdre un octet. Un fichier suivi modifié refuse
toujours ; jamais de `reset --hard` ni de `clean`.

Le réseau des réglages d'un **plan** (`POST /api/plan/:id/settings`, et son champ dans la page) prend ce que
prennent les réglages du projet (`validateNetwork`) : un nom d'hôte, une IPv4 ou `localhost`, avec un port ou
non (`127.0.0.1:3318`). Tenu par `test/defects8.test.mjs`.

### La file

Réglage de projet `parallel` (entier ≥ 1, dans `SETTING_KEYS` ; `GET /api/project/settings` le rend,
`null` sans réglage ; `POST` l'accepte, `null` l'efface). Sans réglage, tout part comme avant. Avec,
`launch` et `checkWaves` ne démarrent une session que tant que le projet compte moins de N sessions
**actives** : `running` ou `waiting` avec un processus vivant, tous plans du projet confondus.

Une session refusée reste `todo` (une `later` dont la vague est prête passe `todo`) avec `queued: true`
dans son entrée de `state` (colonne `queued` de `sessions`, 0 ou 1) et la ligne `claude` « En file :
N sessions tournent déjà ». La file avance seule (`advanceQueue(project)`) après `onDone`, après chaque
`stopProcess` (au tick suivant : une passation qui relance son processus garde sa place), et à
l'arrivée d'un résultat qui arrête le processus (plafond) : les sessions `queued` du projet partent dans
l'ordre (plan le plus ancien, puis id) tant que `canStart` dit oui. `POST /api/launch` rend
`{ ok, launched, queued }`. La page écrit « en file », en gris, à côté du nom de la session.

### `canStart` et `lib/queue.mjs`

`lib/queue.mjs` tient les règles pures, testables sans serveur :

- `remaining(budget, spent)` : le reste ci-dessus ;
- `queueRule({ parallel, active })` → `{ ok, why }` : `ok` si `parallel` est absent ou `active < parallel`,
  sinon `why` = « En file : N sessions tournent déjà » ;
- `isFinished(plan, state)` : toutes les sessions `done` et fusionnées (ou sans worktree) ;
- `createQueue({ countActive, parallelOf, guards })` → `{ canStart(plan, session), addGuard(fn) }` :
  `canStart` → `{ ok, why }` passe les gardes dans l'ordre, la file d'abord ; un garde
  `(plan, session) → { ok: false, why } | null` refuse avec sa raison. La session L y branche les siennes
  (session à relire, plafond du plan, limite du quota) ; aujourd'hui seule la file y est.

Le serveur expose à côté `launchPlan(planId)` (toutes les `todo` du plan, par `canStart`) et
`planFinished(planId)`, que la rafale (K) et l'autonomie (L) appellent.

### La reprise seule

Au démarrage du serveur, une session `page` qui était `running` (tour interrompu) est relancée en
`--resume` (avec le reste) et reçoit aussitôt « Le serveur a redémarré pendant ton tour ; reprends où tu
en étais, puis finis par ton bloc escadrille:state. » ; elle reste `running`, ses autorisations en
suspens sont retirées, une entrée `{ kind: 'info', text: 'Reprise seule après redémarrage' }` entre dans
`pending`, un message `system` le dit. Une seule tentative : si ce tour sort en erreur (résultat en
erreur ou processus mort), la session passe `waiting` avec l'attente `reply` comme tout tour fini ou
interrompu ; le redémarrage suivant ne la relance que si elle est de nouveau `running`. Une session
`waiting` reprend comme avant (processus en `--resume`, rien d'envoyé). À l'arrêt du serveur (SIGINT,
SIGTERM), les processus sont arrêtés sans changer l'état des lignes : un tour en cours reste `running`
pour être repris.

### Un plan lancé ne perd pas ses sessions

Le 2026-11-01 à 08:49, un planificateur a réémis son bloc `escadrille:plan` sur un plan lancé et le JSON entier a
été remplacé : cinq sessions en cours ont disparu du plan. Désormais une nouvelle version d'un plan déjà connu
(`POST /api/plan` ou le bloc d'un planificateur) peut ajouter des sessions et changer celles qui sont `todo` ou
`later` ; une session lancée (`running`, `waiting`, `done`) ne peut ni disparaître ni changer
(`planChangeRefusals(ancien, lignes, nouveau)` de `lib/queue.mjs`). Sinon `POST /api/plan` répond 409
`{ error, sessions }` (une ligne par session refusée) et rien n'est écrit ; le bloc du planificateur est refusé de
même, un message `error` dans l'escadrille le dit.

### Jamais de prune global

Le 2026-11-01 à 09:08, les entrées `.git/worktrees/<nom>` des worktrees S, O et V ont disparu pendant que leurs
sessions tournaient : `create` lançait un `git worktree prune` global quand un dossier existait sans être
enregistré, et un prune lancé d'un bac à sable (ou d'un test sur le vrai dépôt) élague tout worktree dont il ne voit
pas le dossier. Désormais `lib/worktree.mjs` ne lance jamais de prune : seule l'entrée d'administration de CE nom
est retirée, et seulement si son `gitdir` pointe vers le dossier attendu ; un retrait passe par
`git worktree remove --force <dossier>`. Sous `node --test` (`NODE_TEST_CONTEXT` défini), `create`, `merge` et
`remove` refusent un dépôt dont le git commun est celui du serveur : un test travaille toujours sur un dépôt jetable
sous `$TMPDIR` (tenu par `test/worktree.test.mjs`).

### Les node_modules liés

À sa création, un worktree reçoit, pour chaque `package.json` suivi dont le dossier a un `node_modules` dans le
checkout principal mais pas dans le worktree, un lien symbolique vers celui du checkout ; `node_modules` est ajouté à
`info/exclude` (le lien n'est jamais commité). `create` rend la liste `linked`, gardée dans `worktree.linked` de la
ligne et ajoutée aux `addDirs` de la session à chaque démarrage.

## Le contrat d'API (tenu par `test/api.test.mjs`)

- `GET /api/plan/:id` → `{ plan, state, log, estimate }`. Le plan rendu porte `network` (liste de
  domaines, vide par défaut) et chaque session `budget` (nombre USD) s'il est dans le JSON. Chaque entrée
  de `state` a `sessionId`, `mode` (`page` | `terminal` | null), `worktree { path, branch, cwd, root,
  merged }` ou null, `usage { input, output, cost, weekly, context }` ou null (`context` : part de la
  fenêtre, 0..1), `budget` (nombre USD : celui du plan, sinon `DEFAULT_BUDGET_USD`), `handoffs` (liste de
  `{ n, at, file, text }`, vide tant qu'il n'y a pas eu de passation), `summary` (chaîne ou null, le
  dernier bloc state), `open { folder, dev, url }` (le dossier à ouvrir, `dev` vrai si son
  `package.json` a un script `dev`, `url` du dev server qui tourne ou null), et `pending`, liste d'entrées `{ id, kind, text, at }` dont le `kind` est :
  - `permission` : `{ id, kind, tool, input, text, network, at }` (`network` : un accès hors localhost,
    que « toujours » ne couvre jamais) ;
  - `reply` : `{ id, kind, stop, text, summary, at }` quand le tour est fini (`text` est la ligne
    `claude` du bloc state, sinon la fin du dernier message ; `summary` le champ du bloc, ou null) ;
  - `alert` : `{ id, kind, what: 'budget' | 'context', pct, text, at }` (`pct` : fraction 0..1, peut
    dépasser 1 pour le budget) ;
  - `info` : `{ id, kind, text, at }`, sans bouton d'action : une passation faite, un repli envoyé, des tests rouges.
  - `review` : `{ id, kind, files, text, at }` : des fichiers sous garde à relire (`docs/autonomy.md`) ; « Vu, continuer ».
  - `ask-budget` : `{ id, kind, cost, budget, limit, text, at }` : le plan passerait `askAboveUsd` ; « Continuer ».
  - `reply` gagne `fallback` et `fallbackAt` (ISO) quand l'arrêt suit son repli (Guidé, Autonome).
  Il n'y a pas de champ `alerts` : tout passe par `pending`.
- `GET /api/plan/:id/session/:sid/messages` → `{ messages: [{ seq, role, text, data, at }] }`, role parmi
  `claude`, `dev`, `activity`, `ask`, `system`.
- `POST …/session/:sid/message { text }`, `…/answer { id, allow, always }`, `…/merge` (`{ ok }` ou
  `{ error, conflict: true, files }`, code 409), `…/terminal`, `…/resume`, `…/stop` → `{ ok }`.
- `POST …/session/:sid/dismiss { id }` → `{ ok }` : retire une entrée `alert` ou `info` de `pending`
  (400 pour un autre kind ou un id inconnu).
- `POST /api/plan/:id/settings { autoMerge?, network? }` → `{ ok }` ; un champ absent ne change pas ;
  `network` : liste de noms d'hôte validée (400 `{ error }` sinon), le `allowedDomains` du bac à sable à
  chaque démarrage d'une session.
- `POST …/session/:sid/open` → `{ ok }` : ouvre le dossier avec `open` (macOS).
- `POST …/session/:sid/devserver` → `{ ok, url }` : `npm run dev` dans le dossier, `url` la première
  `http://localhost:<port>` ou `http://127.0.0.1:<port>` lue dans les 20 s, sinon `null` ; un seul par
  session ; 400 sans script `dev`.
- `GET /api/running` → `{ ours: [{ kind: 'session' | 'devserver' | 'worktree', plan, session, pid, cwd, url, since }], others: [{ pid, cwd, since, args }] }`
  (`pid` null pour un worktree, `url` null hors dev server, `since` ISO ; `others` : les autres Claude
  Code du Mac, lecture seule).
- `POST /api/running/stop { kind, plan, session }` → `{ ok }` (400 `{ error }` : rien à arrêter, un
  worktree aux changements non commités ou encore occupé, un `kind` inconnu).
- `POST /api/running/stop-all` → `{ ok, stopped: [{ kind, plan, session }] }` : les processus `claude` et
  les dev servers du serveur ; pas les worktrees.
- `POST /api/launch { plan }` lance toutes les sessions `todo`, `{ ok, launched: [ids] }` ; `{ plan, session }` une seule.
- SSE `/api/events?plan=:id` : `change`, plus `message` `{ session, message }` à chaque message et `pending`
  `{ session }` quand une attente apparaît. `/api/events?running=1` : `change` quand un processus
  `claude` ou un dev server du serveur démarre ou s'arrête, ou qu'un worktree est retiré.

Tables : `sessions` gagne `session_id`, `mode`, `worktree`, `usage`, `pending` (JSON) en phase 3, puis
`handoffs`, `summary`, `alerted` (JSON) en phase 4 ; `session_messages (plan, session, seq, role, text,
data, at)` ; le journal (`log`) garde une ligne à chaque changement d'état (statut, arrêts, santé, ligne
`claude` : une passation demandée ou faite en écrit une). Phase 5 : la table `devices (id, name,
token_hash, expo_push_token, created, last_seen, revoked)` et la colonne `pushed` (JSON) de `sessions` ;
les routes du téléphone sont dans « Le téléphone (phase 5) ».

Phase 6 (`docs/multiproject.md`, tenu par `test/multiproject.test.mjs`) : la colonne `project` de `plans`
et la table `project_settings (project, json, at)`. `GET /api/plans`, `/api/escadrilles`, `/api/running`
et `/api/phone` acceptent `?project=<chemin absolu encodé>` ; chaque plan (et `plan.project` de
`GET /api/plan/:id`), chaque entrée de `ours` disent leur `project` (ou null). `GET /api/projects` :
chaque projet a `{ path, name, recent, escadrilles, plans }`. Nouvelles routes, du Mac seulement :
`GET|POST /api/project/settings` (`{ project, budget, network, model, addDirs, parallel, stored }`) et
`GET|POST /api/memory` (`{ file, lines: [{ n, text }], total }`, `{ ok, file }`). Le titre d'un push
devient `<projet> · <texte>`, son corps le titre du plan.

## L'essai réel du 2026-11-01

Une session Sonnet lancée par `/api/launch` dans un dépôt jetable : worktree créé, première demande
(`mkdir … && git commit`, hors liste blanche) accordée par `/answer`, bloc state lu (`stops: [0]`,
`waiting`, attente `reply` avec la ligne `claude`), demande réseau `curl https://example.com`
remontée avec `network: true` et accordée, `done`, puis `/merge` : commit de fusion `--no-ff`,
worktree supprimé, branche gardée, dépôt propre, plus aucun processus. Usage lu : 120 923 tokens
lus, 954 écrits, 0,096 $. Les tests : `node --test 'test/*.test.mjs'` (le pilote et l'API contre
`test/fake-claude.mjs`, les worktrees sur un dépôt temporaire).

### Ce que l'essai de bout en bout a montré (page, 2 sessions Sonnet, `docs/phase3-*.jpg`)

- Les deux autorisations arrivent dans « À faire » ; une fois accordées, les sessions finissent seules
  (0,09 $US et 14 % hebdo chacune, 0,10 $US estimé). Les deux fusions par bouton ont donné deux commits
  `--no-ff` et le serveur a retiré les worktrees.
- Pour tester une autorisation, la commande doit sortir de la liste sûre de Claude Code : `echo` ne
  demande rien, `mkdir /tmp/x` oui.
- Le dossier du plan n’a pas à être propre pour fusionner (phase 7) : seul un fichier non commité qui est aussi dans la branche (`git diff --name-only HEAD...branche`) bloque, et l’erreur le nomme ; le reste du travail en cours reste en place (`blockingFiles` de `lib/worktree.mjs`) ; un plan dont le dossier est un worktree fait
  fusionner dans la branche de ce worktree, pas dans main.

## L'essai de bout en bout de la session I (phase 7)

`node scripts/essai-phase7.mjs` → `docs/phase7-essai-journal.json` : 18 OK, 0 échec.

- Chaque étape est un test d'intégration avec son serveur, sa base et son dépôt jetables, le faux claude, le faux gh
  et le faux Linear ; le journal dit le test de chaque ligne.
- Puis un serveur vivant sur 3095 : `GET /api/usage` (trois chiffres, `null` sur une base neuve), `GET /api/access`
  (GitHub et Linear, la ligne Autonomie) ; le mode auto allumé passe les sessions en ambre.
- Écart : ce ne sont pas toutes les étapes sur un seul serveur continu ; chaque test démarre le sien.
- Les tests dans le bac à sable d'une session : 26 échecs `spawn git EPERM` (une entrée du PATH refusée) ;
  avec un PATH réduit, 258 verts sur 260, 1 ignoré, 1 échec (`multiproject` migration, `$TMPDIR` sous `/private/tmp`).
- Captures manquantes : Mémoire, réglages du projet (clé Linear, Autonomie), « Ouvrir la PR », un récit, la
  progression (jeu), la pré-revue, la liste des modèles, une doc rendue (`/docs/flot.md`).
- Risque laissé : `node_modules` du checkout est lié dans le worktree et ouvert en écriture ; une session peut modifier les dépendances que le checkout exécutera.
- Les tests de fusion (`testCommand`) tournent hors bac à sable : jamais sans le clic « Lancer les tests » dans À faire.

## Résumé du pilote (7 nov.)

`GET /api/pilot/brief?project=<chemin>` : une ligne par session vivante (processus en cours, non fusionnée) : `plan/session · état · dernier arrêt (120 car.) · autorisation en attente · coût/budget`, puis `À toi : n`. `Accept: application/json` rend `{ project, sessions, count }`. Calculé depuis `flowNow` et `asksNow`, sans requête de plus (`lib/pilotbrief.mjs`). Lecture seule, mêmes droits que `/api/running` : LAN sans jeton → 401, appareil appairé → 403.
