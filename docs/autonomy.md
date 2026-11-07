# L'autonomie d'une escadrille (phase 7, session L)

Ce qui attend un humain, ce qui suit son repli, ce qui ne se règle jamais. `lib/autonomy.mjs` décide (pur,
testé sans serveur) ; `server.mjs` applique.

## Les modes

| Mode | Ce qui attend un humain | Autorisations |
|---|---|---|
| `surveille` (défaut) | chaque arrêt | toutes attendent |
| `guide` | `taste`, `security`, `release` | la règle locale (`docs/policy.md`) : vrai → autorisé, faux → refusé, null → attend |
| `autonome` | `security`, `release` | comme Guidé |

Un arrêt sans `fallback` attend toujours. `waitKinds` (facultatif) remplace la liste du mode.

## Les genres d'un arrêt

`taste` (goût, design, wording), `review` (code à relire), `data` (schéma, migration), `security` (clés,
réseau, permissions), `release` (fusion, tag, publication), `info` (rien à décider ; défaut).

Un arrêt du plan : une chaîne (genre `info`, sans repli) ou `{ title, kind, fallback }`.
`lib/blocks.mjs` exporte `stopTitle(stop)`, `stopKind(stop)`, `stopFallback(stop)` ; l'affichage lit
toujours le titre.

## Le réglage `autonomy` d'un projet

`GET/POST /api/project/settings` (Mac), validé champ par champ, 400 lisible :

```
autonomy: {
  mode: 'surveille' | 'guide' | 'autonome',          // 'surveille'
  waitKinds: [genres],                                // facultatif, remplace la liste du mode
  guardedPaths: [motifs],                             // ['.github/**', '**/*.env*', '**/migrations/**']
  planCapUsd: nombre | null,                          // null : la somme des budgets des sessions
  askAboveUsd: nombre | null,                         // 20 : au-delà, une vague de plus attend un humain
  autoMergeIfGreen: booléen,                          // false
  testCommand: chaîne | null,                         // null : pas de fusion automatique
  quietHours: { from: 'HH:MM', to: 'HH:MM' } | null,  // null
  notifyLevel: 'all' | 'waiting' | 'none',            // 'waiting'
  fallbackDelayMin: nombre,                           // 10 (ESCADRILLE_FALLBACK_MIN le remplace)
  stopAtQuotaLimit: booléen                           // true
}
```

`parallel` (session C) reste une clé à part ; la vue le compte parmi les réglages d'autonomie.

## Le champ du plan

Un plan reçoit `autonomy` à sa création (`withSettings`) : le réglage est un défaut, le plan est un contrat.
`POST /api/plan/:id/settings { autonomy }` ne fait que durcir, sinon 400 : mode plus surveillé, plus de
genres qui attendent, plus de motifs, plafonds plus bas, délai plus long, fusion auto éteinte, arrêt à la
limite allumé.

## Ce que fait le moteur

- **Repli** : une entrée `reply` dont l'arrêt ne demande pas d'humain reçoit `fallbackAt` ; à l'heure, le
  texte du repli part comme message `dev` (`data.auto: true`), une entrée `info` « Repli envoyé après N min
  (Guidé) : … » et une ligne au journal. Un humain qui répond avant annule. Au redémarrage, les minuteries
  repartent des `fallbackAt` de `pending`. Vaut pour tout plan en Guidé ou Autonome, rafale ou non.
- **Autorisation** : `allow` ou `deny` par la règle locale répondent seuls (`data.auto: true`, la raison) ;
  `wait` laisse la demande à l'humain.
- **Domaines sous garde** : à chaque tour, `git diff --name-only <base>...HEAD` plus les fichiers non
  commités ; un chemin sous garde met la session `review: { files, since, seen: false }` et ajoute l'entrée
  `review`. Tant que `seen` est faux : pas de fusion (400 « à relire : … »), pas de vague qui l'attend.
  Seul un clic humain sur le Mac met `seen`.
- **Fusion si tests verts** : à `done`, avec `autoMergeIfGreen` et `testCommand`, la commande tourne dans le
  worktree (`sh -c`, 10 min au plus) ; code 0 → fusion ; sinon une entrée `info` avec la fin de la sortie.
- **Budget** : `askAboveUsd` dépassé → entrée `ask-budget`, « Continuer » lève la garde pour ce plan ;
  `planCapUsd` atteint → plan arrêté, entrée `alert`.
- **Quota** : `stopAtQuotaLimit` refuse un démarrage quand l'hebdo connu est à 100 % avant sa remise à zéro.
- **Notifications** : `notifyLevel` filtre (`waiting` : attente, autorisation, relecture, budget) ;
  pendant `quietHours`, rien ne part et rien n'est renvoyé après.

## La livraison « kit »

Un plan peut porter `delivery: 'kit'` : ses sessions livrent une branche, sans fusion. Une session `done` compte
comme livrée pour les vagues suivantes (et pour « plan fini ») ; la fusion reste un clic.

## Les routes

- `GET /api/plan/:id/session/:sid/diff` → `{ files, stat, patch }` (patch borné à 200 Ko)
- `POST /api/plan/:id/session/:sid/reviewed` → `{ ok }` (Mac seulement)
- `POST /api/plan/:id/session/:sid/continue-budget` → `{ ok }` (lève `askAboveUsd` pour ce plan)

## Les entrées neuves de `pending`

- `review` : `{ id, kind: 'review', files, text, at }`
- `ask-budget` : `{ id, kind: 'ask-budget', cost, budget, limit, text, at }`
- `reply` gagne `fallbackAt` (ISO) quand un repli est programmé, `fallback` son texte.

## Les garde-fous fixes, qu'aucun mode ne lève

- Jamais de réseau sans domaine déclaré dans le plan.
- Jamais hors bac à sable sans un clic.
- Jamais de push ni de publication sans un clic.
- Jamais de fusion dans main avec des tests rouges.
- Aucune fenêtre ni app ouverte sur le Mac.

## Garde-fous protégés

Quand le projet est Escadrille (le dépôt d'où tourne le serveur, ou un dépôt qui porte `lib/guardrails.mjs` et
`server.mjs`), aucune session ne peut affaiblir ce qui la tient. La liste est écrite dans le code
(`lib/guardrails.mjs`, `PROTECTED`, figée), jamais dans un réglage qu'une session pourrait changer ; le test vérifie
que cette section dit la même chose (phase 10, session E) :

- `lib/guardrails.mjs`
- `lib/policy.mjs`
- `lib/autonomy.mjs`
- `lib/worktree.mjs`
- `lib/planner.mjs`
- `lib/limits.mjs`
- `lib/review.mjs`
- `server.mjs`
- `docs/autonomy.md`
- `test/guardrails.test.mjs`
- `CLAUDE.md`

Trois verrous, quel que soit le mode d'autonomie :

1. **Le bac à sable** d'une session d'Escadrille refuse l'écriture de ces fichiers dans son worktree
   (`sandbox.filesystem.denyWrite` pour Bash, `Edit(//…)` pour les outils de fichiers), et celle des refs qui
   déplaceraient main sans le serveur (`refs/heads/<base>`, `packed-refs`, `HEAD` du `.git` commun, avec leur `.lock` ;
   `.git/hooks` et `.git/config` sont déjà refusés par Claude Code). Le prompt le dit : la session ne contourne pas,
   elle le dit (`health: "error"`) et s'arrête.
2. **La fusion** relit la branche à ce moment-là (`git diff --no-renames HEAD...<commit>` : un renommage nomme
   les deux côtés, un commit fait par la plomberie de git sans écrire le fichier est vu). Un fichier protégé touché :
   refus (409, `guard: [fichiers]`), la revue s'ouvre en « Garde-fou touché ». Le bouton, les tests verts, la page de
   revue et la fusion automatique passent tous par là.
3. **L'accord** est un clic de Dev dans son navigateur : `POST …/reviewed` avec le cookie `escadrille_guard`, et le
   commit vu dans le diff (`head`). Sans cookie : 403 ; un autre commit : 409. La fusion se fait sur ce commit
   précis : un commit de plus redemande l'accord.

Pourquoi un cookie : une session joint le serveur sur 127.0.0.1 depuis son bac à sable (vérifié le 2 novembre), donc
« depuis le Mac » ne veut pas dire « un humain a cliqué ». La clé vit dans `~/.config/escadrille/guard-key` (0600),
un dossier que le bac des sessions ne lit pas ; le serveur écrit à côté `guard-link`, le lien à ouvrir **une fois**
dans son navigateur (`GET /guard?k=…` pose le cookie, HttpOnly, SameSite=Strict, dix ans). Les tests passent
`ESCADRILLE_GUARD_DIR` ; un serveur de test sans lui garde une clé en mémoire.

Ce qui n'est pas couvert : un module non protégé qu'un fichier protégé importe peut changer son comportement à
l'exécution ; la revue du diff reste la défense. Les autres routes « Mac seulement » (réglages, fusion d'une branche
sans garde-fou) restent joignables par une session sur 127.0.0.1.

## Limites

- Les vues lisent des titres : `GET /api/plan/:id` rend `stops` en titres et `stopMeta: [{ kind, fallback }]` à côté ;
  le JSON du plan garde les objets. Qui lit `plans/*.json` en direct passe par `stopTitle`.
- `notifyLevel` vaut `waiting` par défaut : plafond, erreur et « plan fini » ne partent plus au téléphone sans `all`.
- `quietHours` et `notifyLevel` se règlent librement sur un plan (ce ne sont pas des garde-fous).
- Les domaines sous garde se lisent à chaque tour : un fichier écrit puis effacé dans le même tour n'est pas vu.
- `askAboveUsd` compte le coût réel du plan plus le plafond de la session qui démarre.
- Les motifs sous garde se modifient un par ligne dans une zone de texte, pas par boutons.

## Reporté

- Le niveau de revue strict de R (`mergeAllowed`, `docs/review.md`) : R n'était pas fusionnée ; une session à relire
  bloque déjà la fusion et les vagues.
- Le raccourci des textes de Q (summary, why en dix mots).
- Les push `review` et `ask-budget` partent ; l'app téléphone ne les montre pas encore à part.
- L'outil de capture par Chromium headless (`CHROME_PATH`) : au pilote ; la règle locale refuse ce qui ouvre une fenêtre.

**Interdits en écriture** (Dev, 2 novembre 01:00) : seuls les fichiers qui définissent les garde-fous sont refusés en écriture aux sessions (`lib/guardrails.mjs`, `lib/policy.mjs`, `docs/autonomy.md`, `test/guardrails.test.mjs`, `CLAUDE.md`, liste `WRITE_DENIED`) ; les autres fichiers protégés restent modifiables, et leur fusion attend la revue du développeur.

**Clé du développeur** (Dev, 2 novembre 04:00 : « tu peux tout valider », « les revues design uniquement ») : la fusion n'attend la clé du développeur que pour les cinq fichiers qui définissent les garde-fous (WRITE_DENIED, que les sessions ne peuvent pas écrire) ; server.mjs et lib/ fusionnent sur tests verts dans le bac à sable et la revue du pilote ; le développeur garde la validation sur image de ce qui se voit (accueil, landing, logo, planches de design).
