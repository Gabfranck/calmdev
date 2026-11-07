# Les accès

La vue « Accès » (`/#acces`, entrée de la barre latérale à côté de « Mémoire ») dit en une page à quoi Escadrille
et ses sessions ont accès. Elle répond à la demande de Dev du 1er novembre (06:50, `docs/decisions.md`) : savoir
vite à quoi l'outil est connecté. Tout y est **calculé au moment de la demande**, lu dans le code (`lib/planner.mjs`)
et dans les réglages ; aucun texte n'est figé.

Captures : `docs/phase6-acces.jpg` (1440), `docs/phase6-acces-390.jpg` (390), `docs/phase6-acces-ouvert.jpg`
(la ligne Sessions ouverte). Elles montrent une base de démonstration (un plan en cours qui ouvre
`registry.npmjs.org`, trois commandes demandées hors bac à sable) ; les plugins et le serveur MCP sont ceux du Mac.

## Le contrat : `GET /api/access?project=`

Réservé au Mac, comme toute route sans jeton d'appareil (`docs/phone.md`). Sans `project`, les réglages du projet
et ses fichiers `.claude/` ne sont pas lus.

| Bloc | Ce qu'il dit | D'où |
| --- | --- | --- |
| `server` | hôte et port d'écoute, LAN ouvert ou non (et l'adresse), appareils appairés (nom, date), service push, nombre de jetons d'appareil stockés, `key: false` (aucune clé d'accès Expo) | `server.address()`, table `devices` |
| `sessions.sandbox` | bac à sable actif, refus de démarrer sans lui, écriture tenue au worktree, ports locaux | `SANDBOX_SETTINGS` |
| `sessions.unreadable` | `denyRead` du bac à sable et règles `Read(...)` de `permissions.deny`, et leur total | `SANDBOX_SETTINGS` |
| `sessions.env` | le motif des variables retirées, celui des gardées, et les **noms** retirés de l'environnement du serveur (jamais les valeurs) | `SECRET_NAME`, `KEEP_ENV` |
| `sessions.tools` | les outils autorisés au planificateur et aux sessions | `READ_ONLY_TOOLS`, `SESSION_TOOLS` |
| `sessions.denied` | les règles `permissions.deny` de `~/.claude/settings.json` et de `.claude/settings.json`, `.claude/settings.local.json` du projet, avec leur fichier | les fichiers |
| `sessions.network` | `{ default, list, announced }` : `list`, la seule liste qui ouvre le réseau, `[{ host, scope }]` du projet ; `announced`, les plans en cours qui annoncent des domaines, avec `missing`, ceux que la liste n'ouvre pas aux sessions | `project_settings.network`, plans |
| `sessions.addDirs` | les dossiers ouverts par les plans en cours et par le réglage | idem |
| `sessions.outside` | `{ allowed, denied, pending, plans: [{ id, count }], list }` : les commandes demandées hors bac à sable aujourd'hui dans les plans en cours, avec leur réponse | `session_messages` (rôle `ask`, `data.input.dangerouslyDisableSandbox`) ; la réponse dans le message système qui suit (`data.answer`) |
| `sessions.devenv` | `{ set, commands, health, lanHosts, accounts, tests, envNames, outside }` : l'environnement de dev déclaré (`docs/devenv.md`), les **noms** des commandes, des comptes, des variables et des dépôts testés ; jamais une valeur ni un mot de passe | `project_settings.environment` ; les comptes de `~/.config/escadrille/secrets.json`, noms seulement |
| `extensions` | `connectors` : GitHub et Linear (`{ name, kind, scope, where, ready, key }`, `docs/connectors.md` ; `ready` de GitHub : `gh` trouvé sur le PATH sans le lancer ; `key` de Linear : une clé stockée pour ce projet, jamais la clé), les plugins (`enabledPlugins`, actifs ou non), les serveurs MCP (`~/.claude.json`, global et par projet, et `.mcp.json`) | les fichiers |
| `out` | la liste exacte des hôtes joignables : `exp.host` si un téléphone est appairé, les domaines de la liste du projet (avec qui y a accès), et `api.github.com`, `api.linear.app` marqués `onClick: true` (« sur clic seulement » : « Ouvrir la PR ») ; rien d'autre. Un hôte `onClick` ne rend pas la ligne ambre | ci-dessus, `lib/access.mjs` |
| `closed` | ce qui est fermé, en phrases courtes | ci-dessus |
| `summary.level` | `green`, `amber` ou `red` par bloc | ci-dessus |

Un **plan en cours** a une session `running` ou `waiting` : ses dossiers sont ouverts, ses domaines seulement annoncés.

## Domaines

Une seule liste par projet (6 novembre), le réglage `network` : `[{ host, scope }]`, `scope` valant `plan` (la
session de planification), `sessions` (les sessions qui codent) ou `both`. Le bac à sable d'une session ouvre les
hôtes `sessions` et `both`, lus à chaque démarrage ; celui d'une planification les hôtes `plan` et `both`, avec
`WebFetch(domain:…)` pour les hôtes exacts (sans hôte `plan` ni `both`, la planification n'a aucun réseau, comme
avant). Une rafale reste sans réseau. `lib/policy.mjs` juge un hôte contre la liste du rôle, que le serveur lui passe.

- **Entrée** : une chaîne seule reste acceptée (API, téléphone) et prend le scope par défaut : un registre de paquets
  (`registry.npmjs.org`, `*.npmjs.org`, `crates.io` et ses sous-domaines, `pypi.org`, `files.pythonhosted.org`,
  `rubygems.org`, `proxy.golang.org`) va à `sessions`, tout le reste à `both`. Les règles de nom d'hôte de
  `validateDomains` tiennent, plus IPv4, `localhost` et un port.
- **Le `network` d'un plan** n'ouvre plus rien : c'est une annonce (« ce plan utilisera crates.io »), dite sur la
  carte du plan proposé ; un hôte annoncé absent de la liste y est dit en une ligne avec « Autoriser pour le projet »
  (scope `sessions`, sans jamais réduire une ligne déjà là). Le même bouton sert dans « À toi » pour une demande réseau.
- **L'écran** : Accès › Domaines, une ligne par domaine (l'hôte, Planification · Sessions · Les deux, Retirer) et un
  champ pour en ajouter ; Réglages et la ligne « Garde » de l'accueil lisent la même liste.
- **L'API** : `POST /api/project/domain { project, host, scope? | remove: true, keep? }` ; `POST /api/project/settings
  { network }` remplace la liste entière.
- **La migration** : au démarrage, une fois par projet (`networkScoped`), la liste devient le réglage ∪ le `network`
  des plans non retirés, chaque hôte avec son scope par défaut ; une ligne au journal par projet migré.
- **Le pilote** n'ouvre jamais le réseau (`lib/pilot.mjs`, `lib/pilotpolicy.mjs`) : une demande hors liste va à Dev.

**Aucun secret ne sort.** D'un serveur MCP, la réponse ne garde que le nom, le type, le nom du programme ou l'hôte
de l'URL, et `secret: true` s'il porte `env`, `headers` ou un argument qui ressemble à une clé. Des variables
d'environnement, seulement les noms. `test/access.test.mjs` vérifie qu'aucune valeur ne revient (un test par bloc).

## La page

Cinq lignes repliées : Serveur, Sessions, Connecteurs, Ce qui sort, Ce qui est fermé. Chacune dit son résumé en une
ligne, porte une pastille et s'ouvre sur le détail. Sous le titre, un constat lu en premier : les commandes hors bac
à sable, sinon les hôtes joignables, sinon les extensions chargées, sinon « Rien ne sort ». La couleur ne va que sur
la donnée : ambre pour un domaine ouvert, une commande hors bac à sable, un plugin ou un MCP chargé, le LAN ouvert ;
rouge pour un bac à sable inactif. **Aucun bouton** : la page lit, elle ne règle rien (les réglages restent dans leur
page). `#acces-sessions` (ou `-server`, `-extensions`, `-out`, `-closed`) ouvre la ligne voulue.

Tout connecteur se déclare dans `extensions.connectors` avant d'exister ; GitHub et Linear y sont depuis la phase 7
(`docs/connectors.md`). Le dossier de leurs clés, `~/.config/escadrille`, est dans le `denyRead` du bac à sable.

## Ce qui s'exécute hors du bac à sable, et pourquoi c'est sûr

Trois choses tournent hors du bac à sable d'une session, toutes dans le serveur, aucune écrite par une session :

| Quoi | Déclenché par | Ce qui tourne | Pourquoi c'est sûr |
| --- | --- | --- | --- |
| **La capture** (`docs/capture.md`) | une ligne `CAPTURE: <cible>` d'une session | chrome-headless-shell sur une adresse locale ou un `.html` du worktree | pas de shell, aucune requête hors machine (bloquée et comptée), profil jeté, 30 s |
| **L'environnement de dev** (`docs/devenv.md`) | une ligne `ENV: up/down/reset/status` d'une session, ou « Arrêter » sur « Ce qui tourne » | l'argv que le développeur a déclaré dans le réglage `environment`, écrit avec son cookie `escadrille_guard` | la session ne choisit qu'une action parmi quatre, jamais un mot de la commande ; pas de shell ; délai et groupe tué ; secrets masqués dans la sortie ; comptes hors base, noms seuls vers la session ; santé sur la machine ou un hôte LAN déclaré |
| **Les tests d'un dépôt** (`docs/devenv.md`, `lib/testbox.mjs`) | la fin d'une session (`done`), avant la fusion | `environment.tests.<dépôt>.command` sur la branche fusionnée à blanc, avec les lectures déclarées (`node_modules` du checkout, un dépôt voisin) | dans la boîte des tests (Seatbelt : réseau fermé sauf localhost, écriture tenue au worktree jetable, `.git` commun en lecture seule, clés et `.env` illisibles) ; main ne bouge pas ; rouge, la session corrige |

La ligne Sessions de la page dit « environnement de dev à régler » tant que le réglage manque, et son détail montre les
noms déclarés. « Ce qui est fermé » rappelle que le texte d'une session n'est jamais une commande.

## Les limites

- **Les serveurs MCP internes aux plugins** ne sont pas lus : un plugin actif apparaît, pas les serveurs MCP que son
  propre manifeste déclare. Les lire demanderait de parcourir `~/.claude/plugins/`, dont la forme n'est pas un contrat.
- **Le bac à sable d'une session** ne lit ni `~/.claude.json` ni `~/.claude/settings.json` : un serveur lancé par une
  session y voit des listes vides (la session H l'a vu en écrivant cette vue). Le serveur de Dev (`./run.sh`) tourne
  hors bac à sable et lit les vrais fichiers ; les captures viennent d'un serveur lancé ainsi.
- Les réponses données avant cette version n'ont pas `data.answer` : elles sont retrouvées par le texte du message
  système (« Autorisé : … », « Refusé : … »).
- Les demandes comptées sont celles d'aujourd'hui (heure du Mac), dans les plans en cours seulement.
- Le téléphone n'a pas encore cette liste ; elle viendra dans l'app, en lecture (après la session E).
