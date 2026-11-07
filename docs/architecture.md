# La carte de l'architecture (phase 7, session Y)

La demande de Dev (08:50) : « tu peux générer plein de code ; le développeur doit être là pour connaître
l'architecture du projet et savoir où aller si tu n'es pas là ». Le dev ne relit plus chaque ligne : il garde
**la carte**, et il voit **ce que chaque plan y change**. Décision : « La revue et l'architecture » dans
`docs/decisions.md`.

La carte **se calcule**, elle ne s'écrit pas : rien n'est écrit dans un projet piloté (pas de
`<projet>/docs/architecture.md`). Elle est lue dans git, à un commit donné, sans checkout : on peut lire n'importe
quelle branche d'un projet pendant qu'une session travaille dans un autre worktree.

## Ce qu'est la carte (`lib/architecture.mjs`, sans dépendance)

```
mapOf(repoDir, ref = 'HEAD') → Promise<Map>
Map = {
  repo, ref, sha,                 // sha : le commit résolu (git rev-parse ref^{commit})
  files: <nombre lu>, skipped: <nombre ignoré>, truncated: bool,
  modules: [{ id, files: [chemins], lines, lang, role, entry }],
  edges:   [{ from, to, count }],
  routes:  [{ method, path, file, module, kind }],
  tables:  [{ name, file, module, kind }],
  deps:    [{ name, version, dev, file }]
}
```

- **Lecture** : `git ls-tree -r -l --full-tree <sha>` donne chemins et tailles ; `git cat-file --batch` lit les
  contenus d'un seul processus (l'équivalent de `git show ref:path` pour des milliers de fichiers). Plafonds :
  10 000 fichiers (au-delà `truncated: true`), un fichier de plus de 2 Mo est compté dans `skipped` et pas lu ;
  seuls les fichiers texte de code et de config sont lus (extensions connues), les binaires jamais.
- **Ignorés** : `node_modules/`, `dist/`, `build/`, `.next/`, `coverage/`, `vendor/`, `.git/`, les fichiers
  `*.min.*`, les lockfiles, `.expo/`, `__pycache__/`.
- **Un module, c'est un dossier.** Son `id` est le chemin du dossier, ramené à deux niveaux
  (`src/routes/admin/x.js` → `src/routes`), `.` pour la racine. **Un module trop gros pour se lire** (plus de 40
  fichiers et plus d'un cinquième du dépôt) se divise d'un niveau, jusqu'à cinq : dans `Orchard-docker-api`,
  `server/domains` devient un module par domaine (`server/domains/auth`, `…/questions`). Un dossier `packages/<p>`, `apps/<p>` ou
  `services/<p>` compte comme une racine (monodépôt) : on garde deux segments après elle
  (`apps/api/src/routes/x.js` → `apps/api/src/routes`). `lines` : la somme des lignes lues ; `lang` : l'extension
  majoritaire (`js`, `ts`, `py`, `json`…) ; `entry` : `index.*`, `main.*`, `server.*`, `app.*` du dossier, sinon
  null.
- **Le rôle, deviné** (premier qui répond, sur le chemin puis le contenu) :
  `tests` (`test/`, `tests/`, `__tests__/`, `*.test.*`, `*.spec.*` en majorité), `migrations`
  (`migrations/`, `migrate/`, `prisma/`, `db/`, `seeders/`), `routes` (`routes/`, `api/`, `controllers/`,
  `handlers/`, ou des routes vues dans le dossier), `pages` (`pages/`, `app/` d'un Next ou d'Expo Router,
  `public/`, `views/`, `components/`, `screens/`, `src/app`), `scripts` (`scripts/`, `bin/`, `tools/`), `config`
  (fichiers de config seuls : `*.json`, `*.yml`, `*.config.*`, `Dockerfile`, dossiers `.github/`, `config/`),
  sinon `lib`.
- **Les arêtes** : imports relatifs (`./`, `../`) et alias de chemins d'un `tsconfig.json` ou `jsconfig.json`
  (`"@/*": ["./src/*"]`, lu avec ses commentaires), lus par regex : `import … from '…'`,
  `import '…'`, `export … from '…'`, `require('…')`, `import('…')` en JS/TS/MJS/CJS/JSX/TSX/Vue/Svelte ;
  `from .x import y` et `from x.y import z` (résolu s'il existe dans le dépôt) en Python. Le chemin est résolu
  contre la liste des fichiers (avec les extensions et `index.*` essayés) ; une arête relie le module du fichier
  qui importe à celui du fichier importé, `count` le nombre d'imports ; les imports internes à un module ne
  font pas d'arête.
- **Les routes** (`kind`) : `express` (`app|router|server.get|post|put|patch|delete|all('…'`), `fastify`
  (`fastify.get(…)`, `route({ method, url })`), `node` (`url.pathname === '/…'` et `startsWith('/…')` d'un
  serveur `node:http`, la méthode lue sur la même ligne sinon `*`), `next` (fichiers sous `pages/` et
  `app/**/page|route.*` : le chemin vient du fichier, `[id]` → `:id`), `expo` (fichiers sous `app/` d'un
  projet qui dépend d'`expo-router`). Une route vaut `{ method, path }` ; le doublon exact est retiré.
- **Les tables** (`kind`) : `sql` (`create table [if not exists] <nom>`), `sequelize` (`define('Nom'`,
  `sequelize.define`, `Model.init(` avec `modelName` ou la classe), `prisma` (`model Nom {` dans un `.prisma`),
  `typeorm` (`@Entity(` puis `class Nom`). Le nom est gardé tel qu'écrit.
- **Les dépendances** : chaque `package.json` du dépôt (hors ignorés), `dependencies` puis
  `devDependencies` (`dev: true`) ; `requirements.txt` aussi, une ligne par paquet.
- **Le cache** : en mémoire, par `repo + sha` (une carte d'un commit ne change pas), 32 entrées au plus.

## Le delta d'un plan

```
deltaOf(repoDir, base, head) → Promise<Delta>
Delta = {
  repo, base, head, baseSha, headSha,
  added:   { modules: [ids], edges: [{ from, to, count }], routes: [route], tables: [table], deps: [dep] },
  removed: { …la même forme },
  changedModules: [{ id, additions, deletions }],
  summary: [trois lignes en français]
}
```

- `added`/`removed` comparent les deux cartes : un module par `id`, une arête par `from→to`, une route par
  `method path`, une table par `name`, une dépendance par `name` (une version changée n'est ni l'un ni l'autre :
  elle apparaît dans `changedModules` par son `package.json`).
- `changedModules` vient de `git diff --numstat base...head` (le diff depuis la base commune, comme une PR),
  chaque fichier rangé dans son module, les modules triés par lignes touchées.
- `summary` : trois lignes, par exemple
  1. « Ce plan ajoute 2 routes, 1 table, touche 4 modules. »
  2. « Nouveau : module `lib/arch` ; route `GET /api/architecture` ; table `review_comments`. » (ou « Rien de nouveau. »)
  3. « Retiré : … » ou « Rien de retiré. » suivi des nouvelles dépendances s'il y en a.

## Les routes du serveur (Mac seulement)

Les mêmes paramètres que la revue de R (`docs/review.md` de sa branche) :

```
GET /api/architecture?project=<chemin absolu>&ref=<ref>          ref par défaut HEAD
GET /api/architecture?plan=<id>&session=<sid>                    la carte de la branche de la session
  → 200 Map | 400 { error } (projet absent ou pas un dépôt git, ref inconnue)

GET /api/architecture/delta?project=&base=&head=
GET /api/architecture/delta?plan=&session=
  → 200 Delta | 400 { error }
```

Pour `?plan=&session=` : le dépôt est `worktree.root` de la session, `head` sa branche
(`escadrille/<plan>/<session>`), `base` la base commune (`git merge-base`) de cette branche et de la branche
courante du dépôt : ce que la session a changé, pas ce que `main` a fait depuis. Une session sans worktree :
400. `project` doit être un dossier absolu existant (la même règle que `/api/project/settings`).

Le téléphone n'y a pas accès (`PHONE_ROUTES` inchangé) : 403 depuis le LAN.

## La page `/architecture`

`public/architecture.html` (et `public/architecture.js`), la coque de `public/app.css`. Paramètres :
`?project=` (le sélecteur, rempli par `GET /api/projects`), `&ref=`, ou `&base=&head=` pour le delta, ou
`&plan=&session=`.

- **L'action principale : lire la carte.** Un SVG fait main, sans bibliothèque : une colonne par rôle
  (Pages, Routes, Lib, Migrations, Scripts, Config, Tests), chaque module une boîte dont la hauteur suit ses
  lignes (bornée), le nom et les lignes dedans ; les arêtes en courbes, **les plus lourdes seulement** (les
  12 premières par `count`), le reste derrière « Toutes les arêtes » (une ligne repliée).
- **Les noms** dans les boîtes : les deux derniers segments sous la racine du code (le dossier du haut qui tient
  plus de la moitié des fichiers : `server/`, `src/`), la même règle partout (`server/domains/questions` →
  `domains/questions`, `server/config` → `config`) ; le chemin entier dans le détail.
- **Les arêtes montrées** : un module sélectionné, seulement les siennes (les autres modules grisés) ; sans
  sélection, dans un delta, celles des modules ajoutés ou modifiés ; sur la carte seule, les 12 plus lourdes.
- **Cliquer un module** ouvre son détail à droite (ou dessous à 390) : ses fichiers, ses routes, ses tables, qui
  l'importe et ce qu'il importe ; ses arêtes sont mises en avant dans la carte.
- **Le delta** (`base`/`head` ou `plan`/`session`) : ajouté en vert, retiré en rouge (boîte en pointillé),
  modifié en ambre avec `+a −d` ; la ligne de tête dit la première ligne du `summary` (« Ce plan ajoute 2 routes,
  1 table, touche 4 modules »).
- **Le secondaire replié en une ligne** : les routes, les tables, les dépendances (« 34 routes · 6 tables · 12
  dépendances », s'ouvre sur les listes).
- L'accueil (`public/index.html`) gagne une entrée « Architecture » dans la barre latérale, à côté de
  « Mémoire » et « Accès », qui ouvre `/architecture?project=<le projet courant>`.

## Les tests (`test/architecture.test.mjs`)

Un dépôt jetable créé par le test : `main` avec `server.mjs` (deux routes `node:http`), `lib/db.mjs`
(`create table users`), `test/a.test.mjs` ; une branche `feature` qui ajoute `lib/review/index.mjs` (importé
par `server.mjs`), une route `POST /api/review` et `create table reviews`. On vérifie : modules, rôles, arêtes,
routes, tables, deps, `sha` et le cache ; `deltaOf(main, feature)` (module, route, table, arête ajoutés,
`changedModules`, `summary`) ; la carte d'une branche lue pendant qu'une autre est extraite (pas de checkout) ;
les plafonds (fichier trop gros ignoré) ; les routes HTTP du serveur (400 sans projet, la carte, le delta par
`?plan=&session=`).

L'essai réel, en lecture seule : la carte d'Escadrille, d'`Orchard-docker-api` et d'`Orchard-teacher`, et le
delta de `release/r01` contre `dev`, capturés (`docs/phase7-architecture-*.jpg`).

## L'essai réel (lecture seule, port 3100)

| Carte | Fichiers | Modules | Imports | Routes | Tables | Capture |
| --- | --- | --- | --- | --- | --- | --- |
| Escadrille (`main`) | 91 | 14 | 5 | 32 | 13 | `docs/phase7-architecture-escadrille.jpg`, `-390.jpg` |
| Orchard-docker-api (`dev`) | 455 | 23 | 129 | 159 | 45 (Sequelize) | |
| Orchard-teacher (`HEAD`) | 416 | 37 | 156 | 0 | 0 | `docs/phase7-architecture-teacher.jpg` (`src/pages` ouvert) |

Le delta de `release/r01` contre `dev` dans `Orchard-docker-api` (`docs/phase7-architecture-delta-r01.jpg`,
`server/domains/questions` ouvert) : « Ce plan touche 5 modules, sans rien ajouter. »
(`questions` +789 −33, `quests` +305 −32, `groups`, `scripts`, `userStats`), un import nouveau
`quests → test`. Une carte se calcule en 0,1 à 0,4 s ; le cache la rend ensuite sans rien relire.

Les routes de calmdev vues sont celles écrites `url.pathname === '/…'` ; celles qui passent par `seg[1] === …`
(les plans, les sessions) ne le sont pas : c'est la limite des regex, dite ci-dessous.

## Les limites

- Des regex, pas un parseur : un import construit dynamiquement (`import(variable)`), une route enregistrée
  par une boucle ou un décorateur inconnu ne sont pas vus. La carte dit ce qu'elle voit ; elle ne prétend pas
  être complète.
- Les alias hors `tsconfig.json`/`jsconfig.json` (ceux d'un `vite.config` ou d'un `babel.config`) ne sont pas
  résolus.
- Le rôle est deviné : un dossier mal rangé tombe dans `lib`.
