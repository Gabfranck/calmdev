# Le multiprojet et la mémoire (phase 6, côté serveur)

Dev travaille sur plusieurs projets (Orchard, une mission…). Le serveur range tout par projet : les
escadrilles, les plans, ce qui tourne sur le Mac et le téléphone ; chaque projet a ses réglages et sa
mémoire. Décisions : « Multiprojet » et « La mémoire accessible » dans `docs/decisions.md`.

Un **projet** est un dossier absolu donné à Escadrille, inscrit au registre `~/.config/escadrille/projects.json`
(`lib/projects.mjs`, phase 11 S) que `GET /api/projects` liste : par install.sh lancé depuis ce dossier, par
« Ajouter un projet » dans le sélecteur, ou par la migration unique des projets qui avaient déjà un plan ou une
conversation. Les dossiers que Claude Code connaît (`~/.claude.json`) ne sont que des suggestions à l'ajout.
« Retirer de la liste » ne supprime rien. Son **nom court** est le nom libre du registre (champ `name` facultatif, 60 caractères, modifiable par le crayon du
sélecteur, `POST /api/projects/name`), sinon le dernier segment du chemin (`~/Dev/Orchard` → `Orchard`) ; le
chemin reste la clé. Dans une requête, `?project=` porte le chemin absolu encodé
(`encodeURIComponent('~/Dev/Orchard')`) ; sans lui, une route renvoie tout, comme avant.

## Le schéma

```sql
alter table plans add column project text;            -- si elle manque, comme pour sessions
create table if not exists project_settings (project text primary key, json text, at text);
```

- `plans.project` : le chemin du projet du plan, aussi écrit dans le JSON du plan (`plan.project`) pour
  qu'un plan rechargé depuis `plans/` le garde. `upsertPlan` écrit `plan.project` quand il est là et ne
  remplace jamais une valeur connue par null.
- `project_settings.json` : `{ budget?, network?, model?, addDirs?, parallel?, linearState?, review?, retryMax? }` (phase 7 : `parallel`, la file du projet, `docs/sessions.md` « La robustesse » ; la clé Linear n'y est jamais : `docs/connectors.md`), seulement les champs écrits par
  Dev ; le reste vient des défauts à la lecture.
- La mémoire n'a pas de table : le fichier est la vérité.

## La migration, au démarrage

Après `loadPlans()`, pour chaque plan dont `project` est null :

1. l'escadrille dont `plan_id` pointe sur le plan : son `project` ;
2. sinon le `path` de la première session du plan, remonté à la racine git : on monte jusqu'au dossier
   qui contient `.git` ; si `.git` est un fichier (un worktree, `gitdir: <repo>/.git/worktrees/<nom>`),
   on prend `<repo>` ; sans `.git` trouvé, le `path` tel quel ;
3. sinon null (le plan reste « sans projet », visible sans filtre seulement).

Synchrone (lecture de fichiers, pas de `git`), idempotente, rien n'est réécrit dans `plans/`.

## Les routes

Toutes « Mac seulement » (403 depuis le LAN avec un jeton) sauf `GET /api/phone` et `GET /api/plans`,
déjà ouvertes au téléphone.

### Le projet partout

| Route | Changement |
|---|---|
| `GET /api/projects` | chaque projet du registre : `{ path, name, recent, via, added, last, escadrilles, plans }` (les deux derniers : des nombres), le plus récemment actif d'abord |
| `POST /api/projects` | `{ path }` (absolu ou `~/…`, un dossier existant) ; 400 `not-absolute`, `not-found` ou `not-a-folder` |
| `POST /api/projects/remove` | `{ path }` : hors de la liste, rien d'autre |
| `GET /api/projects/suggestions` | les dossiers récents de Claude Code hors de la liste |
| `GET /api/projects/dirs?prefix=` | les dossiers sous un chemin tapé, pour le champ d'ajout |
| `GET /api/escadrilles?project=` | inchangé (`project` y est déjà), filtré par projet |
| `GET /api/plans?project=` | chaque plan : `{ id, title, created, project }`, filtré par projet |
| `GET /api/plan/:id` | `plan.project` (le chemin, ou null) |
| `GET /api/running?project=` | chaque entrée de `ours` a `project` (celui de son plan) ; le filtre ne touche que `ours`, `others` reste entier |
| `GET /api/phone?project=` | chaque plan de `plans` a `project` ; filtré par projet |

`validatePlan(plan, { project })` pose `plan.project` : celui de l'escadrille quand le plan vient d'un
bloc `escadrille:plan` ; pour `POST /api/plan`, `body.project` s'il est donné, sinon la racine git du
`path` de la première session (la même règle que la migration).

**Le push** (`lib/push.mjs`) : le titre de la notification commence par le nom court du projet, puis le
texte ; le corps devient le titre du plan.

```
titre : « Orchard · B attend ta réponse »      (avant : « Quick wins »)
corps : « Quick wins »                            (avant : « B attend ta réponse »)
```

Un plan sans projet garde l'ancienne forme du titre, sans préfixe (`B attend ta réponse`).
`push.titleFor(projectName, text)` le fabrique ; le test du téléphone est mis à jour.

### Les réglages par projet

```
GET  /api/project/settings?project=/abs/path
  → 200 { project, budget, network, model, addDirs, parallel, linear: { key: bool, state }, stored }   (parallel : null sans réglage)
    budget  : le réglage, sinon DEFAULT_BUDGET_USD (5, ou ESCADRILLE_BUDGET_USD)
    network : le réglage, sinon []
    model   : le réglage, sinon le modèle de la dernière escadrille du projet, sinon null
    addDirs : le réglage, sinon []
    review  : le réglage, sinon 'guided' ('strict' | 'guided' | 'auto', docs/review.md)
    retryMax: le réglage, sinon 2 (relances d'une revue avant de la passer au développeur, docs/review.md)
    stored  : les noms des champs réellement écrits (["budget"]…), pour que la page distingue un défaut
  → 400 { error } si project manque ou n'est pas un dossier absolu existant

POST /api/project/settings { project, budget?, network?, model?, addDirs?, parallel?, linearKey?, linearState?, review?, retryMax? }   (parallel : entier ≥ 1, null l’efface)
  un champ absent garde sa valeur ; null efface le champ (retour au défaut)
    budget  : nombre > 0
    network : validateDomains, comme POST /api/plan/:id/settings
    model   : un id de MODELS
    addDirs : chemins absolus de dossiers existants
  → 200 { ok: true, settings: <la même forme que le GET> } | 400 { error }
```

**Un réglage est un défaut, un plan est un contrat.** Les réglages sont lus au moment où l'on crée :

- `POST /api/escadrille` sans `model` prend `model` du réglage du projet (stocké ou dernier choisi) ;
  toujours 400 s'il n'y en a aucun.
- La validation d'un plan (bloc du planificateur ou `POST /api/plan`) remplit, avant `validatePlan`, ce
  qui manque à partir des réglages **stockés** du projet : `budget` de chaque session sans `budget`,
  `network` du plan s'il est absent, `addDirs` du plan s'il est absent. Les valeurs sont alors écrites
  dans le JSON du plan : changer un réglage plus tard ne touche aucun plan écrit. Un réglage non stocké
  ne remplit rien (le serveur garde son défaut à l'exécution, comme avant).

### La mémoire

**La convention.** La mémoire d'un projet est `<projet>/docs/decisions.md` quand ce fichier existe,
sinon `<projet>/.escadrille/memoire.md`, créé au premier ajout. Le fichier est la vérité : Dev peut
l'éditer à la main, le serveur ne garde aucune copie.

```
GET /api/memory?project=/abs/path
  → 200 { file, lines: [{ n, text }], total }   n à partir de 1, toutes les lignes (la page cherche côté client)
  → 200 { file: null, lines: [], total: 0 }      ni l'un ni l'autre n'existe
  → 400 { error } si project manque ou n'est pas un dossier absolu existant

POST /api/memory { project, line }
  ajoute à la fin du fichier (un retour à la ligne avant si le fichier n'en finit pas par un) :
    - **2026-11-01 (06:10)** : <line>
  date et heure locales du Mac ; crée .escadrille/ et memoire.md si besoin
  → 200 { ok: true, file } | 400 { error } (ligne vide, ou avec \n ou \r, ou plus de 2000 caractères)
```

**Le planificateur la reçoit.** `systemPromptFor(e)` ajoute, après « ## Cette escadrille » :

```
## La mémoire du projet

Fichier : <file>
<les 40 dernières lignes non vides du fichier>
```

et rien quand le fichier n'existe pas. C'est le seul contexte ajouté.

**Les sessions l'écrivent.** Une session lancée peut ajouter une ligne :

```sh
curl -s -X POST localhost:3078/api/memory -H 'content-type: application/json' \
  -d '{"project":"~/Dev/Orchard","line":"Les avatars restent en PNG 512"}'
```

C'est localhost : `isNetwork` (`lib/planner.mjs`) ne doit pas le compter comme un accès extérieur.
Aujourd'hui il le compterait dès que la ligne contient un mot à point (`decisions.md`, `server.mjs`), pris
pour un nom d'hôte. Correction : pour curl/wget, les chaînes entre guillemets qui ne ressemblent pas à
une seule URL ou un seul hôte (espace, `{`, `[`, `@` en tête) sont retirées avant de chercher les hôtes ;
`curl 'evil.com'` ou `curl "https://x.io"` restent des accès réseau. Un test le tient.

À vérifier à l'arrêt 2 : que le bac à sable de Claude Code laisse la session joindre `localhost:3078`.

## Les tests (`test/multiproject.test.mjs`)

- la migration : un plan inséré sans `project` (base préparée avant le démarrage) en reçoit un, par
  l'escadrille, puis par la racine git d'un worktree ;
- les filtres `?project=` sur `/api/plans`, `/api/escadrilles`, `/api/running`, `/api/phone` ;
  `/api/projects` avec `name`, `escadrilles`, `plans` ;
- les réglages : défauts, écriture partielle, null, validation (budget, network, model, addDirs),
  pré-remplissage d'un plan, un réglage changé après coup ne touche pas le plan ;
- la mémoire : `docs/decisions.md` présent, `.escadrille/memoire.md` créé, ligne refusée, les 40
  dernières lignes dans le system prompt (lu dans les arguments du faux claude) ;
- `isNetwork` : le curl vers `/api/memory` avec `decisions.md` dans la ligne reste local ;
- le titre du push avec le projet.
