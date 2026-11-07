# Docker : les services du compose d'un projet

Phase 16, session DOCK. Le besoin (Dev, 2 novembre 05:20) : « l'application Docker sur Mac est un enfer ». calmdev lit
les services du `docker-compose` d'un projet, montre leurs logs en direct, et les redémarre, arrête ou reconstruit au
clic du développeur. Une session obtient l'état, les logs, un redémarrage ou une commande dans un service **par une
ligne `DOCKER:`**, sur le modèle de `ENV:` (`docs/devenv.md`) : le serveur exécute, hors du bac à sable, un geste
choisi parmi une liste fermée ; le texte de la session ne fournit que le nom du service (et, pour `exec`, les mots de
la commande, passés sans shell).

**Jamais le socket Docker dans le bac à sable** : il vaut un accès administrateur au Mac. **calmdev ne tue jamais
Docker** (ni Docker Desktop, ni le démon). **Ni la base ni les volumes ne sont supprimés sans le développeur** : aucun
`down -v`, aucun `volume rm`, aucun `prune`, aucun `rm` ; ces mots n'existent pas dans le module (`lib/docker.mjs`),
un test le vérifie.

## Ce qui est permis, à qui

| Geste | Dev (page, cookie `escadrille_guard`) | Une session (ligne `DOCKER:`) | Commande exécutée (argv, sans shell, dans `environment.cwd`) |
| --- | --- | --- | --- |
| état des services | oui | `DOCKER: status` | `docker compose ps --all --format json` |
| logs | en direct (SSE) : 200 lignes puis le flux | `DOCKER: logs <service>` : les 60 dernières | `docker compose logs --no-color --timestamps --tail 200 --follow <service>` / `--tail 60` |
| redémarrer | oui | `DOCKER: restart <service>` | `docker compose restart <service>` |
| arrêter | oui | **non** | `docker compose stop <service>` |
| reconstruire | oui | **non** | `docker compose up -d --build --no-deps <service>` |
| commande dans un service | **non** (le terminal reste à Dev) | `DOCKER: exec <service> <mots…>`, seulement pour un service de `environment.docker.exec` | `docker compose exec -T <service> <mots…>` |

- **Un service** est un nom rendu par `docker compose config --services` dans le dossier du projet, rien d'autre :
  un nom inconnu, un nom qui commence par `-`, un caractère hors `[A-Za-z0-9._-]` sont refusés avant toute commande.
- **`exec`** : le service doit être déclaré par Dev dans le réglage (`"docker": { "exec": ["api"] }`) ; les mots
  suivent le nom, séparés par des espaces, sans guillemets ni shell (`$(…)`, `;`, `|` arrivent tels quels au
  programme du conteneur) ; le premier ne commence pas par `-` (pas d'option glissée à `docker compose`) ; 60 s au plus.
- **Une commande à la fois par projet** : les gestes de Dev et des sessions passent par la même file ; les logs en
  direct n'y entrent pas (un flux par onglet ouvert, tué à la fermeture).
- **Délais** : `status` 20 s, `logs` 20 s, `restart` et `stop` 90 s, `build` 15 min, `exec` 60 s ; au-delà, le
  groupe de processus de la commande `docker` est tué (jamais Docker lui-même).
- **Le binaire** : `docker` sur le PATH du serveur, ou `ESCADRILLE_DOCKER` (chemin absolu ; un `.mjs` tourne sous le node du serveur) ; les tests y mettent
  `test/fake-docker.mjs`.

## Ce qui est refusé, et la phrase rendue

| Cas | Réponse |
| --- | --- |
| `docker` introuvable | « Docker n'est pas installé sur ce Mac (commande docker introuvable). » |
| démon arrêté (`Cannot connect to the Docker daemon`, `Is the docker daemon running`) | « Docker ne tourne pas : lance Docker Desktop. calmdev ne le démarre ni ne l'arrête. » |
| projet sans réglage `environment` | la ligne de `ENV:` : « environnement non réglé pour <projet> … » |
| dossier sans compose (`no configuration file provided`) | « Aucun docker-compose dans <dossier>. » |
| service hors du compose | « <nom> n'est pas un service du compose (api, web, mysql…). » |
| verbe inconnu, ou `stop`, `build`, `down`, `rm`, `prune` par une session | « DOCKER : verbe refusé (status, logs, restart, exec). » |
| `exec` sur un service non déclaré | « exec refusé : <service> n'est pas déclaré exec-permis (Accès › Réglages › environment.docker.exec). » |
| route de Dev sans le cookie | 403, comme le réglage `environment` |

## La ligne `DOCKER:`

- **La demande**, seule sur sa ligne, dans le texte du tour ou un champ texte du bloc `escadrille:state` :
  `DOCKER: status`, `DOCKER: logs api`, `DOCKER: restart api`, `DOCKER: exec api npm run seed -- --replace`. Quatre au
  plus par tour, chaque ligne une fois, dans l'ordre écrit.
- **Le retour**, en tête du message suivant comme `ENV:` et les captures, et la reprise seule quand toutes les files
  sont vides : une ligne de verdict puis **60 lignes au plus**, sans couleurs, 300 caractères par ligne, masquées
  (mots de passe des comptes de test, valeurs secrètes de `env`, `NOM_SECRET=valeur`, `Bearer …`, identifiants dans
  une URL → `•••`).

```
[système] DOCKER status : 5 services · api en marche (sain) :3050, web en marche :8080, mysql en marche (sain), redis en marche, student arrêté
[système] DOCKER logs api : 60 dernières lignes
  │ 2026-11-02T10:12:03Z api  | listening on :3050
[système] DOCKER restart api : redémarré (code 0)
[système] DOCKER exec api : code 0
  │ seeded 42 users
[système] DOCKER : Docker ne tourne pas : lance Docker Desktop. calmdev ne le démarre ni ne l'arrête.
```

## Les routes de Dev (cookie `escadrille_guard` exigé, 403 sinon)

- `GET /api/docker?project=` → `{ services: [{ service, container, state, health, status, ports: [{ host, container, protocol }] }], error? }`
- `GET /api/docker/logs?project=&service=` → `text/event-stream` : les 200 dernières lignes puis le flux, un événement
  `data:` par ligne (masquée), `event: end` quand la commande s'arrête ; fermer l'onglet tue la commande.
- `POST /api/docker/action { project, service, action: "restart" | "stop" | "build" }` → `{ ok, code, lines, error? }`.

Le panneau (session RES, vague 3) lit ces trois routes ; il n'en appelle aucune autre.

## Le journal

Chaque geste, de Dev ou d'une session, va au journal du pilote (`docs/pilotlog.md`, type `note`) : « Docker restart
api (développeur) : ok », « Docker exec api `npm run seed` (session A) : ok ». Les logs ouverts par Dev ne sont pas
notés (lecture), les `DOCKER: logs` d'une session si.

## Le réglage

Dans `environment` (`docs/devenv.md`), une clé `docker` facultative :

```json
"docker": { "exec": ["api"], "files": ["docker-compose.yml"] }
```

- `exec` : les services où une session peut lancer une commande (vide par défaut : aucun).
- `files` : les fichiers compose passés en `-f`, relatifs à `cwd` (par défaut, ceux que `docker compose` trouve seul).

Validée par `validateDocker` de `lib/docker.mjs` ; `lib/devenv.mjs` n'est pas modifié.

## Le câblage dans le serveur

`lib/docker.mjs` porte tout : la lecture du compose, les gestes, la file, la ligne `DOCKER:`, le masquage, les
routes (`createDocker({ environmentOf, accountsOf, guardOk, record, onNote })` → `{ handle(req, res, url), ofTurn(…) }`).
Le serveur n'a que cinq points branchés : l'import, `handle` dans le routeur (avant les autres routes du Mac),
`ofTurn` à côté de `envOfTurn`, la phrase `INSTRUCTION` dans la consigne des sessions, et la clé `docker` validée au
réglage. La reprise d'une session attend que les captures, `ENV:`, la QA et `DOCKER:` aient toutes répondu
(`sideBusy`). **`server.mjs` est un garde-fou protégé** : ces lignes ont été écrites avec l'accord de Dev (soir du
2 novembre), la fusion passe par sa revue « Garde-fou touché ».

## Les tests

`test/docker.test.mjs`, sans Docker : `ESCADRILLE_DOCKER=test/fake-docker.mjs`, un faux qui joue un compose de cinq
services (sortie `ps` en JSON ligne par ligne ou en tableau, selon la version), `logs --follow`, `restart`, `stop`,
`build`, `exec`, et les pannes (binaire absent, démon arrêté, pas de compose). Vérifiés : le parsing de `ps`, un
service hors compose refusé avant toute commande, les verbes fermés d'une session, `exec` refusé sans déclaration,
le flux SSE (200 lignes puis la suite, tué à la fermeture), la file par projet, le masquage, les deux phrases de
panne, le 403 sans cookie, une ligne au journal par geste, et l'absence de `-v`, `rm`, `prune`, `kill` dans tout argv.
Contre le vrai serveur et le faux claude : le réglage `docker` gardé (refusé s'il est mal formé), les routes à 403
sans cookie, un clic au journal, une session dont les quatre lignes `DOCKER:` reçoivent leur réponse (status, exec
permis, exec refusé, `stop` refusé) et qui reprend seule, la phrase présente dans sa consigne. Lancer :
`node --test test/docker.test.mjs` (11 tests).

Le premier usage, Orchard-v2 : à ajouter dans son `environment` collé dans Accès › Réglages,
`"docker": { "exec": ["api"] }` (le seed passe alors par `DOCKER: exec api npm run seed -- --replace`). Les noms de
services de ce document sont des exemples : le compose réel n'était pas lisible depuis le bac de la session.
