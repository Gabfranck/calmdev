# La porte du serveur : ce qu'une session ne peut pas lui faire faire (phase 12, session SEC)

Une session joint le serveur sur `127.0.0.1` depuis son bac à sable (localhost est permis, il lui faut `POST
/api/memory`). Depuis le 2 novembre, seule l'approbation d'un garde-fou touché demandait le cookie du navigateur de
Dev ; tout le reste (lancer, fusionner, régler, seuils, rafale, pilote) restait joignable. Cette page tient la porte
unique qui ferme ces routes, la table complète des routes avec leur classe, et le passage du pilote. Tenu par
`test/gate.test.mjs` ; le code dans `lib/gate.mjs` (la table, le prédicat) et `server.mjs` (la porte, avant l'aiguillage).

## La conception, en dix lignes

1. **Une seule porte**, placée juste après la garde du LAN (`docs/phone.md`) et avant la première route : `gate.classify(method,
   pathname)` rend la ligne de la table (classe, ce qui ouvre, le geste) ; rien n'est ajouté dans les gestionnaires.
2. **Trois classes** : `agit` (une écriture qui engage le Mac ou l'argent de Dev), `lit` (GET, SSE, pages), `session` (ce
   qu'une session appelle légitimement). Deux classes techniques à côté : `ouvert` (l'appairage, CORS) et `appareil`
   (`/api/phone/*`, qui vérifie son jeton lui-même). Une route qui semble des deux côtés est `agit`.
3. **Ce qui ouvre une route `agit`** : le cookie de garde `escadrille_guard` (posé une fois par `GET /guard?k=…`, le lien de
   `~/.config/escadrille/guard-link`, que le bac des sessions ne lit pas), **ou** un appareil appairé (`Authorization: Bearer`
   du téléphone, cookie `escadrille_poste` du poste, chacun dans les limites que la garde du LAN lui donne déjà), **ou** le
   jeton du pilote (en-tête `x-escadrille-pilot`, plus bas). Rien d'autre : pas d'adresse, pas de réglage, pas de corps.
4. **Sans rien** : `403`, corps JSON `{ error, gate: { route, opens } }`, `error` en français qui nomme le geste
   (« Lancer une session se fait depuis ton navigateur (cookie de garde), un appareil appairé ou le pilote : jamais depuis
   une session (docs/gate.md). »). Sur `…/reviewed`, `error` reste le message `srv.s.guardKey` (le cookie seul approuve un
   garde-fou : ni appareil, ni pilote) et `opens` vaut `['cookie']`.
5. **Les routes `session`** passent sans rien. Aujourd'hui une seule : `POST /api/memory` (une ligne de mémoire du projet).
   Elle ne porte pas d'identifiant de session. La règle pour une future route `session` qui en porterait un : elle n'écrit
   que pour la session qui l'appelle, prouvée par un secret propre à cette session que le serveur lui donne dans sa consigne
   (jamais par l'identifiant seul, qu'une autre session connaît). Le test refuse toute ligne `session` dont le chemin porte
   `:sid` sans cette règle écrite dans la table (`scoped`) : ajouter une telle route force la conception.
6. **Les routes `lit`** passent sans rien : elles ne changent rien (exception connue : `GET /api/review?…` enregistre la revue
   qu'il ouvre, sans effet sur une session ; elle reste `lit`).
7. **Une route non classée** : un `GET` est `lit` ; tout autre verbe est refusé comme `agit` (refus par défaut) et
   `test/gate.test.mjs` échoue tant qu'elle n'est pas dans la table (il relit les routes de `server.mjs`).
8. **Les tests** : la porte se décide au démarrage du serveur, jamais après. `ESCADRILLE_GATE=off` l'ouvre à tout appel local
   (un serveur de test : `test/isolated-env.mjs` le pose ; un serveur lancé sous `node --test` sans `ESCADRILLE_GATE=on`
   l'hérite de `NODE_TEST_CONTEXT`, comme la clé de garde en mémoire). `run.sh` ne le pose jamais ; le serveur l'écrit sur sa
   ligne de démarrage. Les vérifications des gestionnaires (le cookie sur `…/reviewed`, `environment`, `/api/team`) restent.
9. **Le pilote** : un jeton, `ESCADRILLE_PILOT_TOKEN` dans l'environnement du serveur, sinon `~/.config/escadrille/pilot-token`
   (0600, écrit par le serveur à côté de `guard-key`). Il arrive au pilote par son shell, jamais par un fichier que son bac ou
   celui des sessions lirait ; les sessions reçoivent `safeEnv` (`lib/planner.mjs`), qui retire tout `*TOKEN*`.
10. **Hors sujet, inchangé** : la garde du LAN (401 sans jeton, liste blanche du téléphone, `studioOnly` du poste), l'`Origin`
    du poste, l'en-tête `Host`, les pages. Rien de nouveau à l'écran.

## La table des routes

C : le cookie de garde. A : un appareil appairé (dans ce que la garde du LAN lui laisse déjà : le téléphone n'a que
`answer`, `message`, `dismiss` ; le poste tout sauf `studioOnly`). P : le jeton du pilote. La colonne « geste » est la clé
`srv.gate.g.<geste>` du message de refus.

### `agit` (403 sans C, A ou P)

| Route | Ouvre | Geste |
|---|---|---|
| `POST /api/launch` | C A P | launch |
| `POST /api/plan` | C A P | plan |
| `POST /api/plan/:id/formula` | C A P | plan |
| `POST /api/plan/:id/settings` | C A P | settings |
| `POST /api/plan/:id/story` | C A P | plan |
| `POST /api/plan/:id/retire` | C A P | stop |
| `POST /api/plan/:id/reopen` | C A P | stop |
| `POST /api/plan/:id/session/:sid/message` | C A P | answer |
| `POST /api/plan/:id/session/:sid/now` | C A P | answer |
| `POST /api/plan/:id/session/:sid/answer` | C A P | answer |
| `POST /api/plan/:id/session/:sid/dismiss` | C A P | answer |
| `POST /api/plan/:id/session/:sid/budget` | C A P | settings |
| `POST /api/plan/:id/session/:sid/merge` | C A P | merge |
| `POST /api/plan/:id/session/:sid/terminal` | C P | stop |
| `POST /api/plan/:id/session/:sid/resume` | C A P | launch |
| `POST /api/plan/:id/session/:sid/stop` | C A P | stop |
| `POST /api/plan/:id/session/:sid/open` | C P | stop |
| `POST /api/plan/:id/session/:sid/devserver` | C P | launch |
| `POST /api/plan/:id/session/:sid/reviewed` | C | review (message `srv.s.guardKey`) |
| `POST /api/plan/:id/session/:sid/run-tests` | C A P | merge |
| `POST /api/plan/:id/session/:sid/continue-budget` | C A P | settings |
| `POST /api/plan/:id/session/:sid/pr` | C | push (message `srv.gate.push` : « le push part du bouton dans l'app, sur le Mac ») |
| `POST /api/costing`, `POST /api/costing/launch` | C A P | launch |
| `POST /api/escadrille` | C A P | plan |
| `POST /api/escadrille/:id/message`, `…/install`, `…/stop` | C A P | plan |
| `POST /api/running/stop`, `POST /api/running/stop-all` | C A P | stop |
| `POST /api/limits`, `POST /api/limits/resume` | C A P | limits |
| `POST /api/burst`, `POST /api/burst/:id/stop` | C A P | burst |
| `POST /api/project/backlog` | C A P | burst |
| `POST /api/project/settings` | C A P | settings (`environment` : C seul, dans le gestionnaire) |
| `POST /api/project/domain` | C A P | settings (une ligne de la liste des domaines du projet, `docs/access.md` « Domaines ») |
| `POST /api/learning/preferences` | C A P | settings |
| `POST /api/team`, `POST /api/team/sync` | C A P | settings (`/api/team` : C seul, dans le gestionnaire) |
| `POST /api/resources/file`, `…/note`, `…/skill`, `…/plugin` ; `DELETE /api/resources/file` | C A P | resources |
| `POST /api/projects`, `POST /api/projects/remove` | C A P | projects |
| `POST /api/pilot`, `POST /api/pilot/log` | C A P | pilot |
| `POST /api/main`, `…/accept`, `…/now`, `…/import` | C A P | main |
| `POST /api/review/:id/comment`, `…/comment/:cid/resolve`, `…/viewed`, `…/submit`, `…/decide` | C A P | review |
| `POST /api/note` | C A P | note |
| `POST /api/docker/action` | C | stop (lib/docker.mjs exige le cookie sur toutes ses routes, lectures comprises, docs/docker.md) |
| `POST /api/plan/from-tickets` | C A P | plan (avant la lecture `* /api/plan/:id`) |
| `POST /api/demo` | C A P | launch (la démo lance une session et sert son `public/` par-dessus le nôtre, docs/demo.md) |
| `POST /api/demo/remove` | C A P | stop |
| `POST /api/github/pr/:n/merge` | C | merge (une fusion sur GitHub ne part que du clic de Dev : ni appareil, ni pilote) |
| `POST /api/replies/:id/send`, `…/pasted`, `…/published` | C | answer (rien ne sort sans le clic de Dev, docs/replies.md) |
| `POST /api/replies/:id/edit`, `…/later` | C A P | answer |
| `POST /api/replies/:id/draft` | C P | launch (un brouillon Sonnet, 0,10 $ au plus) |
| `POST /api/review/thread` | C A P | answer (le cookie reste exigé pour un message de Dev ou de GitHub, docs/review.md) |
| `POST /api/pair/code` | C P | devices |
| `POST /api/devices/:id/forget` | C P | devices |

Pourquoi `…/session/:sid/pr` est C seul (5 novembre 2026) : c'est le seul `git push` du serveur (`sessionPr` →
`lib/github.mjs` `pushBranch`), et « rien n'est poussé sans toi » doit tenir face à qui lit le code. Un appareil appairé
ou le pilote reçoivent un 403 qui dit le chemin qui marche : le bouton dans l'app, sur le Mac. L'app du téléphone
(`phone/`) n'appelle pas cette route ; sur un poste (docs/studio.md), `public/remote.js` cache « Ouvrir la PR » et met à
sa place la ligne « à faire sur le Mac » : aucun bouton n'échoue.

Pourquoi `pair/code` est `agit` : une session qui l'appelle puis `POST /api/pair` s'appairerait elle-même et ouvrirait tout.

### `session` (passe sans rien)

| Route | Borne |
|---|---|
| `POST /api/memory` | une ligne datée au bout de la mémoire du projet ; pas d'identifiant de session |

### `lit` (passe sans rien)

Tout `GET` : `/api/projects`, `/suggestions`, `/dirs`, `/logo`, `/api/models`, `/api/project`, `/api/escadrilles`,
`/api/escadrille/:id`, `/api/project/horizon`, `/api/limits`, `/api/status`, `/api/project/backlog`, `/api/bursts`,
`/api/burst/:id`, `/api/project/settings`, `/api/architecture`, `/delta`, `/api/game`, `/api/asks`, `/api/access`,
`/api/projectflow`, `/api/pilot`, `/api/pilot/log`, `/api/main`, `/pending`, `/transcripts`, `/api/memory`, `/api/team`,
`/api/resources`, `/capabilities`, `/skill`, `/api/templates`, `/api/review`, `/api/reviews`, `/api/qa`, `/api/review/:id`,
`/file`, `/blob`, `/raw`, `/api/plans`, `/api/plan/:id`, `…/session/:sid/messages`, `/pr`, `/diff`, `/api/running`,
`/api/learning`, `/api/usage`, `/api/export/:id`, `/api/events` (SSE), `/api/devices`, `/api/whoami`, `/guard` (avec sa
clé), `/docs/*.md`, `/qa/:plan`, `/site/*`, les pages de `public/`.

### `ouvert` et `appareil`

`OPTIONS *`, `GET /pair`, `POST /api/pair` (le code à six chiffres fait la preuve) ; `GET /api/phone`, `POST
/api/phone/push-token`, `POST /api/phone/forget` (le jeton d'appareil, vérifié dans le gestionnaire).

## Le passage du pilote

Le pilote est une conversation Claude Code sur le Mac, dans un bac à sable qui, comme celui des sessions, ne lit pas
`~/.config/escadrille`. Ce qu'il a et qu'une session n'a pas : **l'environnement du shell de Dev**. Le serveur retire des
sessions toute variable dont le nom contient `TOKEN` (`safeEnv`) ; le pilote, lancé par Dev dans son terminal, la garde.

- Le serveur lit `ESCADRILLE_PILOT_TOKEN` ; sinon il lit ou crée `~/.config/escadrille/pilot-token` (64 hexadécimaux, 0600).
- La requête porte `x-escadrille-pilot: <jeton>`. Un jeton faux ou absent : 403 comme une session.
- **Le geste de Dev, une fois** : dans `~/.zshrc`,
  `export ESCADRILLE_PILOT_TOKEN="$(cat ~/.config/escadrille/pilot-token 2>/dev/null)"`, puis un nouveau terminal pour la
  conversation du pilote. Le serveur peut rester tel quel (il lit le fichier).
- **Dans les scripts de `.escadrille/pilote`** (jamais commités), un fichier commun `gate.sh` à sourcer :

```sh
# .escadrille/pilote/gate.sh : le jeton du pilote, jamais affiché (une session lit les transcriptions du pilote)
PILOT_TOKEN="${ESCADRILLE_PILOT_TOKEN:-$(cat "$HOME/.config/escadrille/pilot-token" 2>/dev/null)}"
if [ -z "$PILOT_TOKEN" ]; then
  echo "Jeton du pilote absent : export ESCADRILLE_PILOT_TOKEN dans ~/.zshrc, nouveau terminal (docs/gate.md)" >&2; exit 2
fi
PILOT_H="x-escadrille-pilot: $PILOT_TOKEN"
```

puis, dans chaque script qui appelle une route `agit` : `. "$(dirname "$0")/gate.sh"` et `-H "$PILOT_H"` sur chaque `curl`.
En Node (`budget.mjs`, `login.mjs`) : `headers: { 'x-escadrille-pilot': process.env.ESCADRILLE_PILOT_TOKEN || '' }`, et le
même message si la variable manque. Jamais `echo $PILOT_TOKEN`, jamais `env` : la transcription du pilote
(`~/.claude/projects/…`) est lisible par une session.

Un script lancé hors du bac (le geste « sans bac à sable » de Claude Code, accordé par Dev ou son mode auto) lit le fichier
lui-même : c'est le repli de la nuit, le temps que l'export soit fait.

## Ce que la porte ne couvre pas

- Un appareil appairé reste ce qu'il était : un téléphone volé répond aux sessions, un poste lance et fusionne (`docs/studio.md`).
- Le navigateur de Dev sans le cookie de garde (lien jamais ouvert) voit le message de refus sur chaque action : ouvrir
  `~/.config/escadrille/guard-link` une fois.
- `ESCADRILLE_GATE=off` sur le vrai serveur ouvrirait tout aux sessions : `run.sh` ne le pose jamais, la ligne de démarrage
  le dirait.
