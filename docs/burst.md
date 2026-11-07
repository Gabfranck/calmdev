# La rafale « Jusqu'à la limite » (phase 7, session K)

La demande de Dev (08:30) : un bouton qui dépense le quota restant sur les tâches du projet jusqu'à la prochaine
limite, et un mode auto qui le fait seul. Le code : `lib/horizon.mjs`, `lib/burst.mjs`, quelques routes de
`server.mjs`. `test/burst.test.mjs` vérifie ce contrat.

**Depuis le 6 novembre (premier contact de Dev) : « Avancer le backlog ».** La rafale n'est plus un mot ni un
réglage : c'est une action nommée par ce qu'elle fait. Le bouton « Avancer le backlog » demande jusqu'à quelle
heure (« Jusqu'à 18:00 », 4 h plus tard par défaut) et combien au plus (« Au plus 20 $ ») ; `POST /api/burst` prend
`until` (ISO, à venir, sinon 400) et s'arrête au premier atteint : cette heure, la limite du quota ou le plafond.
Tant qu'elle tourne, la carte dit « Avance le backlog jusqu'à 18:00, au plus 20 $ ». L'interrupteur du mode auto a
quitté l'écran (voir « Le mode auto ») ; `test/first-run-who.test.mjs` le vérifie.

## L'horizon

`horizonOf({ db, project })` → `{ usedPct, resetsAt, remainingPct, remainingUsd, hoursLeft, source }`.

- `usedPct`, `resetsAt` : la ligne d'`escadrilles` la plus récente qui a `weekly` et `reset_at` (tous projets : le
  quota est celui du compte).
- `remainingUsd` : `remainingPct` × la valeur d'un point (calibration de `lib/usage.mjs`) ; `source: 'calibration'`.
- Sans quota lu ou sans calibration : `source: 'none'`, `remainingUsd: null`.

## Le backlog

`docs/backlog.md` du projet, une tâche par puce, dans l'ordre : `- [ ] …` à faire, `- [x] …` ou `- ~~…~~` faite,
`- …` à faire. `readBacklog(project)` → `[{ n, text, done }]` (`n` à partir de 1).

Création (jamais d'écrasement, 409 si le fichier existe) :

- `roadmap` : les puces de la section « Reporté » la plus récente de `ROADMAP.md`, sinon celles de la dernière
  phase non faite ;
- `memory` : parmi les 20 dernières lignes de la mémoire du projet, celles qui commencent par un infinitif ou
  « Reste à » ;
- `text` : le texte donné, une ligne par tâche.

## Les routes (Mac seulement)

```
GET  /api/project/horizon?project=     → horizonOf
GET  /api/project/backlog?project=     → { exists, tasks }
POST /api/project/backlog              { project, from: 'roadmap'|'memory'|'text', text? } → { tasks }
POST /api/burst                        { project, tasks: [n…], capUsd, model?, drainMin? } → { id }
POST /api/burst/:id/stop               → { ok }
GET  /api/burst/:id                    → la rafale
GET  /api/bursts?project=              → { bursts }
```

## La table

```sql
create table bursts (id text primary key, project text, created text, status text, cap_usd real,
                     spent_usd real default 0, until text, drain_at text, model text,
                     tasks text, log text);
```

`status` : `running` → `draining` → `done` | `stopped` (Stop) | `limit` (plafond en dollars).
`tasks` : `[{ n, text, status, escadrille, plan, cost }]`, `status` : `todo` → `planning` → `running` → `done` |
`failed`. `log` : `[{ at, text }]`, une ligne par événement.

## La machine d'états

Une tâche à la fois, dans l'ordre :

1. `planning` : `createEscadrille` (idée = la tâche, modèle du projet sinon `claude-opus-5-5`), avec la section
   « ## La rafale » dans le system prompt du planificateur.
2. Bloc `questions` : la rafale répond « ok pour tout », comme le bouton « Tout accepter ».
3. Bloc `plan` : `network: []`, `autonomy: { mode: 'autonome' }` (le réglage du projet s'il est plus strict),
   budgets bornés au reste de la rafale (au prorata), puis `launchPlan` (première vague). `running`.
4. `done` quand le plan est fini, ou quand toutes ses sessions sont `done` et attendent un humain depuis 10 min.
   Tâche suivante.
5. `failed` si le planificateur échoue ou n'écrit pas de plan. Tâche suivante.

Dépensé = `usage.cost` des sessions des plans de la rafale + `usage` de leurs planificateurs.

## La fin : une vidange, pas un arrêt net (pilote, 10:50)

Le but : atteindre la limite sans laisser de travail en cours pour la semaine suivante.

- **Arrêt net** (`stopProcess` sur les sessions de la rafale) seulement au plafond en dollars (`limit`) et sur
  Stop (`stopped`). Une session arrêtée se reprend à la main.
- **Vidange** (`draining`) : plus aucune tâche lancée quand le temps jusqu'à `until` est plus court que
  l'estimation de la tâche suivante, ou passé `drainAt`.
- En vidange, chaque session en cours va jusqu'à son arrêt suivant, puis reçoit une fois « Finis et livre ce qui
  est fait. » ; les tâches encore `todo` restent `todo`. La rafale passe `done` quand plus rien ne tourne.
- `until` = la limite (`reset_at`), ou l'échéance `ESCADRILLE_BURST_UNTIL` si elle est plus tôt (défaut : 13 h 45 le
  1er novembre, la fin du tour autonome) ; sans limite connue, dans 4 h.
- `drainAt` = `until` − 45 min (`drainMin` dans `POST /api/burst`, défaut 45).

## La fin à l'heure, sans exception (phase 10, session D)

Le 1er novembre, la rafale de midi (jusqu'à 14:00) est restée `draining` jusqu'au soir et a relancé une session au
redémarrage du serveur. Désormais :

- `until` passé (`pastUntil`), la rafale finit `ended`, vidange ou pas : au tic (`burstStep`, avant tout autre
  calcul) et au démarrage du serveur (`burstExpire`, avant la reprise des sessions).
- `ended` arrête toutes les sessions de ses plans, celles d'une tâche finie comprises (`sessionStop`) : elles quittent
  la page (`mode` nul) avec une ligne qui le dit, et se reprennent à la main ; une planification en cours s'arrête.
- Au démarrage, une session d'une rafale finie (tout statut final : `done`, `stopped`, `limit`, `ended`) n'est jamais
  reprise seule, même restée dans la page ; elle le dit (« Pas reprise au redémarrage : sa rafale est finie »).
- `status` : `running` → `draining` → `done` | `stopped` | `limit` | `ended` (heure de fin passée).
- Estimation d'une tâche : la durée moyenne des tâches déjà faites de la rafale, sinon 45 min.
- Le quota restant vient du dernier `rate_limit_event` lu (`weeklyNow` de `lib/horizon.mjs` : planificateurs et
  sessions confondus) ; il ne déclenche pas d'arrêt, seul le plafond en dollars le fait.

Push : `burst-start` (« Rafale lancée : 4 tâches, 60 $ au plus, jusqu'à 09:00 ») et `burst-end` (fait, dépensé, arrêt).

## Le mode auto

Réglage du projet `autoBurst: { on, minMarginPct, maxHoursLeft }`, `null` par défaut (= éteint, 30, 8).
Toutes les 5 min : si `on`, aucune rafale en cours, marge > `minMarginPct` et limite à moins de `maxHoursLeft` h,
une rafale part sur les tâches à faire avec 60 % de la marge. Une ligne de journal et le push. La vue Accès le
montre en ambre (L).

Depuis le 6 novembre, l'écran n'allume plus jamais ce mode et un nouveau projet ne l'a pas (`autoBurst: null`). Le
serveur garde le réglage lisible : un ancien projet où il est allumé continue de tourner et la page le montre en une
ligne, « Ancien réglage : avance seul quand la marge dépasse 30 % · Éteindre » (`autoBurst: null`).

## Le partage avec l'autonomie (L)

| La rafale (K) | Le moteur d'autonomie (L) |
| --- | --- |
| crée les escadrilles, répond aux questions du planificateur | répond aux arrêts par leur repli |
| écrit `autonomy`, `network: []`, les budgets | répond aux autorisations par la règle de D |
| lance la première vague, avance, s'arrête | vagues suivantes et file (C), fusion si tests verts |

La rafale ne répond jamais à un arrêt ni à une autorisation, et ne fusionne rien. Seule exception, la vidange :
« Finis et livre ce qui est fait. » part à l'arrêt suivant d'une session, à la place du repli. Le moteur de L le
voit par `burstDraining(plan)` (exporté par `lib/burst.mjs`) et ne répond pas à cet arrêt-là.

## La revue (R)

- `review: 'strict'` : la rafale produit, rien n'est fusionné sans approbation.
- Une file de revue (`GET /api/reviews`) estimée à plus de 2 h : la rafale ne lance plus de plan, elle attend.
  Estimation : une heure par 400 lignes changées, comme « À relire » sur l'accueil.

## Les garde-fous

- Mode Autonome : seules la sécurité et la livraison attendent le développeur.
- Bac à sable, aucun réseau (`network: []`), aucune question dont la recommandation ne suffit pas.
- Pas de fusion dans main sans tests verts et sans la case du projet (L).
- Arrêt net au plafond en dollars ou sur Stop ; à l'approche de la limite, vidange : rien de neuf, le travail en cours se livre.
- Rien en production, aucun service externe, rien de facturé.

## L'essai (1er novembre, session K)

Port 3189 (3099 était pris par un autre serveur), base jetable, faux claude (`test/burst-fake.mjs`), un quota lu à
46 %, `ESCADRILLE_DOLLARS_PER_PCT=30` : horizon « 54 % · environ 1 620 $ de marge ». Rafale des tâches 1 et 3,
plafond 5 $ : deux plans lancés, « ok pour tout » envoyé à chaque planificateur, 1,20 $ dépensés, `done` en 8 s.

## Reporté

- Le moteur de L ne lit pas encore `burstDraining(plan)` : en vidange, il peut répondre à l'arrêt avant la rafale.
- En vidange, les vagues suivantes d'un plan déjà lancé partent encore (le serveur et L les lancent).
- Le mode auto n'a tourné que dans les tests unitaires (`autoWants`), pas dans un essai de 5 min.
- La vue Rafale n'a pas eu son passage `inspect.mjs --app` (Chrome refusé dans le bac à sable de la session).
- Le test `multiproject` « migration » échoue dans le bac à sable (`/private/tmp` écarté) ; il passe sur le Mac.
