# L'environnement de dev d'un projet

Phase 13, session ENV. Un projet déclare dans ses réglages comment son environnement de dev démarre, s'arrête, se
remet à neuf et se lit (Docker, bases, apps web). Une session le pilote par une ligne, `ENV: up`, `ENV: down`,
`ENV: reset` ou `ENV: status`, sur le modèle de `CAPTURE:` (`docs/capture.md`) : le serveur exécute **la commande
déclarée par le développeur**, hors du bac à sable de la session, et lui rend le résultat. **Le texte d'une session
n'est jamais exécuté.** Rien ne sort du Mac, rien n'est poussé.

Le besoin (Dev, 2 novembre 2026) : développer Orchard sans garder un terminal Claude Code ouvert. Une session dans
son bac à sable ne peut ni démarrer Docker ni jouer un parcours de QA ; c'était le pilote, hors bac à sable, qui le
faisait par des scripts privés. Ces gestes passent dans le serveur, sous des règles fixes.

## Le réglage `environment`

Dans les réglages du projet (`project_settings`, clé `environment`), écrit par `POST /api/project/settings`
**avec le cookie `escadrille_guard` du développeur** (le même que l'accord d'un garde-fou, `docs/autonomy.md`) :
sans lui, 403. Une session joint le serveur sur 127.0.0.1 depuis son bac à sable ; elle n'a pas ce cookie, elle ne
peut donc pas écrire ce réglage. Dans la page : Accès › Réglages › « Environnement de dev », un champ où le JSON se
colle tel quel ; « Effacer l'environnement » puis Enregistrer envoie `null`.

```json
{
  "cwd": "~/Dev/Orchard/Orchard-v2",
  "commands": {
    "up":     ["docker", "compose", "up", "-d", "--remove-orphans"],
    "down":   ["docker", "compose", "down"],
    "reset":  ["docker", "compose", "exec", "-T", "api", "npm", "run", "seed", "--", "--replace"],
    "status": ["docker", "compose", "ps"]
  },
  "env": { "LAN_IP": "192.168.1.x" },
  "health": ["http://localhost:8080/", "http://localhost:3050/", "http://192.168.1.x:8081/"],
  "lanHosts": ["192.168.1.x"],
  "accounts": { "prof": { "username": "prof.free", "password": "password" } },
  "timeouts": { "up": 300000 },
  "healthTimeoutMs": 180000,
  "tests": { "Orchard-teacher": { "command": "npm test", "reads": ["Orchard-teacher/node_modules", "Orchard-analytics"] } },
  "note": "dev.sh écrit .env (LAN_IP, API_MYSQL_*) : le lancer une fois à la main avant"
}
```

| Champ | Ce que c'est | Règle |
| --- | --- | --- |
| `cwd` | le dossier où les commandes tournent | absolu, existant ; le projet par défaut |
| `commands.up/down/reset/status` | **un argv**, le programme puis ses mots | jamais de shell : `$(…)`, `;`, `&&` arrivent au programme tels quels |
| `env` | les variables ajoutées à l'environnement des commandes | une valeur dont le nom ressemble à un secret (`KEY`, `TOKEN`, `PASSWORD`…) est masquée dans la sortie |
| `health` | les adresses attendues après `up`, lues par `status` | `http(s)://`, hôte `localhost`, `127.0.0.1` ou un `lanHosts` ; toute réponse HTTP sous 500 vaut « répond » |
| `lanHosts` | les hôtes LAN permis (l'app élève lue par QR depuis un téléphone) | une IPv4 ou un nom, sans port |
| `accounts` | les comptes de test `{ nom: { username, password } }` (`identifiant`, `motDePasse` acceptés) | **jamais dans la base** : ils vont dans `~/.config/escadrille/secrets.json` (`lib/secrets.mjs`, 0600, illisible des sessions) ; le `GET` rend le nom et l'identifiant, jamais le mot de passe ; une session ne voit que les **noms** ; absents dans un nouvel envoi, les comptes stockés restent ; `null` sur tout le réglage les efface |
| `timeouts` | la durée maximale d'une commande, en ms | défauts : up 180 s, down 60 s, reset 240 s, status 20 s ; au-delà, le groupe de processus est tué (SIGTERM, puis SIGKILL après 3 s) |
| `healthTimeoutMs` | l'attente des adresses après `up` | 90 s par défaut |
| `tests` | la commande de tests par dépôt, voir plus bas | clé : le chemin du dépôt relatif au projet (`.` pour le projet lui-même) |
| `note` | un mot pour le développeur | libre |

Un secret ne va **jamais dans un argv** (il serait relu par la page et écrit tel quel dans la sortie) : dans `env` sous
un nom qui le dit, ou dans `accounts`.

## La ligne `ENV:`

- **La demande** : `ENV: up`, `ENV: down`, `ENV: reset` ou `ENV: status`, seule sur sa ligne, dans le texte d'un
  tour ou dans un champ texte du bloc `escadrille:state`. Quatre au plus par tour, chaque action une fois, dans
  l'ordre écrit. Rien d'autre n'est lu. Un plan sans projet, ou un projet sans réglage : une ligne le dit
  (« environnement non réglé pour <projet> : le développeur le déclare dans Accès › Réglages »).
- **L'exécution** : l'argv déclaré, dans `cwd`, avec l'environnement du serveur sans ses secrets (`safeEnv`) plus
  `env` ; pas de shell ; une commande à la fois **par projet** (deux sessions qui demandent `up` se suivent).
  Après `up` (code 0), les adresses `health` sont attendues ; `status` les sonde une fois (3 s chacune) et dit
  « tourne » ou « ne tourne pas ».
- **Le retour** : un message system dans la page, repris en tête du prochain message envoyé à la session, comme les
  captures : une ligne de verdict puis les **40 dernières lignes** de sortie (stdout et stderr, sans couleurs,
  300 caractères par ligne), les mots de passe et les valeurs secrètes remplacés par `•••`.

```
[système] ENV status : tourne · localhost:8080 ok (200, 0 s), localhost:3050 ok (200, 0 s), 192.168.1.x:8081 ok (200, 1 s) · comptes de test : prof, eleve
  │ NAME       IMAGE      STATUS
  │ api        node:22    Up 2 minutes
[système] ENV up : prêt · localhost:8080 ok (200, 12 s), … · comptes de test : prof, eleve
  │ Container orchard-dev-api-1  Started
[système] ENV reset : remis à neuf · comptes de test : prof, eleve
[système] ENV up : démarré mais incomplet · localhost:3050 injoignable (délai) …
[système] ENV up : environnement non réglé pour Orchard-v2 : le développeur le déclare dans Accès › Réglages (docs/devenv.md)
```

- **La reprise** : même contrat que les captures (`docs/capture.md`). Quand la file est vide et que le tour est fini
  (session en attente, processus vivant, personne n'a écrit entre-temps, aucun arrêt du plan franchi, aucune question
  au développeur), le serveur envoie lui-même les lignes suivies de « L'environnement a répondu : reprends. » Sinon
  elles restent en tête du prochain message. Captures et ENV se partagent cette reprise : elle part quand les deux
  files sont vides.
- **La consigne** : la phrase sur `ENV:` est dans l'instruction state de chaque session (`stateInstruction`,
  `server.mjs`), après « N'appelle aucune API d'Escadrille ».

## Ce qui tourne

Un `up` qui réussit inscrit l'environnement dans « Sur ce Mac » (`GET /api/running`, `kind: 'devenv'`, le projet,
la première adresse de santé, la session qui l'a demandé). `Arrêter` exécute la commande `down` déclarée
(`POST /api/running/stop { kind: 'devenv', project }`) ; « Tout arrêter » aussi. Un `down` qui réussit le retire.
Le registre est en mémoire (`lib/running.mjs`, `markDevEnv`) : un serveur redémarré ne liste plus un Docker qu'il
avait lancé, `ENV: status` le dit et le prochain `up` le réinscrit. calmdev ne tue jamais Docker : il ne lance
que la commande déclarée.

## Les tests d'un dépôt, hors du bac à sable (Dev, 2 novembre)

calmdev lançait déjà sa propre suite dans une boîte avant une fusion (`lib/testbox.mjs`, `docs/autonomy.md`).
`environment.tests` l'étend à tout projet : **une commande de tests par dépôt**, lancée par le serveur à la fin
d'une session (`done`), avant la fusion, **avec les lectures que le bac à sable de la session n'avait pas**.

Le cas : `@orchard/analytics-client` est une dépendance `file:../Orchard-analytics/packages/analytics-client`
de l'app prof et de l'app élève. Une session d'Orchard travaille dans un worktree sous `Orchard-teacher/.claude/worktrees/`,
sans `node_modules` ni `../Orchard-analytics` à côté : ses tests ne passaient qu'avec un bouchon, et le 2 novembre le
pilote les a lancés à la main pour EVALPROF et ORDRE.

```json
"tests": {
  "Orchard-teacher": { "command": "npm test", "reads": ["Orchard-teacher/node_modules", "Orchard-analytics"] }
}
```

- **La clé** est le chemin du dépôt relatif au projet (`.` pour un projet d'un seul dépôt). La session dont le
  worktree vient de ce dépôt (`worktree.root`) reçoit ces tests ; un dépôt sans entrée garde l'ancien chemin
  (`autonomy.testCommand`, ou la suite de calmdev pour lui-même).
- **`reads`** (relatifs au projet ou absolus) : ce que la commande doit lire. Un chemin **dans le dépôt**
  (`node_modules`) est lié dans le worktree de vérification au même endroit, en écriture (c'est un cache : vitest y
  écrit) ; un chemin **hors du dépôt** apparaît à côté du worktree sous le même chemin relatif (`../Orchard-analytics`),
  en lecture. Les liens sont des liens symboliques vers le checkout principal ; `npm install` n'a pas lieu (pas de
  réseau dans la boîte) : les `node_modules` du checkout principal doivent être à jour.
- **Où** : un worktree jetable à deux niveaux sous un dossier temporaire (`escadrille-verify-*/a/b/<dépôt>`), la
  branche fusionnée à blanc sur le HEAD du dépôt ; la commande tourne dans la boîte des tests (Seatbelt : pas de
  réseau sauf localhost, écriture tenue au worktree, aux liens et au `.git` commun, clés et `.env` illisibles).
  Un chemin de `reads` introuvable est dit dans le message et ignoré.
- **Le résultat** : « Tests de la branche fusionnée à blanc… (tests déclarés pour <dépôt>) » puis « Tests : code N »
  et la fin de la sortie, dans le fil de la session ; `worktree.tests = { cmd, code, at, failed, flaky, head }` sur sa
  ligne d'état, que la **carte** montre (« · tests verts » ou « · tests rouges (code N) »). Rouge : la session reçoit
  les échecs et reprend une fois (`tellRed`), la deuxième fois le développeur est prévenu. Vert : la fusion reste le
  clic du développeur (ou la fusion auto si le plan la demande) ; pour un kit, la release du pilote.

## Ce qui est sûr, et pourquoi

1. Le serveur n'exécute que l'argv du réglage, écrit par le développeur avec son cookie ; le texte d'une session ne
   choisit que l'action parmi quatre.
2. Pas de shell : ni substitution, ni enchaînement ; une commande tue son groupe à la fin du délai.
3. Les comptes vivent hors de la base et hors du dépôt, dans un dossier que le bac à sable ne lit pas ; ils ne
   reviennent jamais à une session, et la page ne montre jamais un mot de passe.
4. La sortie rendue à la session est masquée des mots de passe et des valeurs secrètes de `env`.
5. Les adresses de santé ne peuvent viser que la machine ou un hôte LAN déclaré ; rien ne sort du Mac.
6. Les tests déclarés tournent dans la boîte des tests, jamais nus ; le `.git` commun garde ses hooks, sa config et
   ses refs en lecture seule ; main ne bouge pas.

## Les tests

`test/devenv.test.mjs`, sans Docker : les commandes sont des `node -e`. Le réglage validé (argv, hôtes, comptes à
part, tests par dépôt), les lignes `ENV:`, une commande et ses 40 lignes, le délai qui tue, un argument de shell qui
arrive tel quel, les adresses sondées, les secrets masqués, la file par projet ; contre le serveur et le faux claude :
le 403 sans cookie, le mot de passe absent de tout JSON et présent dans le fichier des secrets, un projet non réglé
répondu en une ligne, `status` et `up` exécutés et la session reprise seule, « Sur ce Mac » et son Arrêter, les tests
déclarés lancés à `done` avec un `node_modules` lié et un dépôt voisin, la carte qui le sait.

## Pour Orchard

Le réglage prêt à coller est dans `.escadrille/devenv-orchard.json` du worktree de la session ENV (jamais commité).
`./dev.sh` écrit `.env` (LAN_IP et les identifiants MySQL lus des `.env` des dépôts) avant `docker compose up` : ce
`.env` doit exister, donc `./dev.sh` avoir tourné une fois à la main. `reset` rejoue le seed dans le conteneur `api`
(`npm run seed -- --replace`, mot de passe de tous les comptes : `password`).

## Plus tard

- Un `ENV:` du pilote (`escadrille:pilot`, `do: "env"`) : le format est prêt, le pilote n'y est pas raccordé.
- Le registre « ce qui tourne » survit au redémarrage du serveur quand `status` dit que ça tourne.
- Les écrans (Environnement, carte QA) sont à la session UI ; le QA runner (session QR) lit `accounts` et `lanHosts`
  par `environmentOf` et `envAccountsOf` du serveur, jamais par une route.
