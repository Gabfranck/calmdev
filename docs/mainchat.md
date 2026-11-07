# La conversation principale d'un projet (phase 7, session N)

Décision : « La conversation principale du projet » et « Ce chat comme modèle » dans `docs/decisions.md`.
Dev : « je t'utilise comme j'aimerais utiliser le chat principal de calmdev ». Une escadrille a sa
conversation de planification, qui finit avec son plan ; un projet a désormais **une conversation qui dure** :
ce que Dev demande au fil de l'eau, ce que le pilote lui répond, et les conversations Claude Code d'avant,
importées sans les outils ni les rappels.

## Le schéma

```sql
create table if not exists main_messages (
  seq integer primary key autoincrement,
  project text not null,          -- le chemin absolu du projet (docs/multiproject.md)
  role text not null,             -- 'dev' | 'claude' | 'system'
  text text not null,
  source text,                    -- 'page' | 'claude-code:<sessionId>' | 'pilot:<sessionId>'
  uid text,                       -- la clé d'un import : l'uuid du message JSONL ; null pour un message de la page
  data text,                      -- JSON, pour un message du pilote : { links, proposal } (plus bas) ; null sinon
  at text not null                -- ISO, l'heure du message (celle du JSONL pour un import)
);
create unique index if not exists main_messages_uid on main_messages (project, uid);
create index if not exists main_messages_at on main_messages (project, at, seq);
```

La table naît au démarrage du serveur (`create table if not exists`), comme les autres. L'ordre d'affichage
est `(at, seq)` : deux conversations Claude Code qui se chevauchent s'entrelacent à l'heure près.

## Les routes (du Mac seulement : 403 depuis le LAN, comme tout ce qui n'est pas au téléphone)

```
GET  /api/main?project=&before=<seq>&limit=<n>&q=<texte>
  → 200 { project, messages: [{ seq, role, text, source, at }], more, total }
    les plus récents d'abord ; limit 1..200 (50 par défaut) ; before : le seq le plus ancien déjà reçu,
    la page suivante est ce qui vient avant lui dans l'ordre (at, seq) ; q : filtre sur le texte (LIKE,
    sans casse ASCII) ; total : le nombre de messages du projet (filtre compris) ; more : il en reste avant
  → 400 { error } si project manque ou n'est pas un dossier absolu existant

POST /api/main { project, text }
  garde le message du dev : role 'dev', source 'page', uid null, at maintenant
  → 200 { ok: true, message: { seq, role, text, source, at } }
  → 400 { error } (texte vide ou de plus de 20 000 caractères)
  Rien ne répond encore : le pilote viendra (plus bas).

GET  /api/main/pending?project=
  → 200 { project, since, messages: [...] }   les messages 'dev' arrivés après le dernier message 'claude',
    du plus ancien au plus récent : ce à quoi le pilote doit répondre. Le point d'entrée du pilote.

GET  /api/main/transcripts?project=
  → 200 { dir, files: [{ path, name, size, at, first, firstAt, entrypoint, imported }] }
    les .jsonl du dossier Claude Code du projet (~/.claude/projects/<chemin, '/' et '.' remplacés par '-'>),
    du plus récent au plus ancien ; first : le premier message humain (140 caractères), entrypoint : 'cli'
    (une conversation dans un terminal) ou 'sdk-cli' (une session lancée par claude -p, un planificateur
    de calmdev par exemple) ; imported : combien de ses messages sont déjà dans la conversation

POST /api/main/import { project, path }
  → 200 { ok: true, session, added, updated, kept, masked }
  → 400 { error } si path n'est pas un .jsonl existant sous ~/.claude/projects/ (chemin résolu, sans lien
    symbolique qui en sorte), ou si project ne va pas
```

Le dossier racine est `~/.claude/projects` ; les tests le remplacent par `ESCADRILLE_CLAUDE_PROJECTS`. Pour un essai
hors de ce dossier (le bac à sable d'une session ne le lit pas), `ESCADRILLE_TRANSCRIPTS_DIR` désigne un dossier plat de
copies `.jsonl`, listé à la place de celui du projet et accepté par l'import ; sans cette variable, la règle reste
`~/.claude/projects`.

## L'import d'une conversation Claude Code (`lib/mainchat.mjs`)

`importTranscript(jsonlPath)` lit le fichier en flux, ligne par ligne (un JSONL fait vite 15 Mo), et rend
`[{ uid, role, text, at }]` dans l'ordre du fichier, plus `session` (l'id de session Claude Code).

**Gardé, rôle `dev`** :

- une ligne `type: "user"` dont le contenu est du texte tapé : une chaîne, ou des blocs `text` ; sans
  `isMeta`, `isSidechain` ni `isCompactSummary` ;
- un message arrivé en cours de tour : une ligne `type: "attachment"` dont `attachment.type` est
  `queued_command` ; seul `attachment.prompt` est gardé, sans enveloppe ;
- `<command-name>/x</command-name>…<command-args>y</command-args>` devient `/x y`.

**Écarté** : les `tool_result` (une ligne `user` qui en contient un est un retour d'outil, pas un
message), les blocs `<system-reminder>…</system-reminder>` et `<task-notification>…</task-notification>`
retirés du texte (le message est écarté s'il ne reste rien), les textes qui commencent par
`[SYSTEM NOTIFICATION`, `<local-command-stdout>`, `<local-command-caveat>`, `Caveat:`, et les images (seul
leur texte compte).

**Gardé, rôle `claude`** : les blocs `text` des lignes `type: "assistant"` hors `isSidechain` ; jamais
`tool_use`, jamais `thinking`. Les blocs text d'un même tour (tout ce qui vient entre deux messages du dev,
un message en cours de tour compris) sont réunis en une réponse, séparés par une ligne vide ; son `uid` est
celui de la première ligne qui porte du texte, son `at` celui de la dernière.

**La clé** : `uid` est l'uuid de la ligne JSONL. Un import refait ne double rien (`on conflict (project,
uid)`), et met à jour le texte d'une réponse qui a grossi depuis (le dernier tour d'une conversation encore
ouverte). Un même texte du dev à moins de deux minutes d'un autre, dans la même session, n'est gardé
qu'une fois (un message mis en file puis livré peut laisser deux traces).

**La source** : `claude-code:<sessionId>`.

**Les secrets** : avant l'écriture, `maskSecrets(text)` remplace ce qui ressemble à une clé ou un jeton
(`sk-…`, `ghp_…`, `github_pat_…`, `xox…-`, `AKIA…`, `lin_api_…`, `ExponentPushToken[…]`, `Bearer …`,
`password|secret|token|api_key = …`, une suite de 32 caractères ou plus qui mêle majuscules, minuscules et
chiffres) par `[masqué]` ; `masked` dit combien. Un hash git ou un uuid (hexadécimal seul) reste lisible.

## L'import réel du 1er novembre, et la suite

La conversation du pilote du 1er novembre (`f9086a12-3859-4fd9-b162-e82934a982c7.jsonl`) grossit encore :
on importe ce qui existe ; **un second import ajoute la suite** (les nouvelles lignes, et la dernière
réponse complétée), sans rien doubler. Depuis la page : « Importer une conversation Claude Code », puis
« Importer » sur la ligne du fichier, autant de fois qu'on veut.

Les conversations de la nuit dans `~/.claude/projects/-Users-gab-Dev-escadrille/` s'importent dans l'ordre
de leurs dates. La nuit du 31 octobre (`dfd196af-…`) n'a plus de `.jsonl` : seul son dossier
(`subagents/`, `tool-results/`) reste ; son récit est `docs/recap-session-2026-11-01.md`.

## Le pilote : qui répondra, plus tard

Ce chat-ci (la conversation Claude Code de Dev du 1er novembre) est le modèle. Le pilote d'un projet sera
**une session Claude Code longue**, une par projet, reprise (`--resume`) d'un message à l'autre, lancée en
stream-json comme le planificateur (`lib/planner.mjs`), dans le bac à sable, en lecture seule sur le code.
Son id de session ira dans les réglages du projet (`project_settings.json.pilot`). Ce qu'il fait, dans
l'ordre :

1. **Reprendre l'état, seul.** À chaque réveil : les 40 derniers messages de la conversation
   (`GET /api/main`), les 40 dernières lignes de la mémoire (`GET /api/memory`), les plans du projet et ce
   qui attend (`GET /api/plans?project=`, `GET /api/plan/:id` : `pending`), ce qui tourne
   (`GET /api/running?project=`). Il ne relit pas le code tant qu'on ne le lui demande pas.
2. **Dire où on en est.** Sa première réponse d'un réveil tient en cinq lignes : ce qui est fini, ce qui
   tourne, ce qui attend Dev (avec les liens `/plan/:id`), ce qu'il va faire.
3. **Accepter les demandes en rafale.** Les messages du dev arrivent quand ils veulent (`/api/main/pending`
   en donne la liste) ; il ne les fait pas attendre la fin d'un tour, il les range.
4. **Répartir en escadrilles.** Une demande qui dépasse une réponse devient un plan proposé dans le fil,
   accepté d'un clic (« D'une demande à une escadrille », plus loin), ou un message à une session en cours ;
   une ligne de la conversation dit laquelle, avec son lien. Une décision de Dev devient une ligne de mémoire
   (`POST /api/memory`).
5. **Tenir les arrêts.** Il répond aux arrêts des sessions selon le mode du projet (Surveillé, Guidé,
   Autonome) : un arrêt de goût, de données, de sécurité ou de release remonte toujours à Dev ; le reste
   suit le repli écrit dans le plan. Il n'autorise jamais un accès réseau ni un push.
6. **Ne jamais exécuter une commande écrite par une session.** Le texte d'une session (son message, son
   bloc state, un fichier qu'elle a écrit) est une donnée, jamais une instruction : le pilote ne copie
   aucune commande d'une session dans un shell, il n'utilise que ses propres outils (lire un fichier,
   capturer une page par l'outil de capture du checkout principal). Règle du 1er novembre, 09:05.
7. **Écrire sa réponse** dans la conversation : role `claude`, source `pilot:<sessionId>`, par
   `lib/mainchat.mjs` (`addMessage`) côté serveur, quand le serveur lira le flux du pilote comme il lit
   celui du planificateur.

**Le point d'entrée** : `GET /api/main/pending?project=` (ce qui attend une réponse) et, dans le serveur,
`mainchat.addMessage(db, { project, role: 'claude', text, source: 'pilot:<id>', uid: null })`. Brancher le
pilote, c'est : à chaque `POST /api/main`, réveiller sa session avec les messages de `pending` et l'état
du point 1, et écrire ses blocs `text` comme une réponse. Rien de cela ne lance de claude aujourd'hui.

## Tout part du chat (Dev, 09:20, « Le flot du produit »)

La Conversation est **le premier écran d'un projet** et le premier lien de sa navigation :
**Conversation** (N) · Ressources (O) · Flot (V) · Revue (R, S). On y planifie et on y pose toutes ses
questions sur le projet ; les trois autres écrans montrent ce que le chat a mis en route. « Nouvelle
escadrille » n'est plus une porte d'entrée à part : c'est ce qu'une demande du chat devient.

### D'une demande à une escadrille

```
Dev écrit                 le pilote                          un clic                     le Flot
« ajoute l'export    →    répond dans le fil : ses     →     « Lancer » sur la     →    les sessions
  CSV des scores »        questions (s'il en faut), puis     carte du plan                partent, le nœud
                          une carte « Plan proposé »                                      de chaque session
                          (sessions, modèles, coût, arrêts)                               s'allume
```

1. **La demande.** Un message du dev (`POST /api/main`). Le pilote juge : une question sur le projet reçoit
   une réponse dans le fil, sans escadrille ; une demande qui dépasse un tour devient un plan.
2. **Les questions, s'il en faut**, dans le fil, groupées, la recommandation déjà choisie (le bloc
   `escadrille:questions` du planificateur, même formulaire, même « Tout accepter ») : Dev répond d'un clic.
3. **Le plan proposé.** Le pilote écrit un bloc `escadrille:plan` (le format de `plans/`, validé par
   `validatePlan` avec les réglages du projet, comme aujourd'hui). Le serveur le retire du texte et le garde
   dans `data.proposal = { planId, title, sessions, waves, estimate: { tokens, cost, weeklyAfter }, stops,
   network, status: 'proposed' }`, écrit `plans/<id>.json` sans rien lancer. Le fil montre **une carte** :
   le titre, une ligne par session (lettre, modèle, budget), le coût estimé et le quota après, les domaines
   réseau (vides par défaut), et une seule action, **« Lancer »** ; « Voir le flot » et « Modifier » sont
   repliés en une ligne.
4. **Un clic l'accepte.** `POST /api/main/accept { project, seq }` (route future) lance la première vague
   (`POST /api/launch { plan }`), passe `proposal.status` à `'launched'` et écrit une ligne `system` dans le
   fil : « Plan lancé : 4 sessions, 1 vague, ≈ 3,20 $ » avec le lien du Flot. « Modifier » est un message :
   Dev dit ce qu'il change, le pilote propose une nouvelle carte, l'ancienne passe en `'replaced'`.
   Aucune escadrille ne part sans ce clic, sauf en mode Autonome, où le pilote lance seul et le dit.
5. **La suite revient dans le fil.** Un arrêt franchi, une session qui attend, une revue prête, un plan
   fini : le pilote écrit une ligne courte dans la conversation (pas un message par événement : il groupe
   ce qui arrive pendant un tour), avec le lien qui y mène.

### Chaque message du pilote renvoie à la coulisse

Le pilote ne raconte pas ce qui se passe, il y renvoie : chacun de ses messages porte `data.links`, une liste
de `{ kind, label, href }`, que la page affiche en une ligne de puces discrètes sous le texte :

| kind | où il mène | exemple de label |
|---|---|---|
| `flow` | le nœud d'une session dans le Flot : `/plan/<id>?project=…#s-<session>` | « B · Flot » |
| `review` | la revue d'une session (écran de R et S) : `/plan/<id>?project=…#review-<session>`, la route que S fixera | « B · 12 fichiers à revoir » |
| `stop` | l'arrêt qui attend Dev, dans « À faire » : `/plan/<id>#pending-<pendingId>` | « B attend ta réponse » |
| `plan` | le plan entier | « Phase 7 · Flot » |
| `memory` | la ligne de mémoire écrite : `/#memoire` | « Décision notée » |
| `file` | un fichier du dépôt ou une capture (chemin absolu, ouvert par le Mac) | « docs/mainchat.md » |

La règle : **pas une phrase sur une session sans son lien.** Le serveur les fabrique à partir de ce que le
pilote nomme (`plan`, `session`, `pendingId`) plutôt que de faire confiance à une URL écrite : un lien ne
sort jamais du serveur local. Les ancres exactes du Flot et de la Revue suivent V et S ; ce contrat ne fixe
que `kind`, `label` et le fait que le serveur construit `href`.

## La vue « Conversation »

`/`, le premier écran d'un projet (lien « Conversation » en tête de la barre latérale). Depuis la phase 11 (session H,
2 novembre, la maquette `docs/phase11/accueil.html` validée par Dev, le cahier `docs/phase11/ux.md` §8) :

- **Le titre** « Conversation », et dessous **la phrase d'état** lue dans `GET /api/status` :
  `escadrille · 2 en cours · 1 t'attend · 24,10 $ aujourd'hui` (chiffres en mono) ; un projet vide dit
  `escadrille · rien encore`. À droite du titre, le champ **Chercher** (240 px, touche `/`, Échap vide).
- **Le fil** par jour, le dev à droite en bulle, Claude à gauche sur 68 caractères, en Markdown simple ; l'heure de chaque
  message **toujours visible** à droite (12 px, rien n'apparaît au survol) ; les cartes « Plan proposé » ; une ligne
  système par planification lancée ; « Messages plus anciens » charge la page d'avant.
- **Le compositeur** : dans sa barre, à gauche **Dicter** et **l'interrupteur Pilote** avec son état en gris (`éteint ·
  Planifier lance une planification`, `lit la Conversation`, `lit…`, `plafond du jour`) ; à droite **le seul bouton
  primaire, qui dit ce qu'il fait** : `Planifier` (pilote éteint : `POST /api/escadrille`, le texte est l'idée) ou
  `Envoyer` (pilote allumé : `POST /api/main`, le pilote répond). Entrée envoie, Maj+Entrée va à la ligne. Un brouillon
  survit à chaque redessin (le texte, le curseur, le focus).
- **La ligne sous le champ**, en mots gris sans chevron, un point médian entre eux : le modèle (`Opus 5.5`), `Partir d'un
  gabarit`, `Importer une conversation Claude Code` (les `.jsonl` du projet : taille, date, premier message, déjà
  importé ou non) ; chacun s'ouvre en place dessous, Échap le referme et rend le focus à son mot.
- **Le panneau d'état** (360 px, collant), des lignes de 14 px, pas de cellules : **Maintenant**, une ligne de chiffres
  (`2 en cours · 1 t'attend · 3 à venir`, focalisable) ; au survol ou au focus, une carte flottante au-dessus du panneau
  (la seule ombre de l'écran, elle ne pousse rien) avec une ligne par session (lettre, nom, `coût / plafond`, une barre
  de 2 px à la vraie part), les sessions à venir en gris avec `à venir · après D`, cinq lignes puis `et n autres ·
  Flot` ; rien ne tourne : `Rien ne tourne.`. **Claude** : une ligne et une barre de 6 px par limite mesurée du compte
  (`Quota hebdo 31 %` · `remise à zéro dans 4 j`, les deux repères de seuil), ce qui n'est pas mesuré en une ligne grise
  sans barre (jamais la fenêtre de 5 h : Ultra n'en a pas), puis `Ultra · d•••@gmail.com · mesuré à 05:40 · Régler les
  seuils`. **Coût de calmdev** : `24,10 $ aujourd'hui · 278 $ sur 7 jours · 6,83 $ ce run` sur une ligne, `au tarif
  public de l'API` dessous. **Garde**, repliée : `Surveillé · sans réseau · rafale éteinte`. **À toi**, au pied sous un
  filet : une ligne et un bouton par chose qui attend le développeur (Répondre, Autoriser, Ouvrir), `Rien ne t'attend.`
  sinon, `n anciennes` repliées dessous.
- **Sous 1100 px** le panneau devient une ligne au-dessus du fil (`2 en cours · 1 t'attend · quota 31 % ›`) qui ouvre les
  mêmes blocs dans une feuille (`dialog`) ; Échap ou « Fermer » la ferment, le focus revient à la ligne.
- **Trois états** : un projet avec des messages ; un projet vide (`Dis ton idée : Claude lit le projet, pose ses
  questions, écrit le plan.` en 16 px, puis le compositeur juste dessous, déjà en focus) ; aucun projet (la liste du
  registre et « Ajouter un projet… », rien d'autre).

Les infobulles (date complète d'un message, e-mail du compte, chemin d'un fichier, titre du run) sont des `data-tip`
pour `public/ux.js` (session G), jamais un `title`. Le code est dans `public/mainchat.js` et `public/mainchat.css` ;
`public/index.html` n'a qu'une ligne pour l'appeler et une pour le charger ; `test/mainchat-home.test.mjs` rend les
trois états sans navigateur.

## Les tests (`test/mainchat.test.mjs`)

Sur un JSONL de fixture : messages humains gardés, `tool_result` écartés, rappels système et
notifications écartés, message en cours de tour gardé sans enveloppe, blocs text d'un tour réunis,
`thinking` et `tool_use` écartés, secret masqué ; puis contre le serveur : `POST /api/main`, la pagination
de `GET /api/main`, l'import idempotent (un second import n'ajoute rien, un fichier qui a grossi ajoute la
suite), un chemin hors `~/.claude/projects` refusé (400), la liste des transcripts.
