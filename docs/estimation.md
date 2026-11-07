# L'estimation d'usage : le contrat

Ce que le serveur calcule (`lib/usage.mjs`) et ce que l'écran du plan rend (`public/`). Les nombres
sont des nombres, jamais des chaînes formatées ; un chiffre inconnu vaut `null`, jamais `0`.

## Où il apparaît

| Route | Réponse |
| --- | --- |
| `GET /api/plan/:id` | `{ plan, state, log, estimate, formulas }` (formulas : une ligne par formule, lib/formulas.mjs) |
| `GET /api/escadrille/:id` | `{ escadrille, messages, plan, state, estimate }` ; `estimate` vaut `null` tant qu'il n'y a pas de plan |
| `GET /api/usage` | la page de vérité : les sessions passées agrégées (les 50 plus récentes), les résumés par projet et par modèle, la calibration |

## La forme

```
estimate = {
  sessions: { "<id de session du plan>": SessionEstimate, … },
  total: {
    tokens, low, high,      sommes des tokens, p25 et p75 des sessions (entiers)
    cost,                   USD au tarif public, somme des sessions ; null si une session n'a pas de prix
    weeklyPct,              0..1, somme des sessions ; null si la calibration manque
    weeklyNow,              dernier utilization hebdo observé depuis le dernier renouvellement, 0..1 (planificateurs et
                            sessions, lib/horizon.mjs weeklyNow) ; null si jamais observé ou si toute observation
                            précède le renouvellement (resetsAt)
    weeklyAfter,            weeklyNow + weeklyPct ; null si l'un des deux manque
    resetsAt                ISO 8601 du reset du quota hebdo ; null si inconnu
  },
  calibration: {
    calibrated,             true quand dollarsPerPct est connu
    dollarsPerPct,          USD au tarif public pour 1 % du quota hebdo ; null sinon
    weeklyNow,              comme total.weeklyNow
    observedAt,             ISO 8601 de l'observation qui calibre dollarsPerPct (la plus récente du planificateur,
                            même antérieure au renouvellement : la valeur d'un point ne change pas au reset) ; null sinon
    days: 7,                la fenêtre de la calibration
    sessions,               nombre de transcriptions qui ont des tokens dans la fenêtre
    unseen,                 entier : sessions de la fenêtre sans transcription (interactives), non comptées
    unseenDirs              leurs dossiers (cwd), les plus fréquents d'abord ; [] si aucune
  }
}

SessionEstimate = {
  tokens, low, high,        médiane, p25, p75 des tokens totaux (lus + écrits) des sessions passées, × factor
  input, output,            médianes séparées : lus (entrée + écriture et lecture de cache), écrits, × factor
  cost,                     USD au tarif public du modèle de la session, × factor ; null si modèle sans prix
  weeklyPct,                0..1 ou null (non calibré)
  basis: {
    sessions,               nombre de sessions passées dans la base de calcul
    scope,                  "project" | "all" | "none"
    model,                  le modèle de la session planifiée (id complet), ou null
    calibrated,             weeklyPct vient d'une calibration réelle
    unseen,                 entier : sessions non vues du même périmètre (le projet si scope "project", sinon toutes)
    promptChars,            longueur en caractères de session.prompt (0 si absent)
    baseChars,              médiane des longueurs du premier message des sessions de la base ; null si aucune connue
    factor                  promptChars / baseChars borné à [0.5, 2] ; 1 si l'un des deux manque
    learned,                { kind, ratio, sessions } : l'écart appris de ce type de tâche sur ce modèle, déjà appliqué à cost et
                            weeklyPct (docs/learning.md) ; null sans écart appris ; absent hors du serveur
    rawCost                 cost avant l'écart appris
  }
}
```

Unités : `weeklyPct`, `weeklyNow`, `weeklyAfter` sont des fractions (0.0023 = 0,23 %). `cost` et
`dollarsPerPct` en dollars US. Les tokens sont des entiers.

## D'où viennent les chiffres

1. **Les sessions passées.** Chaque fichier `~/.claude/projects/<dossier>/*.jsonl` (sans récursion) est
   une session. Une même réponse apparaît sur plusieurs lignes (une par bloc de contenu) avec le même
   `message.id` et le même `usage` : chaque id compte une fois, la dernière ligne gagne. Les lignes
   `isSidechain: true` (sous-agents) comptent dans les tokens mais pas dans les tours. Tokens lus =
   `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` ; écrits = `output_tokens`.
   Un tour = une réponse de l'API sur le fil principal. Les agrégats sont en cache dans la table
   SQLite `transcripts` (clé : le chemin ; invalidée par mtime et taille).
2. **La base d'une session planifiée.** Les sessions passées du même projet : même dossier que
   `session.path`, ou même dépôt (le dossier parent qui a un `.git` ; un worktree compte pour son
   dépôt principal). S'il y en a moins de trois : toutes les sessions (`scope: "all"`) ; aucune :
   `scope: "none"` et des zéros. Puis le facteur de prompt (point 5).
3. **Le coût.** La médiane des coûts des sessions de la base, chacune recalculée au prix du modèle de
   la session planifiée, avec son propre mélange d'entrée, d'écriture de cache (5 min / 1 h), de
   lecture de cache et de sortie. Les prix sont la table `PRICES` de `lib/usage.mjs` (source et date
   en commentaire).
4. **La calibration.** Le dernier `utilization` hebdo vu par le serveur (table `escadrilles`, colonnes
   `weekly` et `at`, écrites depuis `rate_limit_event` par `lib/planner.mjs`). On additionne le coût au
   tarif public de toutes les transcriptions dans les 7 jours qui précèdent `at` (à l'heure près) ;
   `dollarsPerPct = coût7j / (utilization × 100)` et `weeklyPct = cost / dollarsPerPct / 100`. Sans
   observation, `calibrated: false` et tous les `weeklyPct` valent `null` : l'écran le dit. En cache une
   minute. Les sessions non vues (`unseen`) sont comptées sur la même fenêtre (7 jours avant `at`, ou
   avant maintenant sans observation). **La part affichée (`weeklyNow`) ne vient que d'une observation
   postérieure au dernier renouvellement** (`lastQuota` = `weeklyNow` de `lib/horizon.mjs` : la plus
   récente des lectures des planificateurs et des sessions depuis le reset), sinon `null` ; le défaut du
   2 novembre (74 % lus à 11:42, avant le renouvellement de 13:00, quand le Flot disait 33 %) venait
   d'une lecture périmée. `dollarsPerPct` reste calibré par la dernière observation du planificateur,
   même antérieure au reset : la valeur d'un point ne change pas au renouvellement.
5. **Le facteur de prompt.** Pour chaque transcription, `promptChars` = la longueur du premier message
   utilisateur du fil principal (première ligne `type: "user"` hors `isSidechain` et `isMeta`, texte
   seul : une chaîne, ou la somme des blocs `text` ; images et résultats d'outils exclus). Pour la
   session planifiée, `session.prompt.length`.
   `factor = clamp(promptChars / médiane(promptChars de la base), 0.5, 2)`, arrondi à 0,001 ; 1 si le
   prompt est vide ou si aucune session de la base n'a de longueur connue. `tokens`, `low`, `high`,
   `input`, `output` et `cost` (donc `weeklyPct`) sont multipliés par `factor`.

### Les limites du facteur

- Le prompt pèse peu dans une session : ce sont les fichiers lus, les outils et les tours qui font
  les tokens. La longueur dit l'ampleur de la consigne, pas celle du code à parcourir ; d'où les bornes.
- Un prompt planifié par calmdev porte le bloc de suivi (quelques centaines de caractères) ; les
  sessions passées faites à la main ne l'ont pas. La base mélange donc des prompts d'origines
  différentes, et le facteur penche un peu vers le haut pour les sessions planifiées.
- La médiane de la base est prise sur les sessions qui ont un premier message ; une session reprise
  (`--resume`) commence par un message court qui ne dit rien de sa taille.

### La rendre meilleure en phase 5 (proposé, pas codé)

La table `sessions` garde dans sa colonne `usage` l'usage réel de chaque session lancée par
calmdev (`input`, `output`, `cost` au tarif public lu dans le flux), à côté de son `prompt`. Une
fois une dizaine de sessions finies :

1. Ratio réel/estimé par session : `usage.cost / estimate.cost` au lancement (garder l'estimation dans
   la ligne de la session quand elle part, une colonne `estimate`).
2. Une correction par projet : la médiane de ces ratios, appliquée en plus du facteur, bornée elle
   aussi ; elle remplace la base « toutes les sessions » dès qu'un projet en a trois.
3. Régresser `log(usage.cost)` sur `log(promptChars)` pour ces sessions-là : la pente remplace
   l'exposant 1 implicite du facteur (une pente de 0,3 voudrait dire qu'un prompt deux fois plus long
   coûte 23 % de plus, pas le double). Avec peu de points, on garde la pente 1 et les bornes.
4. Ces sessions ont aussi une transcription (`-p`) : elles entrent déjà dans la base ; la correction
   ne compte que l'écart entre l'estimation et le réel, pas deux fois leur coût.

## Les durées (lib/eta.mjs, 2026-11-03)

- La durée d'une carte est la médiane du temps réel des sessions finies du même genre et du même modèle. Sans groupe
  d'au moins `MIN_GROUP` (2) sessions dans le projet, elle **emprunte au même genre et au même modèle dans les autres
  projets de la base**, puis au genre seul (le projet, puis les autres), puis à toutes les sessions (le projet, puis
  les autres) ; sinon `null`, l'écran dit « — ».
- Chaque ETA dit d'où vient son chiffre : `basis` (`kind+model`, `kind`, `all`) et `source` (`project` ou `others`) ;
  celle d'un plan vaut `others` dès qu'une de ses cartes emprunte.
- Une session d'intégration ou de vérification (genre `qa`, `TESTED_KINDS`) compte, en plus de son temps en `running`,
  la durée réelle des tests que le serveur a lancés pour elle (messages système « Tests de la branche fusionnée à
  blanc » → « Tests : code N », `testSpansOf`).
- Preuve : `test/eta.test.mjs`, une base construite comme la journée Harbor du 3 novembre (Harbor vide, Escadrille avec
  historique) : le plan neuf est estimé à 6 h pour 5,6 h réelles ; sans l'emprunt, `null`.

## Les sessions interactives (ce qu'on a trouvé, 2026-11-01)

1. Claude Code 2.1.316 n'écrit un `.jsonl` que pour les sessions `-p`, dans
   `~/.claude/projects/<cwd encodé>/<sessionId>.jsonl` (un worktree a son propre dossier) ; une session
   interactive lancée dans un terminal n'en écrit aucun.
2. `~/.claude/sessions/` garde, pour chaque session vivante, `<pid>.<hash>.key` et `<pid>.json` :
   `pid`, `sessionId`, `cwd`, `startedAt` (ms), `entrypoint` (`sdk-cli` pour `-p`), `status`…
   Aucun usage, mais de quoi nommer une session et la relier à sa transcription par `sessionId`.
3. Rien d'autre d'utile dans `~/.claude` : `history.jsonl` (les prompts tapés), des sauvegardes de
   `.claude.json`, `shell-snapshots`. (Vérifié par Dev, noms seuls ; la session C, en bac à sable, ne
   lit que des fixtures.)
4. Donc on compte honnêtement (`scanLiveSessions`, `unseenSessions`) : une session est « non vue »
   quand son `<pid>.json` démarre dans la fenêtre de calibration et qu'aucune transcription n'a son
   `sessionId` ; un `.key` seul (sans `.json`) est daté par son mtime et non vu si aucune transcription
   ne démarre à deux minutes près. `calibration.unseen`, `calibration.unseenDirs` et `basis.unseen`.
5. Ce que ça change : leur coût manque au coût des 7 jours, donc `dollarsPerPct` est sous-estimé et
   les `weeklyPct` plutôt trop hauts (prudents) ; la base d'un projet ne les voit pas non plus.
   L'écran le dit en une ligne : « N sessions interactives non comptées (dossiers : …) ».
6. `ESCADRILLE_TRANSCRIPTS` désigne la racine des transcriptions, `ESCADRILLE_SESSIONS` le dossier des
   `.json`/`.key` (par défaut `~/.claude/sessions`) ; les tests pointent les deux sur `test/fixtures/`.
   `test/usage.test.mjs` passe dans le bac à sable d'une session. Les tests de worktree et d'API aussi,
   à condition d'un PATH qui ne contient aucun dossier refusé (`PATH=/usr/bin:/bin:$PATH`) : sinon
   `spawn git EPERM`.

## Exemple complet

Calculé le 2026-11-01 sur les fixtures de `test/` (la session C ne lit pas `~/.claude`) : trois
transcriptions de 200, 100 et 400 caractères de premier message, un quota de 1 % observé à minuit, un
faux `~/.claude/sessions` avec trois sessions sans transcription. Plan `exemple` (5 sessions, A placée
dans `/fx/alpha`) ; la réponse de `GET /api/plan/exemple`, réduite à A et B :

```json
{
  "estimate": {
    "sessions": {
      "A": { "tokens": 1560, "low": 1280, "high": 1704, "input": 1510, "output": 50, "cost": 0.0015, "weeklyPct": 0.00167,
             "basis": { "sessions": 3, "scope": "all", "model": "claude-opus-5-5", "calibrated": true,
                        "unseen": 3, "promptChars": 76, "baseChars": 200, "factor": 0.5 } },
      "B": { "tokens": 1669, "low": 1370, "high": 1823, "input": 1616, "output": 54, "cost": 0.0035, "weeklyPct": 0.003943,
             "basis": { "sessions": 3, "scope": "all", "model": "claude-fable-5-1", "calibrated": true,
                        "unseen": 3, "promptChars": 107, "baseChars": 200, "factor": 0.535 } }
    },
    "total": { "…": "les sommes, comme avant" },
    "calibration": { "calibrated": true, "dollarsPerPct": 0.0089, "weeklyNow": 0.01,
                     "observedAt": "2026-11-01T00:00:00.000Z", "days": 7, "sessions": 2,
                     "unseen": 3, "unseenDirs": ["/fx/alpha", "/fx/gamma"] }
  }
}
```

A : base médiane 3120 tokens, prompt de 76 caractères contre 200 → 0,38, relevé au plancher 0,5 →
1560. B : 107 / 200 = 0,535 → 3120 × 0,535 = 1669. L'écran : « 3 sessions interactives non
comptées (dossiers : alpha, gamma) ».

`GET /api/usage` rend la même calibration, avec en plus `cost7d` et `unseenSessions` (une entrée par
session non vue : `sessionId`, `cwd`, `startedAt`, `entrypoint`) ; chaque session de la liste gagne
`promptChars`.

Non calibré (aucun quota observé) : `weeklyPct: null` partout, `total.weeklyNow`, `weeklyAfter`,
`resetsAt` à `null`, et `calibration = { "calibrated": false, "dollarsPerPct": null, "weeklyNow": null,
"observedAt": null, "days": 7, "sessions": 0, "unseen": N, "unseenDirs": […] }` (les sessions non vues
se comptent sur les 7 jours avant maintenant).
