Le flot voulu et les règles du projet, lus par les sessions.

# calmdev

Une escadrille, c'est plusieurs appareils qui volent en formation derrière un chef de patrouille.
Ici : plusieurs sessions Claude Code qui travaillent en parallèle sur une même idée, avec un plan,
un pilote qui les surveille, et un développeur qu'on ne dérange que quand il faut.

Le but : **décharger mentalement le développeur à l'ère de l'IA.** Il arrive avec une idée de
fonctionnalité trop grosse pour une seule session (pas assez de contexte, pas assez de mémoire), il
l'explique en quelques mots, et l'outil fait le reste : les questions, le plan, les sessions, le suivi,
les notifications, le journal.

## Le flot voulu (les mots de Dev, mis en ordre)

1. **Une idée, un chat.** L'application s'ouvre sur un chat, rien d'autre. Le développeur explique son
   idée de feature en quelques mots (au clavier ou à la voix : la dictée est une fonction de base).
2. **L'analyse et les questions.** Pour démarrer, Claude (Fable ou Opus) analyse tout ce à quoi il a
   accès dans le projet où calmdev est installé (le code, les CLAUDE.md, les skills, la mémoire, le
   git, les tickets) et pose au développeur toutes les questions nécessaires pour réaliser la tâche au
   mieux selon ses bonnes pratiques. Il propose aussi les plugins, skills et règles à installer pour
   la session ou pour le projet.
3. **Le plan en flot.** Une fois prêt, un schéma façon n8n : toutes les sessions prévues pour ce projet,
   leurs dépendances (ce qui tourne en parallèle, ce qui attend quoi), le modèle à utiliser pour
   chaque tâche, et l'estimation d'usage de Claude (en tokens et en % du quota hebdomadaire). Sous le
   flot, un gros bouton : **« Lancer la multi-session »**.
4. **Le lancement et le suivi.** Chaque session parallélisable est lancée (un terminal par session,
   avec son prompt). En cas de doute, la session notifie le développeur et lui fait revoir la tâche en
   cours avec un récapitulatif simple de là où elle en est, et un bouton pour ouvrir le projet en
   local, faire sa QA et donner son retour.
5. **Les tokens, visibles.** Chaque session du flot montre clairement son usage : tokens consommés, %
   du quota hebdomadaire, % de la session en cours. Une session trop gourmande, ou qui sort de son
   contexte, est rafraîchie régulièrement (passation dans un fichier, session fraîche) pour éviter
   l'usage intensif de tokens.
6. **Le téléphone.** Une petite app Expo (`phone/`, ouverte dans Expo Go) parle au Mac sur le wifi
   (`./run.sh --lan`). On l'appaire une fois avec un code à 6 chiffres affiché sur le Mac (ligne
   « Téléphone ») ; elle suit le flot, répond aux autorisations et aux arrêts, et reçoit une notification
   quand une session attend, demande une autorisation, passe 80 % de son budget, casse, ou quand le plan
   est fini. Lancer, fusionner et arrêter restent au Mac. Sans jeton d'appareil, le serveur ne répond à
   rien au LAN. Pas à pas : `docs/phone.md`, « La marche de 14 h ».
7. **La voix.** La dictée (speech to text) partout où l'on écrit à Claude dans l'app.

**La lecture du canevas** (le Flot, la vue d'un plan ; `public/canvas.js`) : une phase se lit de haut en bas, une
rangée par vague, la première en haut ; les phases se suivent de gauche à droite, un cadre chacune, la plus ancienne à gauche.

**Où Dev intervient, l'issue de chaque phase, les ETA** (phase 13, session FL ; demande de Dev du 2 novembre : « voir
dans le flow les endroits où j'aurais besoin d'intervenir, l'issue de la phase, et les ETA sur chaque carte et chaque
phase »). Calcul dans `lib/projectflow.mjs` et `lib/eta.mjs`, dessin dans `public/canvas.js`, tenus par
`test/projectflow.test.mjs`, `test/eta.test.mjs` et `test/canvas.test.mjs`.

- **Les points d'intervention.** Une carte qui attend le développeur (`waitingFor` : `dev`, `permission`, `review`,
  `merge`) porte une pastille « À toi · Verbe » à la place de son état, et son contour prend l'encre d'attente ; le verbe
  (`verb`) est **Juger** (une réponse à un arrêt de goût, de données, de sécurité ou de release : `human`), **Répondre**,
  **Autoriser**, **Relire** (revue stricte) ou **Fusionner**. Un clic sur la pastille fait le geste : la fusion se fait
  là (`POST /api/plan/:id/session/:sid/merge`), les autres mènent au fil de la session. Les autres cartes restent calmes ;
  le bouton « Ce qui m'attend » de l'en-tête reste l'action principale de la page. Une session finie et non fusionnée est un
  geste du développeur (Dev, 2 novembre 08:35 : « je ne vois pas où je fusionne ») : elle est `merge` quand le plan fusionne
  à la main (ni `autoMerge`, ni kit, ni fermé), jamais confiée au pilote ; elle va dans « À toi » de l'accueil et dans « À
  faire » de la page du plan avec le bouton Fusionner. Une session fusionnée n'attend plus rien, même si une réponse est
  restée en attente sur sa ligne (défaut PX du 2 novembre).
- **L'issue de chaque phase.** Chaque plan se termine par un nœud de fin (`ends`, `<plan>/main`, rangée « À la fin »
  sous la dernière vague, relié par les arêtes `merge` des dernières cartes) qui dit ce qui se passe après : « Enchaîner
  sur Phase 13 », « Juger les captures », « QA de la phase » ou « Rien ensuite ». La suite vient du champ **`next`** du
  plan (`lib/blocks.mjs` : l'id d'un plan, ou `judge`, `qa`, `none`) ; sans `next`, c'est le plan suivant du projet par
  date de création ; sans suivant, rien. Quand tout est fusionné et que le plan suivant n'est pas parti, le nœud dit
  « attend ton clic » avec la pastille « À toi · Lancer » et le bouton qui le lance (`POST /api/launch`) : rien ne part
  sans ce clic, ni une session ni le pilote. Un plan fini ne se replie pas tant que son nœud de fin attend ce clic. Avant,
  le nœud dit « quand tout est fusionné · 3 sur 6 » ou « 2 gestes à toi avant ».
- **Les ETA** (`lib/eta.mjs`). Chaque carte qui n'est pas finie affiche une heure de fin estimée (« vers 11:40 »), la
  fourchette et sa base au survol ou dans le panneau. La durée vient de l'historique réel, la table `log` (une ligne par
  changement d'état) : le temps travaillé d'une session est la somme de ses intervalles en `running`, le temps passé à
  attendre (intervalles en `waiting` ou `paused`, le développeur ou le pilote) est compté à part et jamais inclus. Les
  sessions finies sont groupées par type de tâche et par modèle (le découpage de `lib/learning.mjs`, `kindOf` et
  `canonicalModel`) et l'on prend la médiane (fourchette : premier et troisième quartile) ; sous deux sessions dans le
  groupe, repli sur le type seul, puis sur toutes les sessions finies du projet (`basis`). Une session qui tourne : son
  début plus ce qu'elle a attendu plus la médiane (ce qu'elle a déjà travaillé est dépensé) ; passé la médiane, « au-delà
  de l'estimation ». Une session en file : la fin la plus lointaine de ce qu'elle attend (`after`, la vague d'avant ; une
  dépendance fusionnée est déjà là) plus la médiane. L'ETA d'une phase est le chemin le plus long : la fin la plus lointaine
  de ses cartes. Sans historique, « — » : jamais un chiffre inventé.

« Tu » dans ce flot, c'est Claude Code (Fable ou Opus) : c'est lui qui analyse, questionne, planifie,
lance et surveille. calmdev est l'outil qui lui donne l'écran, le plan, le journal et le téléphone.

## Où l'on en est : la phase 7, l'autonomie et les connecteurs

La phase 7 (version 0.2.0) laisse calmdev travailler seul sous garde : trois modes d'autonomie par projet, une
rafale de tâches jusqu'à la limite, la PR et les tickets sur un clic, la revue de code et sa pré-revue, la mesure
de l'attention, Linux. Les garde-fous fixes tiennent dans tous les modes (`docs/autonomy.md`).

Ce que la phase 7 a ajouté :

- **Les connecteurs** (`docs/connectors.md`) : « Ouvrir la PR », gh et Linear sur un clic.
- **La robustesse** : le reste du plafond, la file par projet, la reprise après un redémarrage.
- **L'autonomie** (`docs/autonomy.md`, `docs/policy.md`) : Surveillé, Guidé, Autonome ; arrêts typés et replis.
- **Jusqu'à la limite** (`docs/burst.md`) : la rafale, le mode auto éteint par défaut.
- **La revue** (`docs/review.md`, `docs/prereview.md`) et **la carte** (`docs/architecture.md`).
- **La mesure** (`docs/mesure.md`), **la progression** (`docs/game.md`), **les modèles** (`docs/models.md`).
- **Linux** (`docs/linux.md`), **le site** (`site/DEPLOY.md`), **la passe design** (`docs/phase7-design/`).

### Avant : la phase 6, le multiprojet, la mémoire et la première release

Le serveur (`server.mjs`, Node 22.13+, sans dépendance) tient dans une base SQLite les escadrilles
(un chat chacune), les plans et l'état de chaque session lancée, qu'il lit lui-même dans son flux. La page est en
deux écrans qui partagent la même coque (`public/app.css`, règles d'écran d'app du taste skill) :

- **`/` et `/e/:id`, « Nouvelle escadrille »** (`public/index.html`) : le chat. On choisit un projet
  parmi ceux que Claude Code connaît (`~/.claude.json`), le modèle qui planifie, et l'on dit son idée au
  clavier ou à la voix (Web Speech, `fr-FR`). Le serveur lance alors **une session de planification**
  Claude Code dans ce projet (`claude -p` en stream-json, un processus par escadrille, voir
  `lib/planner.mjs`), en lecture seule (`Read`, `Glob`, `Grep`, `git log`, `ls`, `cat`), avec le
  skill `.claude/skills/plan/SKILL.md` en complément de system prompt. Ce qu'elle lit s'affiche en une
  ligne, ses questions arrivent dans le chat, les réponses repartent sur son stdin. À droite : le projet
  tel qu'elle le trouve (branche, consignes, mémoire, skills) et la session elle-même (tokens, part du
  contexte, quota hebdo, coût au tarif public).
- **`/plan/:id`** (`public/plan.html`) : le plan d'une escadrille. Les vagues, les cartes de sessions,
  les arrêts, le journal, l'usage réel de chaque session. **« Lancer la multi-session »** démarre les
  sessions de la première vague *dans la page* ; les suivantes partent seules quand ce qu'elles attendent
  est fini et fusionné. Le bloc « À faire » en tête rassemble ce qui attend le développeur
  (autorisations, sessions à relire) ; chaque session a son onglet de chat, où l'on lui écrit ou la dicte.
  Voir `docs/phase3-a-faire.jpg` et `docs/phase3-chat.jpg`.

Ce que la phase 6 a ajouté (`docs/multiproject.md`, `docs/access.md`) :

- **Le multiprojet** : les escadrilles, les plans, ce qui tourne et le téléphone se rangent par projet
  (`?project=`), chaque projet a ses réglages (budget, réseau, modèle, dossiers ajoutés : des défauts, un plan
  écrit reste un contrat) ; un plan d'avant se rattache à son projet au démarrage.
- **La mémoire** : `<projet>/docs/decisions.md`, sinon `.escadrille/memoire.md` ; le planificateur en reçoit
  les 40 dernières lignes, les sessions y ajoutent une ligne ; l'écran « Mémoire » la montre.
- **La voix** partout où l'on écrit à Claude, **le polish** de chaque écran, la vue **Accès**
  (`/#acces`), le titre d'un push qui commence par le nom du projet.
- **La première release** : tag local `v0.1.0`, rien de poussé ; le test sur l'iPhone et le dépôt public
  sont à Dev. Essai : `docs/phase6-essai-journal.json`.

Ce que la phase 4 a ajouté (contrat d'API dans `docs/sessions.md`, une seule fois) :

- **Le plafond en dollars** : chaque session a un `budget` (5 $ par défaut, dit par le plan) ; Claude Code
  l'arrête (`--max-budget-usd`) et le serveur le tient aussi. L'écran dit « Plafond atteint ».
- **Les alertes** : à 80 % du budget et à 60 % de la fenêtre de contexte, une ligne dans « À faire »,
  une seule fois par seuil.
- **La passation** : à 75 % de la fenêtre, la session écrit `.escadrille/passation.md` (jamais commité),
  le serveur la lit, arrête le processus et relance une session fraîche, même branche, avec la passation
  puis le prompt d'origine. Le développeur est prévenu, rien ne lui est demandé.
- **Le planificateur frugal** : un hook refuse la lecture entière d'un fichier de plus de 300 lignes, d'une
  image, d'une transcription ou d'une base (`docs/frugal.md`). Avant : 363 239 tokens lus et 7 appels au
  modèle pour poser les questions de la phase 3. Après (mesuré en phase 5) : 219 069 tokens en 4 lectures et 1 tour avant les questions (`docs/frugal.md`).
- **L'estimation** pondérée par la longueur du prompt, et honnête sur les sessions interactives qu'elle ne
  voit pas (`docs/estimation.md`).
- **Le téléphone** (phase 5) : l'app Expo, l'appairage par code, la garde par jeton (401 au LAN sans
  jeton, 403 hors des routes du téléphone), les notifications par le service push d'Expo, jamais à une
  app ouverte depuis moins de 15 s (`docs/phone.md`, essai : `docs/phase5-essai-journal.json`,
  `docs/phase5-phone-reel.jpg`).
- **La garde du Mac** : le serveur n'écoute que sur `127.0.0.1` (`./run.sh --lan` pour le téléphone), le
  réseau d'un plan est une liste de domaines vide par défaut, « Sur ce Mac » montre ce qui tourne à cause
  de calmdev et les autres `claude` du Mac, avec arrêt.
- **Le résumé et « Ouvrir le projet »** : une session en attente dit ce qui est fait et ce qui reste, et
  ouvre son dossier ou son dev server en un clic.

Essai de bout en bout (faux claude, `docs/sessions.md`) : `docs/phase4-essai-journal.json`,
`docs/phase4-passation.jpg`, `docs/phase4-flot-reel.jpg`. Les captures « À faire », « Sur ce Mac » et
Réseau (`docs/phase4-a-faire.jpg`, `phase4-mac.jpg`, `phase4-reseau.jpg`) viennent de la session D,
faites sur des données de test.

Ce que la phase 3 avait changé (détail dans `docs/sessions.md`) :

- **Un worktree par session** : le serveur crée `.claude/worktrees/<plan>-<session>` sur la branche
  `escadrille/<plan>/<session>` ; la branche du développeur ne bouge que par fusion.
- **Le bloc `escadrille:state`** remplace le `curl` : la session termine chaque tour par ce bloc
  (arrêts franchis, santé, ligne « regarde… »), que le serveur ajoute en consigne et lit dans le flux.
- **Le canal d'autorisation** : un outil hors liste blanche, et tout accès réseau, remontent dans « À faire »
  (Autoriser, Toujours, Refuser) ; la session attend la réponse.
- **La fusion** : un bouton par session finie (`--no-ff`, conflit annulé et listé), ou la case
  « Fusionner automatiquement chaque session finie ».
- **Le terminal, en option** : « Ouvrir dans un terminal » reprend la session (`claude --resume`) dans son
  worktree ; « Reprendre dans la page » revient.

La session de planification parle en prose et, quand elle est prête, en deux blocs que le serveur lit
(`lib/blocks.mjs`) : ```` ```escadrille:install ```` (plugins, skills et règles à installer, une liste
cochable) et ```` ```escadrille:plan ```` (le plan, au format de `plans/`, enregistré dans
`plans/<id>.json` et affiché). Un plan demande des sessions avec un dossier, un modèle, des arrêts et un
prompt autonome ; une session qui attend d'autres sessions a `after` et une vague supérieure.

```sh
./run.sh                       # http://localhost:3078, le Mac seul ; ./run.sh --lan ouvre au LAN (http://192.168.1.x:3078)
node --test 'test/*.test.mjs'  # le parseur de blocs et le pilote, contre un faux claude
```

Le dépôt a commencé par le **gestionnaire de sessions** écrit la nuit du 31 octobre 2026 pour
Orchard (`docs/phase0-depart.jpg`) : c'est le point 4 du flot, devenu `/plan/:id`. Les points 3, 4 et 5 sont en marche (le flot et son estimation d'usage, `docs/estimation.md` ; le lancement
et la revue dans la page, `docs/sessions.md` ; le plafond, les alertes et la passation) ; les points 6 et 7
sont faits (le téléphone, la voix) ; ce qui reste est dans ROADMAP.md, phase 7.

### La boucle de QA (phase 13)

Une session écrit ses parcours dans son bac à sable mais ne peut pas les jouer : le serveur le fait hors du bac à sable et
referme la boucle sans le pilote (`docs/qarun.md`, `docs/pilot.md` « Phase 13 »).

```
session ─► QA: qa/parcours.json ─► serveur joue (chrome-headless-shell, LAN déclaré seulement)
                                      │
                   ┌──────────────────┴──────────────────┐
                 tout passe                          des échecs
                   │                                     │ première fois pour ce parcours
       « QA … : 12/12 ok » en tête                       ▼
       du tour suivant, reprise seule      la liste revient à la session, une fois par parcours :
                                           elle corrige les parcours mal écrits et réécrit QA:
                                                         │ encore en échec
                                                         ▼
                                       vrais défauts : defauts.md + planche.html ─► « À toi »,
                                       bouton « Voir la planche » ; rien n'est validé pour Dev
```

Les permissions des sessions sont répondues par la politique du projet quand elle est allumée (local oui ; réseau, push,
hors worktree, fenêtres non), les réveils du pilote sont filtrés en code puis triés sur Haiku, et les messages de Dev sont
aiguillés (pilote, ou question déléguée à une session courte) sans jamais attendre le pilote.

### Retirer un plan (Dev, 6 novembre)

Un plan abandonné ne coûte plus un centime. « Retirer le plan » (en-tête de la page du plan, menu de sa carte à
l'accueil, page du plan sur le téléphone) appelle `POST /api/plan/:id/retire { why? }` : les sessions vivantes du plan
s'arrêtent (nos processus seulement, comme `session/:sid/stop`), sa file se vide, ses relances automatiques sont
annulées, le JSON du plan prend `status: 'closed'`, `closed`, `closedAt`, `closedWhy` (en base et dans
`plans/<id>.json`), une ligne system va dans le fil de chaque session. Idempotent ; réponse `{ ok, stopped: [ids] }`.
Ensuite tout ce qui démarre ou coûte refuse le plan (409, « Plan retiré : le rouvrir d'abord ») : lancement, vagues
suivantes, file, reprise, `now`, message, budget, continue-budget, run-tests, devserver, relance de secours, reprise au
démarrage du serveur, actions du pilote (answer, message, budget, capture), rafale (elle lance par `launch`). La porte
finale est `startProcess` : aucun processus d'un plan retiré, quel que soit le chemin. `POST /api/plan/:id/reopen`
rend le plan sans rien relancer (le toast « Plan retiré · Annuler » l'appelle). Un plan fermé à la main avant (un de ces
champs dans son JSON) est lu comme retiré, sans migration (`lib/retire.mjs`). Un plan retiré disparaît du graphe (même
avec `all=1`) et des cartes de l'accueil ; il n'apparaît que dans « Retirés », repliée par défaut, qui lit aussi les
plans déplacés à la main dans `plans/retired/` (hors de la table plans, lecture seule, sans « Rouvrir »).

## Règles du projet

- Code en anglais, échanges et textes de l'interface en français d'abord (anglais ensuite).
- Pas de dépendance sans raison dite : Node 22.13+ (`node:http`, `node:sqlite`) suffit au serveur ;
  l'app mobile sera en Expo ; la dictée par l'API Web Speech du navigateur d'abord.
- L'interface suit les règles d'écran d'app du taste skill (`taste-skill:design-taste-frontend`,
  `references/app-screens.md`) et passe son inspecteur avant d'être montrée.
- Open source dès le début : licence MIT, pas de secret dans le dépôt, pas de ligne de co-auteur
  dans les commits.
