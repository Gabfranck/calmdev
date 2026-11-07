# Ce que calmdev apprend de son usage : le contrat

calmdev apprend, projet par projet, ce que coûtent vraiment les tâches selon leur type et leur modèle, ce que
le développeur répond toujours de la même façon, ce que la revue refuse et ce qu'il corrige. Le planificateur s'en
sert pour poser moins de questions, choisir les modèles et les plafonds, et dire ce qu'il a appris quand ça
change un choix. Code : `lib/learning.mjs` ; tests : `test/learning.test.mjs`.

Pas de double vérité : **le registre se calcule à chaque lecture** depuis la base (plans, sessions, revues,
questions de planification, messages du développeur) et depuis `docs/backlog.md` du projet. Le seul fichier écrit
est `<projet>/.escadrille/preferences.md` (avec son état, `.escadrille/learning.json`), jamais commité.

## Le type d'une tâche

`kindOf(session)` → `front` | `back` | `migration` | `design` | `docs` | `tests` | `qa` | `other`. Le nom de la
session dit son rôle et décide quand il en nomme un (« L'écran des réglages » → front, « La vérification
d'ensemble » → qa) ; sinon le brief décide, par ses mots et les chemins qu'il cite (`public/`, `lib/`,
`migrations/`, `*.test.mjs`…). Les docs que tout brief demande de lire (`docs/flot.md`, `CLAUDE.md`) ne font pas
une tâche de docs : dans un brief, seuls README, CHANGELOG et CONTRIBUTING comptent pour docs.

## Le registre

- **Le coût réel** : `sessions.usage.cost` d'une session finie (`status = 'done'`).
- **L'estimé** : ce que l'estimation (`docs/estimation.md`) aurait dit quand le plan a été écrit : le même calcul
  sur les transcriptions finies avant `plans.created`. Rien n'est stocké en plus.
- **Le premier coup** : la première revue de code avec un verdict (hors `comment`) est `approve`, sans relance.
- **Les relances** : la somme de `reviews.retries`. **Les corrections** : les messages `dev` envoyés à la session.
- **Les questions** : chaque question d'un bloc `escadrille:questions` et la réponse du développeur au message
  suivant (« ok pour tout », « ok pour tout sauf : 2. … », « Réponses : 1. Oui … 2. … ») ; deux questions sont la
  même quand leurs titres (Jaccard ≥ 0,6) ou leurs énoncés (≥ 0,45) se recouvrent. Une question est **répétée** à
  partir de deux fois, **tranchée** quand toutes ses réponses vont dans le même sens.
- **Les refus** : les revues `reject`, `changes`, `retry` ou escaladées, avec leur texte et leurs commentaires.
- **Les défauts** : les lignes `- [ ] Défaut (<écran>) : …` de `docs/backlog.md`.

## L'écart d'estimation

Pour un type et un modèle, `ratio` = médiane de réel ÷ estimé sur les sessions qui ont les deux. Il s'applique à
partir de **3 sessions** (`GAP_MIN_SESSIONS`), borné à [0,25 ; 4]. `estimatePlan(plan, { adjust })` multiplie le
coût et la part hebdo d'une session planifiée par le ratio de son type et de son modèle ; `basis.learned` vaut
`{ kind, ratio, sessions }` (ou `null`) et `basis.rawCost` garde le coût d'avant. Le serveur passe
`adjust = adjusterOf(registre du projet du plan)` sur `GET /api/plan/:id` et `GET /api/escadrille/:id`.

## La distillation

Une session courte, **Sonnet, plafond 1 $**, lancée par le serveur (`distillTick`, toutes les heures, un projet à
la fois) **au plus une fois par semaine et par projet**, et seulement avec **au moins 5 nouveaux résultats**
(sessions finies, verdicts, questions répondues) depuis la précédente (`DISTILL_MIN_RESULTS`). Elle est en lecture
seule et ne lit rien : le registre, compact, est dans son message ; elle répond par un bloc
`escadrille:preferences` (`{"lines":[…]}`) et le serveur écrit le fichier :

- au plus **15 lignes**, les lignes du développeur comprises et en tête ;
- chaque ligne distillée finit par sa preuve chiffrée, `(preuve : 9 sessions, 8 approuvées du premier coup,
  médiane 6,10 $)` ; une ligne sans preuve est écartée, jamais écrite ;
- **les éditions du développeur priment** : une ligne que calmdev n'a pas écrite (son empreinte n'est pas dans
  `learning.json`) est à lui, gardée telle quelle, jamais réécrite ; une ligne distillée qu'il a retirée ou
  réécrite n'est plus proposée.

Seul le serveur par défaut distille : un serveur sur une autre base (`ESCADRILLE_DB`, les tests, une branche vue
sur une copie) ne le fait qu'avec `ESCADRILLE_LEARNING=on` ; `ESCADRILLE_LEARNING=off` l'arrête partout.

## Le planificateur

`learningSection(projet, registre)` ajoute à sa consigne « Ce qu'Escadrille a appris de ce projet » (titre de consigne gardé tel quel) : les lignes
de `preferences.md` (celles du développeur marquées `[développeur]`), les écarts appris, et la règle. La règle est
aussi dans `.claude/skills/plan/SKILL.md` (§ 1) : en tenir compte, ne pas reposer une question dont la réponse est
apprise mais la rappeler dans le plan (« Appris : … »), dire en une ligne quand une préférence change un choix.
Rien d'appris : pas de section.

## L'écran Apprentissage et le chiffrage avant de lancer

`/learning` (`public/learning.html`, entrée « Apprentissage » du groupe Projet). En tête, le chiffrage : le
développeur décrit une tâche, « Chiffrer » répond les trois formules du skill de plan (économe, recommandée, sans
limite) **sans session de planification et sans dépenser un jeton** (`lib/costing.mjs`) : le type de la tâche est lu
comme le registre le lit (`kindOf`), chaque formule est composée de rôles (les mains, la vérification, la passe
finale ; Sonnet pour les docs et les tests, Opus sinon, Fable là où il y a du jugement), et chaque session est chiffrée
par l'estimation (`docs/estimation.md`) corrigée par l'écart appris de son type et de son modèle ; la médiane réelle
des sessions finies du même type sur le même modèle est dite à côté. Quand l'estimation n'a aucune transcription à
lire (`basis.scope: 'none'`) mais que le registre connaît ce type sur ce modèle, cette médiane réelle chiffre la
session (`fromReal: true`, `basis.scope: 'registry'`), la part de la semaine seulement si la calibration donne
`dollarsPerPct` ; sans l'une ni l'autre, la formule reste sans chiffre, jamais 0. Un fichier `.escadrille/` que le
serveur n'a pas le droit de lire (bac à sable) est dit `unreadable` dans `preferences`, le rapport répond quand
même. `?task=<texte>` préremplit le champ et chiffre au chargement (un lien depuis une autre page, une capture).
Dessous, ce qui a été appris : les préférences
(éditables en place, `POST /api/learning/preferences`, les lignes du développeur restent les siennes et une ligne
retirée n'est plus proposée), l'écart estimé/réel par type et modèle en tableau, et le reste replié en une ligne.

- `POST /api/costing { project, text, lang }` → `{ plan: { id, title, kind }, costing: { kind, formulas: [{ tier,
  chosen, sessions: [{ id, name, role, model, wave, cost, rawCost, weeklyPct, learned, real }], cost, weeklyPct,
  delta, learned }], calibrated, weeklyNow }, calibration }`. `delta` : le coût face à la recommandée (−0,25 = un
  quart moins cher) ; un chiffre inconnu vaut `null`. Rien n'est écrit.
- `POST /api/costing/launch { project, text, lang, tier }` : la formule choisie devient un plan (`costed: true`,
  les trois formules gardées, le plafond de chaque session à 1,5 × son estimé arrondi au demi-dollar, jamais sous
  1 $, sinon le plafond du projet), écrit dans `plans/` et lancé aussitôt par le même chemin que « Lancer » ;
  répond `{ ok, plan, title, launched, queued }`.
- `POST /api/learning/preferences { project, lines | text }` → le fichier réécrit, `readPreferences()` en réponse.

### Le contexte fixe (phase 14)

Au-dessus des préférences, une seule ligne repliée : « Contexte fixe : N k tokens par appel, +x % depuis 7 jours »
(« depuis le <date> » sur un projet sans semaine d'avant ; sans croissance avec une seule session ; « pas encore
mesuré » sans transcription). Au-delà de +20 %, une pastille rouge. Ouverte : ce que chaque appel relit, trouvé sur
le disque (CLAUDE.md, MEMORY.md, la liste des skills, le prompt de la session, le reste), la base de la médiane.
Le contrat et les chiffres : `docs/frugal.md` « Le contexte fixe » ; code : `lib/context.mjs`.

## GET /api/learning?project=<chemin absolu>

400 si le chemin n'est pas un dossier absolu. Les nombres sont des nombres ; un chiffre inconnu vaut `null`.

```
{
  project,
  registry: {
    project, at, results,                      results : le compteur de la distillation
    totals: { plans, sessions, finished, withCost, cost, questions, answered, reviews, defects, corrections },
    byKind: [{                                 un groupe par type et modèle, les plus nombreux d'abord
      kind, model, sessions,
      cost:     { median, p25, p75, spread },  USD réels
      estimate: { median, p25, p75, spread },  USD estimés au moment du plan
      budget:   { median, p25, p75, spread },  plafonds donnés par les plans
      ratio:    { median, sessions },          réel ÷ estimé
      budgetUse,                               médiane de réel ÷ plafond
      reviewed, firstTry, firstTryRate,        firstTryRate null sans revue
      retries, escalated, corrections          corrections : médiane par session
    }],
    questions: [{ title, question, asked, answered, accepted, overridden, settled, last: { at, accepted, answer } | null }],
    refusals: { verdicts: { approve: n, changes: n, … }, items: [{ plan, session, kind, model, verdict, escalated, retries, at, body, comments: [""] }] },
    defects: { total, open, byScreen: { "<écran>" | "—": n }, recent: [{ done, screen, text }] },
    corrections: [{ plan, session, kind, at, text }]     les 20 plus récentes
  },
  preferences: { file, exists, at, lines: [{ text, source: "dev" | "distilled" }] },
  estimation: { gaps: [{ kind, model, ratio, sessions }], minSessions: 3, bounds: [0.25, 4] },
  distill: { lastAt, due, reason: "" | "week" | "results", newResults, nextAt, threshold: 5, everyDays: 7,
             model: "claude-sonnet-5-5", budget: 1, running },
  context: {                                 le contexte fixe (lib/context.mjs, docs/frugal.md)
    tokens, sessions,                        médiane du premier appel des sessions des 7 derniers jours ; null sans transcription
    before, beforeSessions, since,           la base de la comparaison : les 7 jours d'avant, sinon le premier jour (since : sa date)
    days: 7, growth, threshold: 0.2, alert,  growth = tokens ÷ before − 1 (null sans base) ; alert quand growth > threshold
    latest: { sessionId, tokens, at, model } | null,
    pieces: { claudeMd: { files, chars, tokens }, memory: { file, exists, chars, tokens },
              skills: { count, chars, tokens, bodyChars, list: [{ name, source, listed, chars }] },
              prompt: { sessions, chars, tokens }, charsPerToken: 4, rest }
  }
}
```

Le registre est recalculé à chaque appel de cette route (le serveur le garde une minute pour l'estimation et le
planificateur).
