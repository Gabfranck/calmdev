# La QA sans terminal : `QA:` et la capture connectée

Phase 13, session QR. Une session écrit des parcours de QA dans son bac à sable mais ne peut pas les jouer (aucun
navigateur n'y démarre, `docs/capture.md`). Elle écrit donc une ligne, et le serveur joue les parcours hors du bac
à sable, dans le `chrome-headless-shell` de Playwright piloté en CDP (`lib/qarun.mjs`, sur le modèle de
`lib/capture.mjs`), puis lui rend une ligne de résultat. Le texte d'une session n'est jamais exécuté, rien ne sort du
Mac. Le modèle est le script privé du pilote qui a joué les 39 parcours d'Orchard le 2 novembre
(`qa/2026-11-02/parcours.json`, `resultats.json`, `planche.html` du projet) : même forme de fichier, mêmes résultats,
même planche.

## Le contrat des deux lignes

- **`QA: <chemin de parcours.json>`**, seule sur sa ligne, dans le texte d'un tour ou dans un champ texte du bloc
  `escadrille:state`. Le fichier finit en `.json` et son chemin réel (liens suivis) est dans le worktree de la session
  ou dans le projet. Cinq lignes `QA:` par tour au plus (`MAX_PER_TURN`).
- **`CAPTURE: <url> compte=<nom>`** : la page `<url>` photographiée derrière une connexion, avec le compte de test
  nommé, à 1440 et 390 px, en clair puis en sombre (`prefers-color-scheme: dark` émulé ; l'image sombre n'est gardée
  que si la page change). Sans `compte=`, la ligne reste la capture simple de `docs/capture.md`.
- **Une exécution à la fois par projet**, en file (`createQaQueue`) ; chaque résultat est un message système dans la
  page et une ligne `[système]` en tête du prochain message à la session ; quand la file est vide, la session est
  reprise seule aux mêmes conditions que pour ses captures (jamais au-delà d'un arrêt du plan, jamais quand une
  demande attend le développeur).
- **Le réseau** : le navigateur ne joint que `localhost`, `127.0.0.1` et les hôtes LAN déclarés par le projet
  (`environment.lanHosts`, adresses privées 10.x, 172.16-31.x, 192.168.x ou noms `.local` ; pour Orchard,
  `192.168.1.x`). Le résolveur de noms est bloqué (`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE …`) parce qu'une
  redirection échappe à l'interception des requêtes ; chaque requête vers un autre hôte est de plus refusée
  (`Fetch.failRequest`) et comptée dans les résultats (`bloquees`, `hotesBloques`) et dans la ligne rendue.
- **Le navigateur** : trouvé comme dans `lib/capture.mjs` (le cache Playwright, ou `CHROME_PATH` hors `.app`), profil
  temporaire, locale `fr-FR`, un contexte neuf par parcours, 120 s au plus par parcours (`TIMEOUT_MS` ; dépassé, le
  processus est tué et relancé pour le suivant), tué et profil effacé dans tous les cas.
- **La sortie** de `QA:` : `<worktree>/.escadrille/qa/<arrêt>-<fichier>/` avec `resultats.json` (la liste des
  parcours, forme du pilote : `id, sprint, ticket, app, compte, titre, attendu, incertain, ok, echec, console, http,
  cles, captures, bloquees, hotesBloques, ms`), `planche.html` (les échecs d'abord, chacun avec la console, les
  réponses HTTP ≥ 400, les clés brutes et ses captures) et `captures/<id>-<nom>.png` (plus `<id>-echec.png` à l'écran
  de l'échec). Jamais commité.
- **La sortie** de la capture connectée : `<worktree>/.escadrille/captures/<arrêt>-<compte>-<url>/` avec `1440.png`,
  `390.png`, `1440-sombre.png`, `390-sombre.png` quand la page a un sombre, et `console.json`
  `{ url, account, at, dark, errors, warnings, http, blocked, blockedHosts }`.
- **La ligne rendue** : `QA qa/parcours.json : 16/39 ok, 23 échecs, 2 requêtes hors Mac bloquées : …/resultats.json
  et …/planche.html`, ou `CAPTURE http://192.168.1.x:8081/play (compte eleve.lemon-active.2.05) : …/ (0 erreur de
  console, sombre : oui)`, ou la raison du refus, en une ligne.

## Le format d'un parcours

Un fichier est une liste de parcours (100 au plus). Un parcours :

| clé | sens |
|---|---|
| `id` | obligatoire, unique : lettres, chiffres, `-`, `_` |
| `etapes` | obligatoire, 1 à 200 étapes |
| `compte` | le compte de test **par son nom** (`prof.lemon-active`) ; `aucun…` ou `jeton…` = pas de connexion |
| `app` | `prof`, `eleve`, `landing`… : choisit la routine de connexion `base-login-<app>` du fichier |
| `connexion` | `incluse` : le parcours se connecte lui-même ; `routine` : ce parcours est la routine de connexion de son `app` |
| `largeur` | la fenêtre, 320 à 2560 px (1280 par défaut ; sous 480, un mobile de 844 px de haut) |
| `titre`, `attendu`, `sprint`, `ticket`, `note`, `prerequis`, `incertain` | repris tels quels dans les résultats et la planche |

Toute autre clé est refusée en une ligne, et le parcours n'est pas joué.

Les étapes, **liste fermée** (`STEPS`) ; une étape porte une seule action :

| étape | valeur | ce que fait le serveur |
|---|---|---|
| `aller` | une adresse `http://` sur un hôte autorisé | charge la page, attend `load` (10 s au plus) |
| `cliquer` | une cible | clique au centre de l'élément (souris réelle), 8 s pour qu'il apparaisse |
| `remplir` + `valeur` | une cible et le texte | sélectionne le contenu du champ et tape le texte (`\n` = retour) |
| `choisir` + `valeur` | un `<select>` et l'option (texte ou valeur) | change l'option et prévient la page (`input`, `change`) |
| `touche` | `Enter`, `Escape`, `Tab`, `Backspace`, `Space`, `ArrowUp/Down/Left/Right`, `Home`, `End` | une frappe |
| `attendre_texte` | un texte | attend qu'il soit visible (10 s) |
| `attendre_url` | un fragment d'adresse | attend que l'adresse le contienne (10 s) |
| `attendre` | des millisecondes, 5000 au plus | une pause |
| `capture` | un nom (`prof-accueil`) | une image pleine page `captures/<id>-<nom>.png` ; relève les clés brutes du texte visible (`home.tasks.title`) |

**Une cible vise toujours le visible.** Elle est cherchée dans cet ordre : le texte visible exact d'un élément
(« Se connecter »), un sélecteur CSS (`#login-password`, `button[aria-label="Fermer"]`), un placeholder, un
`aria-label` ou un libellé de champ, enfin un fragment de texte. Les éléments cachés (`display: none`, `visibility:
hidden`, opacité nulle, taille nulle, parent caché) ne comptent pas : le 2 novembre, le pilote a perdu des tours sur
CURSEUR parce que le premier « Proposer une question » de la page était caché ; ici c'est le premier **visible** qui
est pris. `>> nth=N` prend le N-ième visible dans l'ordre du DOM (`button[aria-haspopup="menu"] >> nth=1`) ; sur
Orchard, le menu du compte de la barre latérale compte en premier. Rien d'autre après `>>`. Le presse-papiers est
autorisé dans le contexte (« Copier le lien » puis « Lien copié »), le clic est une vraie souris (déplacement sans
bouton, pression, relâchement).

**Les valeurs à trous.** Une `valeur` peut contenir `{compte.identifiant}`, `{compte.motDePasse}` (le compte du
parcours, lu dans le réglage `environment` du projet), `{env.NOM}` ou `{NOM}` (une variable du même réglage, comme
`{DASHBOARD_TOKEN}`). Un trou qui ne se résout pas : le parcours n'est pas joué (« étape 4 : non joué : valeur à
résoudre ({DASHBOARD_TOKEN}) »). **Un mot de passe en clair tapé dans un champ `type=password` est refusé** à
l'exécution (« mot de passe en clair dans le parcours : écris {compte.motDePasse} ») : les mots de passe ne vivent que
dans le réglage, jamais dans le fichier, et ils n'apparaissent ni dans les résultats, ni dans la planche, ni dans la
ligne rendue (remplacés par `•••`).

## La connexion

Un parcours avec un `compte` (hors `aucun` et `jeton`) et sans `connexion: "incluse"` est précédé de sa routine de
connexion, dans un contexte neuf :

1. le parcours `base-login-<app>` du même fichier (ou un parcours `connexion: "routine"` de la même `app`), ses
   captures retirées ; le `remplir` de son propre compte devient `{compte.identifiant}`, un `remplir` en clair dans un
   champ dont la cible parle de mot de passe (`#login-password`, `placeholder="Mot de passe"`) devient
   `{compte.motDePasse}` ; c'est ainsi que les fichiers du pilote se rejouent sans changement ;
2. sinon, la routine du réglage `environment.logins` dont l'origine est celle du premier `aller` du parcours.

Le compte doit exister dans `environment.accounts` ; sinon « non joué : compte « x » inconnu dans le réglage
environment du projet ». La capture connectée (`CAPTURE: <url> compte=<nom>`) n'a pas de fichier : elle utilise
toujours la routine de `environment.logins` pour l'origine de l'URL.

## Le réglage `environment` (lu, jamais écrit ici)

Ce que `lib/qarun.mjs` lit du réglage du projet (écrit par la page du développeur, session ENV ; une session ne le
voit jamais, elle ne connaît que les noms de comptes) :

```json
{
  "lanHosts": ["192.168.1.x"],
  "accounts": { "eleve.lemon-active.2.05": { "identifiant": "eleve.lemon-active.2.05", "motDePasse": "<mot de passe du seed>" } },
  "logins": {
    "http://192.168.1.x:8081": { "aller": "http://192.168.1.x:8081/auth", "identifiant": "input[placeholder=\"Identifiant\"]", "motDePasse": "input[placeholder=\"Mot de passe\"]", "valider": "Se connecter", "attendre_texte": "Choisis ton mode de jeu" },
    "http://localhost:3050": { "aller": "http://localhost:3050/auth", "identifiant": "#login-username", "motDePasse": "#login-password", "valider": "Se connecter", "attendre_texte": "À faire" }
  },
  "env": { "DASHBOARD_TOKEN": "<jeton>" }
}
```

Les noms `hosts`, `comptes`, `connexions` et `variables` sont acceptés pour les mêmes champs. Un hôte hors LAN privé
refuse toute la QA en une ligne.

## Exemple

Le fichier `qa/parcours.json` du worktree :

```json
[
  { "id": "base-login-eleve", "app": "eleve", "compte": "eleve.lemon-active.2.05", "titre": "Connexion élève",
    "etapes": [ { "aller": "http://192.168.1.x:8081/auth" },
                { "remplir": "input[placeholder=\"Identifiant\"]", "valeur": "{compte.identifiant}" },
                { "remplir": "input[placeholder=\"Mot de passe\"]", "valeur": "{compte.motDePasse}" },
                { "cliquer": "Se connecter" }, { "attendre_texte": "Choisis ton mode de jeu" }, { "capture": "eleve-jouer" } ] },
  { "id": "curseur-proposer", "app": "eleve", "compte": "eleve.lemon-active.2.05", "titre": "Proposer une question curseur",
    "etapes": [ { "aller": "http://192.168.1.x:8081/contribute" }, { "cliquer": "Proposer une question" },
                { "attendre_texte": "Question curseur" }, { "capture": "eleve-curseur" } ] }
]
```

La session termine son tour par :

```
Les parcours sont écrits.
QA: qa/parcours.json
CAPTURE: http://192.168.1.x:8081/contribute compte=eleve.lemon-active.2.05
```

Le serveur répond dans la page, puis reprend la session avec ces lignes :

```
QA qa/parcours.json : 2/2 ok, 0 échec : …/.escadrille/qa/1-parcours/resultats.json et …/.escadrille/qa/1-parcours/planche.html
CAPTURE http://192.168.1.x:8081/contribute (compte eleve.lemon-active.2.05) : …/.escadrille/captures/1-eleve-lemon-active-2-05-192-168-1-2-8081-contribute (0 erreur de console, sombre : oui)
```

## Sur le Mac, hors du serveur

`node scripts/qarun.mjs <parcours.json> --environment env.json [--out dossier]` joue un fichier comme le serveur ;
`--check` valide et prépare sans navigateur (dit ce qui ne serait pas joué) ;
`--capture <url> --compte <nom>` prend la capture connectée. `env.json` a la forme du réglage ci-dessus et reste hors
de tout dépôt. Le 2 novembre, `--check` sur le vrai `qa/2026-11-02/parcours.json` d'Orchard accepte les 38
parcours tels quels ; seul `base-login-analytics` n'est pas joué tant que `DASHBOARD_TOKEN` n'est pas dans `env`
(le pilote avait la même ligne).

## Le premier vrai passage (2 novembre, sur le Mac, 38 parcours d'Orchard)

18 parcours joués, 137 images, même verdict que le pilote sur 26 ; 7 parcours de plus passent (menus, lots, langues,
landing). Les 20 échecs, triés : 7 mots de passe en clair (règle, corrigés par `{compte.motDePasse}` dans la copie
`.escadrille/qa/parcours-corrige.json` du worktree de QR, à recopier dans `qa/2026-11-02/parcours.json`) ; 4 parcours
mal écrits (ordre type/thème de « Créer une question », case de confirmation de l'import, dialogue sans « Annuler »,
« première carte de thème » qui n'est pas une cible) ; 4 menus `>> nth=N` à décaler d'un cran (le menu du compte
compte) ; 1 seed (prof.free déjà vérifié) ; 1 enchaînement (l'élève attend la session que le prof n'a pas lancée) ;
1 jeton absent ; 2 points du lanceur corrigés après ce passage (presse-papiers, souris) : « Lien copié » à rejouer.

## Le branchement dans le serveur (fait par PIL, phase 13)

**Fait** : `server.mjs` porte ce branchement sous « Phase 13 QR » (`qaOfTurn`, `qaQueue`, les comptes du projet lus par `envAccountsOf`), la phrase `QA:` est dans la consigne de suivi, et la boucle de QA de `lib/qaloop.mjs` s'y greffe (`docs/flot.md`, `docs/pilot.md`). Le texte qui suit est la proposition d'origine, gardée pour la lecture.

`lib/qarun.mjs` est complet et testé ; `server.mjs` n'est pas modifiable par une session (`docs/autonomy.md`). Le
branchement tient en quelques lignes à côté de « Phase 8 B » :

```js
import { parseQaLines, parseConnectedCaptures, qaFolderName, createQaQueue } from './lib/qarun.mjs'; // Phase 13 QR, docs/qarun.md
const qaQueue = createQaQueue({
  onNote: (project, job, line, r) => { addSessionMessage(job.planId, job.sid, 'system', line, { qa: r.ok ? { dir: r.dir, passed: r.passed, failed: r.failed, files: r.files, dark: r.dark } : { error: r.error } }); const k = keyOf(job.planId, job.sid); captureNotes.set(k, [...(captureNotes.get(k) || []), line]); },
  onIdle: (project) => { for (const k of new Set(qaSessions.get(project) || [])) { const [planId, sid] = splitKey(k); if (!captureQueue.busy(k)) resumeAfterCaptures(planId, sid, 'La QA est jouée : reprends.'); } qaSessions.delete(project); },
});
const qaSessions = new Map(); // project -> Set of "plan/session" waiting for the queue
// in the turn handler, next to capturesOfTurn(...):
const qaOfTurn = (planId, sid, text, state, row, plan) => {
  const stop = state?.stops?.length ? state.stops[state.stops.length - 1] : null; const project = plan.project; const k = keyOf(planId, sid);
  const environment = storedSettings(project).environment || {}; const worktree = row.worktree?.path;
  const jobs = [
    ...parseQaLines(text, state).map((file) => ({ kind: 'qa', planId, sid, file, target: file, worktree, project, environment, name: qaFolderName(stop, file) })),
    ...parseConnectedCaptures(text, state).map(({ target, account }) => ({ kind: 'capture', planId, sid, target, account, worktree, project, environment })),
  ];
  if (!jobs.length) return;
  qaSessions.set(project, new Set([...(qaSessions.get(project) || []), k]));
  qaQueue.enqueue(project, jobs);
};
```

Et dans la consigne de suivi des sessions (`server.mjs`, « Suivi, obligatoire à la fin de chaque tour »), la phrase :
« Pour jouer des parcours de QA, une ligne `QA: <chemin de parcours.json>` dans ton arrêt (format : docs/qarun.md) ;
pour photographier une page derrière une connexion, `CAPTURE: <url> compte=<nom du compte de test>` ; les mots de
passe ne s'écrivent jamais, seuls les noms de comptes. » La même phrase est dans `docs/terrain.md`.

## Les tests (`test/qarun.test.mjs`, faux site `test/fixtures/qarun/`)

Les lignes `QA:` et `CAPTURE: … compte=` ; le fichier dans le worktree ou le projet, liens suivis ; les hôtes LAN
et la règle du résolveur ; chaque étape de la liste et chaque refus en une ligne ; les valeurs à trous ; la routine de
connexion (du fichier, à la forme du pilote, et du réglage) ; `runQa` sur le faux site avec un pilote de test (un
parcours qui passe, un qui échoue, une étape inconnue refusée, une page qui appelle `example.com` et `10.0.0.z`
bloquée et comptée, un compte inconnu, un mot de passe en clair refusé) : résultats, planche échecs d'abord, aucun
secret dans les fichiers ; la capture connectée (quatre images, le compte par son nom) ; la file (une exécution à la
fois par projet). Le vrai navigateur ne tourne que s'il démarre : jamais dans le bac à sable d'une session, où ce test
est sauté ; sur le Mac, `node --test test/qarun.test.mjs` le joue sur le faux site (bouton caché, connexion,
mot de passe en clair, hôtes bloqués, 404 relevé, sombre détecté).
