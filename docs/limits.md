# Les limites et leurs seuils

Ce qui peut arrêter le travail de Claude, une ligne chacune dans le panneau d'état (bloc « Limites » à côté de la
Conversation), et deux seuils par limite réglés dans Accès. Code : `lib/limits.mjs` (pur), `lib/status.mjs` (les
fenêtres lues), quelques lignes de `server.mjs` (l'application). Session T de la phase 9, 2026-11-02.

## Les limites, dans l'ordre où elles arrêtent le travail

| Ligne | Source | Seuils par défaut (doux / dur) |
| --- | --- | --- |
| Fenêtre de 5 h | `rate_limit_info.unifiedWindows.five_hour` (ou l'ancienne forme `rateLimitType: "five_hour"`) | 90 / 98 % |
| Quota hebdo | `unifiedWindows.seven_day` ; avant toute lecture du flux par ce serveur, la dernière en base | 80 / 95 % |
| Hebdo Fable, et tout `seven_day_<modèle>` reçu | `unifiedWindows.seven_day_<modèle>` | 80 / 95 % |
| Plafond de la rafale en cours | `spentUsd / capUsd` de la rafale active ; fin à `until` | 90 / 100 % |
| Plafond du plan en cours | coût du plan / `autonomy.planCapUsd`, sinon la somme des budgets de ses sessions | 90 / 100 % |

La ligne la plus proche de son seuil (la plus petite marge sous le seuil doux) passe en tête, sur fond relevé, avec
« N points de marge » ou « seuil franchi ». Chaque jauge est la vraie proportion ; le seuil doux est un trait
`--warning`, le dur un trait `--negative`. Une ligne non mesurée le dit et n'a ni chiffre ni barre.

Aucun défaut ne bloque un nouvel utilisateur : un compte neuf est loin de 80 %, rien de mesuré ne bloque rien.

## Les sources : ce qui est prouvé, ce qui ne l'est pas

- **Prouvé** (Claude Code 2.1.316, observé le 1er novembre 2026 sur l'offre Ultra, `lib/planner.mjs` et
  `test/planner.test.mjs` depuis la phase 1) :

  ```json
  {"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"seven_day":{"utilization":0.04,"resetsAt":1793538000}}}}
  ```

  `utilization` est une part de 0 à 1, `resetsAt` des secondes Unix. Ce jour-là, seul `seven_day` est revenu
  (docs/backlog.md) : la fenêtre de 5 h et Fable s'affichent « non mesuré ».
- **Non prouvé, lu s'il arrive** : `five_hour` et `seven_day_<modèle>` dans `unifiedWindows`, et l'ancienne forme à
  une fenêtre par événement (`rateLimitType`, `utilization`, `resetsAt` au niveau de `rate_limit_info`). Le code les
  lit, les tests les simulent ; rien n'est affiché tant qu'aucun événement réel ne les porte.
- **Ce que la session T n'a pas pu lire** : le bac à sable refuse `~/.claude/projects` (les transcriptions JSONL) et
  n'a ni `claude` ni réseau ; les transcriptions ne gardent d'ailleurs pas les `rate_limit_event` (ils ne sont que
  dans le flux stream-json). Aucun extrait de `five_hour` ou de Fable n'a donc été vu : à prouver hors du bac.
- **La mesure par modèle** : le mesureur du panneau (`status.measureAll`) fait un appel Haiku minimal, puis, si
  l'événement n'a pas de fenêtre Fable, un appel Fable minimal (`claude -p ok`, aucun outil, un tour, 0,05 $ de
  plafond), au plus toutes les 10 minutes et seulement quand une page lit le panneau. S'il revient sans `seven_day_fable`,
  c'est que Claude Code ne la donne pas : la ligne reste « non mesuré ».

Pour prouver, hors du bac, une commande (≈ 1 centime, réseau vers api.anthropic.com) :

```sh
claude -p ok --model claude-fable-5-1 --output-format stream-json --verbose --tools "" --max-turns 1 --max-budget-usd 0.05 | grep rate_limit_event
```

Coller la ligne obtenue ici, sous « Prouvé », datée.

## Les seuils

- **Doux** : au-delà, calmdev ne lance plus de session ni de vague (la garde de la file, `queue.addGuard`), ne
  démarre plus de rafale, et la rafale en cours passe en vidange (« Vidange : Quota hebdo à 82 %, seuil doux 80 % »).
  Le panneau le dit au-dessus des lignes. Une planification peut encore tourner : elle lit les marges.
- **Dur** : au-delà, tout ce que le serveur a lancé pour le projet s'arrête (sessions, planifications, la rafale qui
  finit en `limit`) ; chaque session dit en une ligne, dans son fil et dans son état du Flot (santé en erreur),
  quelle limite l'a arrêtée : « Arrêtée par une limite : Quota hebdo à 96 %, seuil dur 95 % ». Un plan au-delà de
  son propre seuil dur s'arrête seul.
- **Quand** : à chaque lecture d'usage (chaque `rate_limit_event` d'une session ou d'une planification, chaque mesure,
  chaque tic de la rafale, 15 s), avant chaque lancement, et dans chaque pas de la rafale. Une lecture antérieure à
  une remise à zéro passée ne compte plus (la fenêtre a recommencé) : elle ne bloque rien.
- **Où** : Accès, section « Limites », repliée en une ligne (les seuils appliqués). Deux portées : « Tout le Mac »
  (ligne `*` de `project_settings`) et « Ce projet ». Le Mac fixe la ligne (les défauts là où il ne dit rien, vide =
  la valeur au-dessus) ; un projet ne peut qu'être plus strict.
- **API** : `GET /api/limits?project=` → `{ defaults, mac, project, effective, rows }` ;
  `POST /api/limits { scope: 'mac' | 'project', project?, limits: { weekly: { soft, hard }, … } }` (1 à 100, ou vide ;
  doux ≤ dur ; `null` efface). `GET /api/status` porte `limits: { rows, verdict }`.
- **Seuil à date de fin** (« 50 % jusqu'à lundi soir ») : une clé envoyée avec `until` (date ISO) garde la valeur
  qu'elle remplace dans `previous` (`null` s'il n'y en avait pas). À l'heure dite, le serveur remet `previous` (ou
  retire la clé), note « Seuil … revenu à … » dans le journal du pilote (celui du projet, ou de chaque projet connu
  pour le Mac) ; le panneau Accès affiche « jusqu'au <date> » à côté de la valeur appliquée. Les réglages sans
  `until` ne changent pas.

Le garde que le pilote a écrit la nuit du 1er novembre (alerte à 20 %, coupe à 25 % du quota hebdo) s'écrit
maintenant : Accès → Limites → Tout le Mac → Quota hebdo, doux 20, dur 25.

## La pause (phase 10, session P)

Au seuil dur d'une fenêtre qui se remet à zéro (5 h, hebdo, hebdo d'un modèle), chaque session que le serveur a lancée
pour le projet arrête son processus et passe au statut `paused` : la ligne garde `pause` (`limit`, `line`, `until`,
`was`), le Flot dit « n sessions en pause · limite · reprise seule à hh:mm » avec « Tout reprendre ». Un plafond en
dollars (rafale, plan) arrête toujours : il ne se remet pas à zéro seul.

- Reprise seule (`pauseStep` de `lib/limits.mjs`, à chaque lecture et toutes les 30 s) : l'heure de remise à zéro
  passée, une lecture antérieure à la remise, ou une lecture qui remet la limite sous son seuil doux (seuil relevé dans
  Accès). La session repart avec `--resume` et « Pause levée, reprends là où tu en étais. » ; celle qui attendait le
  développeur attend de nouveau ; la file avance ensuite (les vagues reprennent).
- Tant qu'une fenêtre est au-dessus de son seuil dur, la pause tient (sa cause passe à elle) ; une limite non mesurée
  avant sa remise tient aussi.
- « Tout reprendre » (`POST /api/limits/resume { project }`, Mac) reprend tout de suite et laisse courir les limites
  alors franchies jusqu'à leur remise (en mémoire du serveur).
- La pause vit dans la base : un redémarrage la garde. Un message du développeur, un Stop ou la fin de la rafale la
  lèvent ; une session d'une rafale finie n'est pas reprise seule.
- Rafale : au seuil dur d'une fenêtre, la rafale se vide au lieu de finir ; sa tâche reprend à la remise.

## La part de la semaine (phase 11, session PS)

Dev : « bloque à 50 % pour la semaine pour Escadrille, et 25 % pour Orchard ». Une part par projet, pas un seuil
global par projet.

- La part consommée = coût des sessions du projet (`usage.cost` des sessions et des planificateurs en base) depuis la
  dernière remise à zéro hebdo (la remise du quota hebdo moins sept jours) ÷ la valeur d'un point (`dollarsPerPct`,
  `/api/usage`). Une session qui a couru à cheval sur la remise compte en entier : le côté prudent.
- Elle n'existe que si le projet a une part réglée (`POST /api/limits { project, share: 50 }`, `null` la retire) :
  rien par défaut. Sans calibration ou sans remise lue, la ligne dit « non mesurée », jamais un chiffre.
- Seuil doux implicite à 90 % de la part (rien de nouveau ne se lance pour ce projet), la part elle-même comme seuil
  dur. Elle n'est pas soumise à « plus strict que le Mac » : c'est une part, pas un seuil du compteur global ; le seuil
  hebdo du Mac reste au-dessus.
- Au-delà, les sessions de ce projet seul passent en pause (le mécanisme de P) ; les autres projets continuent. Reprise
  à la remise à zéro, ou dès que la part relevée repasse au-dessus du consommé (sous le dur suffit : le doux ne fait
  que retenir les nouvelles sessions).
- Accès : la ligne « Part de la semaine » sous les seuils (un nombre, en %) ; le panneau d'état : « Part de la semaine
  consommé / part », la jauge à l'échelle de la part, le 90 % dessiné.
- Tests : `test/share.test.mjs` (deux projets sur un flux simulé : l'un dépasse sa part et se met en pause, l'autre
  continue ; la part relevée le reprend).

## Le planificateur

La consigne d'une planification se termine par « ## Les marges » : une ligne par limite, la plus serrée d'abord,
« Quota hebdo : 62 % utilisés, seuil doux 80 % → marge 18 points, remise dans 3 j », ou « non mesuré ». Le plan se
taille dans la plus petite marge.

## La source sans token (2026-11-02, le pilote)

`claude -p /usage --output-format json` renvoie, sans appeler de modèle, les lignes « Current week (all models): 18% used · resets Nov 8 at 2pm (Europe/Paris) » et « Current week (Fable): 29% used · … ». C’est la seule source trouvée pour Fable ; lib/status.mjs la lit en premier (parseUsageText), l’appel Haiku reste le repli. Sur Ultra, aucune ligne « Current session » : pas de fenêtre de 5 h affichée par Claude Code pour cette offre.

- La fenêtre de 5 h vient de la même sortie de `/usage`, ligne « Current session » ou « 5-hour » (parenthèses facultatives, remise datée, à l'heure seule = le prochain instant futur, ou relative « in 2h 10m ») ; le seul texte réel gardé (`test/fixtures/usage-2026-11-02.txt`, compte Max 20x affiché « Ultra ») n'en a pas, les autres formes sont plausibles et testées une à une (`test/status-usage.test.mjs`).
- « non mesuré » veut dire : `/usage` n'a imprimé aucune ligne de 5 h comprise (et l'appel Haiku ne porte que seven_day) ; une ligne non comprise est ignorée, jamais devinée, et une remise passée donne « remise » (lib/limits.mjs), jamais une heure passée.
- Quand `/usage` répond sans fenêtre de 5 h, sa sortie brute caviardée est gardée dans `.escadrille/usage-raw.txt` du dépôt (jamais commitée) : la lire avant de toucher au parseur.
