# La QA groupée par projet

Une QA par projet, jamais une par plan (Dev, 6 novembre 22:55). Quand une fusion a eu lieu depuis la dernière QA et
qu'aucune session du projet ne travaille (running ou starting ; une session qui attend le développeur ne retient pas la
QA, ce qu'elle fusionnera ira dans la suivante), « À toi » montre une ligne « QA groupée prête » avec le bouton
**Commencer la QA**. Rien ne part seul : le clic lance une courte session, **QA**, qui écrit une seule liste à cocher
`docs/qa/<projet>-<date>.md`, couvrant toutes les fusions depuis la QA précédente, chaque comportement une seule fois.
Le modèle de forme reste `docs/qa/phase-9.md`.

## Quand

- Prête : au moins un plan fusionné après `projectQa.at` (la dernière QA du projet, dans ses réglages) et aucun plan
  du projet en cours (`running`, `starting`, `waiting`), ni la QA précédente (`lib/qa.mjs` `needsProjectQa`).
- Qui agit : `nextStep({ kind: 'projectQa', status: 'ready' })` (`lib/nextstep.mjs`) dit `dev`, geste `startQa`.
  « À toi » lit ce mot, sans calcul à part (Dev, 6 novembre 22:35).
- Jamais pour un plan de kits ni un plan retiré, ni pour un projet dont le réglage `qa` vaut `false` (Accès).
- Le réglage `qa: 'plan'` garde l'ancienne QA de fin de plan, lancée seule (`qaCheck`), pour qui la veut.
- Les QA par plan pas encore lancées sont abandonnées au démarrage du serveur (Dev, 6 novembre 22:05) : la session
  sort du plan, `plan.qa.abandoned` garde la date (`pendingPlanQa`, `abandonPlanQa`).

## La session

- `POST /api/qa/start { project }` : 409 si rien n'est prêt ; sinon un plan « QA groupée · <projet> · <date> » d'une
  session (Sonnet, 3 $), lancé, et `projectQa = { at, plan, plans }` dans les réglages du projet.
- Le brief (`projectQaBrief`) reprend, plan par plan, chaque session (arrêts, résumé, ce qu'elle a dit, sa fusion) et
  les commits de fusion lus dans git (`git log --grep escadrille/<plan>/`). Il n'autorise qu'à écrire le fichier.

## Où le voir

- « À toi » : la ligne et son bouton ; `GET /api/projectflow?project=` porte `qa: { plans, lastAt, next }`.
- La Revue montre en tête les plans de QA (les trois plus récents) ; `GET /qa/<plan>` montre le fichier.

Tests : `test/fiab.test.mjs` (6 et 7), `test/qa.test.mjs` (le brief, la QA par plan derrière `qa: 'plan'`).
