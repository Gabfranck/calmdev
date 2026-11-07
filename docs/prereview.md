# La pré-revue (`lib/prereview.mjs`)

Claude peut écrire beaucoup de code ; le dev ne doit lire que ce qui compte. La pré-revue lit un diff, les
règles du dev et les domaines sous garde, et rend ce que la page « Files changed » (S) met en tête : trois
lignes de résumé, au plus cinq fichiers à lire d'abord, un risque par fichier, les règles enfreintes, et les
vérifications du projet si on les demande. Elle est pure : aucun appel réseau, aucun `claude` ; seules les
vérifications (option `run`) lancent des commandes, dans le worktree. R la branche dans la revue
(`docs/review.md`, champ `prereview`).

## Le contrat

```js
import { prereview, loadRules, parseRules, parseDiff } from './lib/prereview.mjs';

const out = await prereview({
  repo,      // chemin du worktree (sert à `run` et au chargement des règles)
  base, head,// noms de branche ou SHA, recopiés tels quels (la fonction ne lance pas git)
  files,     // la forme de R, ci-dessous
  rules,     // le texte des règles (string) ou le résultat de parseRules ; absent : loadRules(project)
  guarded,   // tableau de globs, les domaines sous garde (réglage `guarded` de L, docs/autonomy.md)
  project,   // chemin du projet, pour trouver ses règles
  others,    // facultatif : [{ session, files: [chemins] }], les autres sessions du même plan
  repoFiles, // facultatif : les chemins suivis du dépôt (git ls-files), pour `requires-test`
  run,       // false par défaut : true lance les vérifications
  timeoutMs, // délai par vérification, 120 000 par défaut
  claude,    // false par défaut, voir plus bas
});
// → { summary, readFirst: [{ path, why }], files: [{ path, risk, reasons, flag, why, generated? }],
//     rules: [{ rule, path, line, text, level }], checks: [{ name, ok, output }], base, head, repo }
```

**L'appel de R** (`docs/review.md`) : `await prereview({ repo, base, head, files })` suffit. `rules` absent : les
règles se lisent dans `project`, sinon `repo` (`loadRules`). `guarded` absent : `guardedPaths(project ?? repo)`
de `lib/autonomy.mjs` (L) s'il existe, sinon aucun. Chaque fichier porte `flag` (vrai pour les fichiers de
`readFirst` et ceux à risque haut) et `why` (sa première raison, ou null) : le serveur recopie `flag` dans
`files[].flagged`.

**`files`**, un objet par fichier (la forme de `git diff`, comme la page de GitHub) :

```js
{ path, oldPath?, status: 'added' | 'modified' | 'deleted' | 'renamed',
  additions, deletions,          // nombres ; recalculés depuis patch s'ils manquent
  hunks? | patch? }              // les hunks de R ({ lines: [{ kind: 'add'|'del'|'ctx', new, text }] }),
                                 // ou le texte unifié du fichier (lignes @@, +, -, espace)
```

`parseDiff(text)` produit ce tableau depuis la sortie de `git diff base...head` : R peut l'utiliser tel quel.

**La sortie :**

- `summary` : une ligne de dix mots au plus — « 12 fichiers +840 −120 · 2 règles enfreintes · 3 à risque » ;
  les chemins sont dans `readFirst`.
- `readFirst` : au plus 5 fichiers, risque haut puis moyen, à score égal le plus gros diff ; `why` est la
  première raison du fichier. Un fichier généré n'y entre jamais.
- `files` : tous les fichiers, triés par risque puis par score ; `reasons` en français, une ligne chacune ;
  `generated: true` pour un fichier généré (risque bas, la page le replie).
- `rules` : une entrée par infraction (`level: 'error'`), puis une par règle sans motif
  (`level: 'warn'`, `path: null`, `line: null`, `text: 'à vérifier par la revue'`).
- `checks` : vide sans `run: true` ; sinon une entrée par commande déclarée, `output` la sortie brute
  (stdout puis stderr) tronquée aux 4 000 derniers caractères.

## Le format des règles

Un fichier par projet : `<projet>/docs/regles.md`, sinon la section `## Règles` du `CLAUDE.md` du projet.
Du Markdown qu'un humain lit : une règle par puce (`- ` ou `* `). Une puce peut finir par un motif machine
entre accolades ; sans motif, la règle est pour la revue (Claude ou le dev) et sort en `warn`.

```markdown
## Règles

- Pas de console.log dans src/ {deny: console\.log in src/**}
- Une migration ne se modifie jamais {immutable: migrations/**}
- Tout nouveau fichier dans api/ a un test {requires-test: api/**}
- Pas de nouvelle dépendance sans ligne dans decisions.md {deps: package.json}
- Les noms de variables sont en anglais

## Vérifications

- `npm test`
- `npm run lint`
```

Les motifs :

| Motif | Lu sur | Infraction |
|---|---|---|
| `{deny: <regex> in <glob>}` | les lignes ajoutées des fichiers du glob (`in …` absent : tous) | une ligne ajoutée correspond à la regex (JavaScript, sans drapeau) ; `line` est son numéro dans le nouveau fichier |
| `{immutable: <glob>}` | les fichiers du glob | un fichier existant modifié, supprimé ou renommé (en ajouter un est permis) |
| `{requires-test: <glob>}` | les fichiers **ajoutés** du glob | aucun fichier de test du même nom de base (`x.test.*`, `x.spec.*`, `test_x.*`, ou un dossier `test`/`tests`/`__tests__`) dans le diff ni dans `repoFiles` |
| `{deps: <glob>}` | les fichiers de dépendances du glob | une dépendance ajoutée (une ligne `"nom": "version"` ajoutée dans `package.json`, une ligne ajoutée dans `requirements.txt`, `go.mod`, `Cargo.toml`…) sans ligne ajoutée à `docs/decisions.md` |

Plusieurs globs se séparent par une virgule (`{immutable: migrations/**, db/schema.sql}`). Les globs : `**`
(tous les dossiers), `*` (un segment), `?` ; un glob sans `/` vise le nom de fichier à toute profondeur
(`package.json` trouve `api/package.json`). Un motif mal formé (regex invalide, mot-clé inconnu) donne une
entrée `warn` « motif illisible » : la règle n'est jamais perdue en silence.

`## Vérifications` : une commande par puce, entre accolades inverses ou nue. Elles ne tournent qu'avec
`run: true`, dans `repo`, une à la fois, avec le délai ; `ok` est le code de sortie 0 (un délai dépassé est
`ok: false` et le dit dans `output`).

## Le risque par fichier

Des heuristiques simples, chacune donne une raison et des points ; haut à partir de 3, moyen à partir de 1,
bas sinon.

| Heuristique | Points | Raison |
|---|---|---|
| domaine sous garde (un glob de `guarded`) | 3 | « domaine sous garde (`<glob>`) » |
| migration (`migrations/`, `migrate`, `*.sql` sous `db/`, `schema.prisma`…) | 3 | « migration » |
| auth ou sécurité (`auth`, `login`, `session`, `token`, `crypto`, `permission`, `password`, `secret`, `security`, `jwt`, `oauth` dans le chemin) | 2 | « auth ou sécurité » |
| config ou dépendances (`package.json`, lockfiles, `Dockerfile`, `.github/`, `*.config.*`, `.env.example`, `tsconfig`…) | 2 | « config ou dépendances » |
| beaucoup de lignes supprimées (≥ 100, ou ≥ 50 et plus que d'ajoutées, ou fichier supprimé) | 2 | « 140 lignes supprimées » |
| code sans test touché à côté (un fichier de code modifié, aucun test du même nom de base ni dans le même domaine dans le diff ; le domaine est le dossier grand-parent s'il a deux niveaux, sinon le dossier : `server/domains/questions/__tests__/` couvre `server/domains/questions/controllers/`) | 1 | « code touché sans test à côté » |
| modifié par une autre session du plan (`others`) | 2 | « aussi modifié par la session B » |
| une règle machine enfreinte dans ce fichier | 3 | « règle enfreinte : … » |
| fichier généré (lockfile, `dist/`, `build/`, `*.min.*`, `*.map`, `__snapshots__`, `*.generated.*`, `vendor/`) | — | « généré » : risque bas forcé, `generated: true`, replié |

Un lockfile est à la fois une dépendance et un fichier généré : il reste bas et replié, c'est son
`package.json` qui porte le risque. L'ordre : risque, puis score, puis le code avant les tests, puis le
plus gros diff.

## L'option `claude` (point d'entrée seulement)

Les règles sans motif ne se vérifient pas par une regex. Plus tard, avec `claude: true` (réglage par projet
`prereviewModel`, éteint par défaut), une session courte en lecture seule lira le diff et ces règles et
rendra des entrées `rules` de niveau `warn` avec `path` et `line`. Aujourd'hui l'option est acceptée et
ignorée : la sortie porte `claude: { skipped: true, rules: [...] }`, les règles qu'une telle session lirait,
et aucun processus n'est lancé.

## L'essai réel

Le 2026-11-01, en lecture seule : `Orchard-docker-api`, `dev...release/r01` (19 fichiers, +1113 −70),
`git diff` et `git ls-tree` lus, rien écrit dans le dépôt. Les règles de l'essai (dans `$TMPDIR`, pas dans
Orchard) : pas de `console.log` dans `server/domains/**`, pas de `any` explicite en TypeScript, pas de
`.only`/`.skip`, un modèle Mongo immuable sans revue, les scripts d'index immuables, un test par nouveau
contrôleur, les dépendances, et deux règles sans motif. Domaines sous garde : `server/domains/auth/**`,
`server/**/models/**`. Vérifications non lancées (`npm test` y demande la base Docker de test).

```
19 fichiers, +1113 −70
19 règles enfreintes, 2 à vérifier par la revue
6 à risque haut : server/domains/userStats/models/UserAnswers.model.ts, server/scripts/addStatsIndexes.ts, server/domains/questions/services/listQuestions.ts…
```

À lire d'abord :

1. `server/domains/userStats/models/UserAnswers.model.ts` : règle enfreinte (modèle modifié), domaine sous garde.
2. `server/scripts/addStatsIndexes.ts` : règle enfreinte (script d'index réécrit).
3. `server/domains/questions/services/listQuestions.ts` : un `as any[]` ligne 216.
4. et 5. deux tests d'intégration (`emptyAnswers`, `dailyQuests`) : `any` dans les fixtures.

Le reste : 1 fichier moyen (`groupGameModes.service.ts`, code sans test à côté), 12 bas (contrôleurs couverts
par les tests du domaine, les tests eux-mêmes). 47 ms. Ce que l'essai a corrigé : la première version
signalait les 10 contrôleurs « sans test » alors que les tests d'intégration du domaine
(`questions/__tests__/`) étaient dans le diff ; « à côté » couvre maintenant le domaine. À régler sur le
vrai projet : la règle `any` vise les tests aussi (17 lignes sur 19) ; un vrai `regles.md` la viserait
sur `server/domains/*/services/**, server/domains/*/controllers/**`.

Sur Escadrille elle-même (cette branche contre `main`, `docs/regles.md`, `run: true`) : la règle « pas de
secret » se déclenchait sur sa propre ligne (le littéral `github_pat_`) ; corrigée. La vérification
`node --test test/*.test.mjs` rend 100 sur 101 : le test de push du téléphone (« the five kinds of push »)
échoue aussi sur `main` dans la suite entière et passe seul, un défaut de minutage antérieur à Q.

Note pour qui lance les vérifications : dans le bac à sable de Claude Code, Node ne peut lancer aucun
processus (`spawn EPERM`) ; `run: true` et les tests qui lancent des processus tournent hors bac à sable.

## Avant de signer (`pistes`)

La sortie gagne `pistes`, `asks`, `counts` et `declare` (`lib/signing.mjs`, docs/apprendre-en-signant.md).
`counts` ({ open, folded, foldedReliable, fragile, outside: [clés de domaine] }) : la page écrit les trois lignes
dans sa langue (clés `sign.*` de public/i18n), jamais la pré-revue. Options : `profile` ({ domains, known }, sinon lu dans `~/.config/calmdev/signing.json`,
`CALMDEV_SIGNING` pour un autre fichier, `signingFile: false` pour ne rien lire), `assume` (sinon lu dans
`.calmdev/assume.json` du dépôt), `branch` (cité dans la question au pair). Tests : `test/signing.test.mjs`.
