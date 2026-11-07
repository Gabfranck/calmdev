# Le flot du projet (écran 3)

Les quatre écrans d'un projet, dans l'ordre : Conversation · Ressources · **Flot** · Revue. Le flot montre, sur
un seul canevas façon n8n, toutes les sessions du projet en cours et à venir, leur coût, et ce qui se passe en
coulisse, lisible en un coup d'œil. Le flot d'un seul plan reste `/plan/:id` ; celui-ci les met côte à côte.

Le calcul est dans `lib/projectflow.mjs`, sans rien de neuf en base : il lit `plans`, `sessions`, `log` et le
dernier message `activity` de `session_messages`. Tenu par `test/projectflow.test.mjs`.

## L'API

`GET /api/projectflow?project=<chemin absolu>[&all=1]` (Mac seulement) → `flowOf(db, project, opts)` :

```
{ project, plans: [{ id, title, status, cost, budget, main: { merged, total }, eta, end: 'plan/main' }],
  nodes: [{ id: 'plan/session', plan, session, name, model, kind, status, wave, cost, budget, contextPct,
            startedAt, now, waitingFor, verb, human, eta, stopsDone, stopsTotal, stops: [texte], summary, after: [id] }],
  edges: [{ from, to, kind: 'after' | 'wave' | 'merge', met }],
  ends: [{ id: 'plan/main', plan, kind: 'next' | 'judge' | 'qa' | 'none', next: { id, title, status } | null,
           ready, merged, total, open, waitingFor: 'dev' | null, verb: 'launch' | null, eta }],
  totals: { running, waiting, mine, cost, budget, weeklyNow, weeklyAfter },
  story, finished }
```

- **Les plans montrés** : ceux qui ont encore une session qui n'est ni `done` ni `merged`. Un plan fini (toutes
  ses sessions finies, fusionnées ou livrées en kit) se replie dans `folded` (`[{ id, title, sessions, cost,
  merged }]`, `finished` en est le nombre) : une ligne grise « fini · 14 sessions · 63 $ » sous le canevas, hors
  des totaux, de « Ce qui m'attend » et de la phrase. `all=1` les remet sur le canevas.
  Ordre : le plan le plus actif en haut (`activity` : 3 par session en cours, en attente ou en erreur, 1 par
  session à lancer, 2 de plus par session qui attend le développeur), puis le plus récent.
- **`plan.status`** : `running` si une session tourne ou attend, `todo` si rien n'est parti, `done` si tout est
  fini, `merged` si tout est fusionné. `cost` est la somme des coûts réels, `budget` celle des plafonds.
- **`node.status`** : celui de la ligne `sessions`, sauf `done` + `worktree.merged` → `merged`, et `health: error`
  sur une session non finie → `error`.
- **`node.waitingFor`** : `permission` si une autorisation est en attente ; `dev` si une réponse (`reply`) est
  en attente ; `review` si la session est `done` et pas encore fusionnée, et que le projet relit tout (`review: 'strict'` dans
  ses réglages, `project_settings`) ou que le plan fusionne à la main sans être un kit (ni `autoMerge`, ni `kit:
  true`, ni `delivery: 'kit'`) ; `pilot` si elle est en
  `waiting` sans rien qui demande le développeur (un tour interrompu, que le pilote reprend) ; sinon `null`.
  Depuis la phase 13 (FL) : `merge` si la session est `done` et pas fusionnée et que le plan fusionne à la main (ni
  `autoMerge`, ni kit, ni fermé), jamais confiée au pilote ; une session `merged` n'attend rien, quelle que soit sa ligne.
  « Ce qui m'attend » : `dev`, `permission`, `review` et `merge` (`totals.mine`), plus un nœud de fin qui attend le clic.
- **`node.verb`** : le verbe de la pastille « À toi » : `judge` (`dev` sur un arrêt humain), `reply`, `allow`, `review`,
  `merge` ; `null` sinon. **`node.eta`**, **`plan.eta`**, **`end.eta`** : `{ at, low, high, basis, n, late }` ou `null`
  (`lib/eta.mjs`, `docs/flot.md` « Les ETA »). **`ends`** : le nœud de fin de chaque plan montré (`docs/flot.md`
  « L'issue de chaque phase »).
- **`node.now`** : pour une session qui tourne, son dernier message `activity` s'il est plus récent que son
  dernier bloc state ; sinon la ligne `claude` de ce bloc ; à défaut la dernière activité. Une ligne, coupée à
  140 caractères.
- **`cost`** : `usage.cost` de la session (réel, en dollars), 0 avant le départ ; **`budget`** : celui du plan,
  sinon le défaut du serveur (5 $). **`contextPct`** : `usage.context` (0..1) ou null. **`startedAt`** : la première
  ligne du journal en `running`, ou null. **`stopsDone`** : le nombre d'arrêts franchis, **`stopsTotal`** : ceux
  du plan.
- **Les arêtes** : `after` pour chaque dépendance écrite ; `wave` d'une session de la vague *n* sans `after`
  vers chaque session de la vague existante précédente (comme `/plan/:id`) ; `merge` de chaque session sans
  successeur vers le nœud de fin du plan, `<plan>/main` (la fusion dans main, dessinée en pastille). `met` est
  vrai quand la source est fusionnée (l'arête est satisfaite).
- **Les totaux** : `running` (en cours), `waiting` (en attente, quelle qu'en soit la raison, plus les sessions
  à relire), `cost` et `budget` (sommes sur les plans montrés), `weeklyNow` : le dernier quota hebdomadaire lu
  (0..1, `lastQuota`), `weeklyAfter` : `weeklyNow` plus ce qu'il reste à dépenser au plafond (budget moins coût
  des sessions non finies) converti par la calibration (`dollarsPerPct`, `docs/estimation.md`) ; null sans
  calibration.

Le rafraîchissement : `GET /api/events?project=<chemin>` envoie `change` à chaque écriture sur un plan du
projet (le même `change` que `?plan=`).

## La ligne de récit (sans IA)

Sous les totaux, une phrase faite des états. Les groupes, du plus urgent au moins urgent, chaque groupe vide sauté,
et chaque session dite une seule fois, dans le premier groupe qui la tient :

1. **Ce qui bloque une session sur toi** : `X attend ta réponse` (`dev`), `X demande une autorisation`
   (`permission`).
2. **Ce qui casse** : `X est en erreur`.
3. **Ce qui attend ta relecture** : `X attend ta relecture` (`review`), puis `X attend ta fusion` (`merge`), puis
   `Phase 13 attend ton clic` (un nœud de fin dont le plan suivant attend le lancement).
4. **Ce qui tourne** : `X code` (`running`), puis `X attend le pilote` (`pilot`).
5. **La prochaine qui partira** : la première session `later` (par vague, puis par ordre du plan) dont une
   dépendance n'est pas fusionnée : `X partira après A, C et D` (seules les dépendances non fusionnées) ; s'il y en
   a d'autres : `, puis N autres`.
6. **Ce qui reste à lancer** : `N à lancer` s'il reste des `todo`.
7. Si la phrase est vide : `Tout est fusionné.` s'il y a des plans montrés, sinon `Rien en cours ni à venir.`

**En tête, deux groupes au plus** (`story`), séparés par ` · ` : « A (R02) attend ta réponse · 9 sessions
codent. » La phrase entière (`storyFull`, groupes séparés par `, `) s'ouvre au clic sur « le détail ».

Règles d'écriture (Dev, 10:25 : le moins de texte possible, dix mots par élément) : les lettres sont jointes par `, ` et un `et` final (`A, C et D`) ; le verbe s'accorde
(`A code`, `A et C codent` ; `attend` / `attendent`, `est` / `sont`, `demande` / `demandent`) ; au-delà de quatre
sessions, un nombre (`12 sessions codent`). Quand les sessions que la phrase peut nommer (hors `todo` et `later`) viennent de plusieurs plans, les lettres sont regroupées par
plan, chaque groupe suivi du titre court du plan (le titre avant son premier `:`, `·`, `—` ou `(`) :
`C (R02) et E (Finition UI) attendent ta relecture`, `A, C (Phase 7) et A (R02) codent`. La phrase commence par une
majuscule et finit par un point.

## L'écran `/flow`

`public/flow.html`, un canevas SVG fait main : une colonne par vague, une bande par plan, des nœuds en cartes
compactes (lettre, nom, modèle, coût sur budget, barre fine des arrêts, point d'état), des arêtes courbes (pleines
pour `after`, en tirets pour `wave`, fines vers la pastille `main`), une pulsation sobre sur ce qui tourne
(coupée par `prefers-reduced-motion`). Glisser ou défiler au pavé pour déplacer, ⌘ ou pincer pour zoomer, « Ajuster » pour tout
voir. À l'ouverture : le plan le plus actif, cadré en largeur, jamais sous 0,85 (les cartes restent lisibles) ; une
vague de plus de six sessions se range en sous-colonnes ; le titre de la bande sous le bord haut reste collé. En tête une ligne de totaux, puis la phrase. Un clic sur un nœud ouvre le panneau de droite, une ligne par élément (le
texte entier au survol) : maintenant, fait, reste, les arrêts, le coût, « Ouvrir le fil » (`/plan/:id?node=X&tab=X#flow` : l'onglet de la session, ou le nœud ouvert sur le flot du plan si elle n'est pas partie) et « Relire » (la revue ; tant que l'écran de revue de S n'est pas
fusionné, la session dans `/plan/:id?node=X#sessions`, sur une session finie). Ce qui attend
le développeur a un contour ; « Ce qui m'attend » filtre. Sous 720 px, une liste par plan remplace le canevas.

**Le contrat d'interaction (phase 11, F, `docs/phase11/ux.md` §4.3 et §4.4).** Sur le Flot et le flot d'un plan :
un clic sur un nœud le sélectionne et ouvre son détail (le panneau à droite au Flot, sous le canevas dans un plan) ; un
second clic sur le nœud sélectionné, ou Entrée, ouvre son fil. La sélection se fait au `pointerup` quand rien n'a
bougé : la capture du pointeur ne commence qu'avec la glisse (au `pointerdown`, elle envoyait le `click` au board et
rien ne s'ouvrait). Échap ferme le détail et rend le focus au nœud (à la ligne de la liste sur le téléphone) ; × aussi.
Un seul nœud est dans l'ordre de Tab (le dernier visité, sinon le sélectionné, sinon le premier) : ← → ↑ ↓ vont au
voisin dans l'ordre de lecture, dans les deux sens, Début et Fin aux bouts, sans boucler ; un détail ouvert suit ; Tab
et Maj+Tab sortent et reviennent sur le même nœud. Le board ne défile jamais : ce qui le ferait défiler (un focus, un
`scrollIntoView`) devient un déplacement de la vue. Un rendu (clic, flux en direct) garde le focus sur le jumeau de
l'élément focalisé. `j` `k` et la ligne grise des touches sont partis ; « Ce qui m'attend » n'est affiché que s'il y a
quelque chose ; les touches sont dites dans l'aide qu'ouvrent `?` et le bouton « ? » du canevas (`EscadrilleCanvas.screen`,
qui laisse le générique à `public/ux.js` quand il est là). Dans un plan, ← → parcourent les onglets des sessions.
`node scripts/ux-contract.mjs` l'éprouve (« canevas · … »). Un nœud entièrement hors de la vue est masqué (`visibility: hidden`) : personne ne peut le voir ni le cliquer ; la porte
d'entrée au clavier est le premier nœud visible, et les flèches amènent les autres dans la vue avant de les focaliser.
