# Le téléphone : le contrat du serveur (phase 5)

Ce que le serveur offre à l'app Expo (`phone/`, session B) et ce qu'il refuse au LAN. Écrit par la
session A avant de coder ; C l'a relu après la fusion (aucun écart côté serveur) et y a mis « La marche de 14 h ».
Tout ce qui est dit ici est tenu par `test/phone.test.mjs`.

## En une phrase

Sans jeton d'appareil valable, le serveur ne répond à aucune requête venue du LAN : 401 partout,
pages comprises. Le jeton s'obtient une fois, par un code à 6 chiffres affiché sur le Mac, et vaut
90 jours. Avec lui, le téléphone lit le plan, répond aux autorisations et aux arrêts, et reçoit des
notifications poussées par le serveur via le service push d'Expo. Tout ce qui lance, fusionne ou
arrête reste au Mac.

## La garde

- **Qui est « le Mac »** : `isLoopback(req)` (déjà là) : `127.0.0.1`, `::1`, ou l'une des adresses
  des interfaces du Mac (la page ouverte sur le nom LAN du Mac, depuis le Mac). Tout le reste est
  « le LAN ».
- **Le LAN sans jeton** → `401 { error: 'appairage requis' }`, pour toute route et tout fichier de
  `public/`. Deux exceptions : `POST /api/pair` et `OPTIONS` (CORS).
- **Le LAN avec jeton** : seules les routes du téléphone (ci-dessous) répondent ; toute autre route
  → `403 { error: 'depuis le Mac seulement' }`. C'est une liste blanche, pas une liste noire : launch,
  resume, stop, merge, terminal, open, devserver, settings, note, plan, running/*, escadrille/*,
  projects, usage, export et les pages statiques ne sont jamais servis au LAN.
- **Le jeton** : en-tête `Authorization: Bearer <jeton>`. Sur `/api/events` seulement,
  `?token=<jeton>` est accepté aussi (EventSource ne pose pas d'en-tête). Un jeton inconnu, révoqué
  ou expiré (90 jours après `created`) vaut absence de jeton : 401, l'app revient à l'appairage.
- **`SM_LAUNCH_LAN` disparaît** du code et des docs : la seule façon de piloter depuis le LAN est
  le jeton, et il ne pilote que ce que la liste blanche permet.
- **Dans les tests** : la variable `ESCADRILLE_TEST_REMOTE=1` (posée par le test, jamais par
  `run.sh`) fait que l'en-tête `x-escadrille-remote: 1` compte la requête comme venue du LAN. Sans
  cette variable l'en-tête est ignoré.

## CORS (l'app testée en web sur `localhost:8081`)

Si la requête porte un en-tête `Origin`, la réponse le renvoie tel quel dans
`access-control-allow-origin` (plus `vary: origin`), avec `access-control-allow-headers:
authorization, content-type` et `access-control-allow-methods: GET, POST`. `OPTIONS` répond 204
avec ces mêmes en-têtes, sans jeton. Sans `Origin`, `access-control-allow-origin: *` comme avant.

## L'appairage

### `POST /api/pair/code` (Mac seulement, 403 hors loopback)

→ `200 { code: '482913', expires: '2026-11-01T14:10:00.000Z', address: 'http://192.168.1.x:3078', lan: true }`

- Un code à 6 chiffres, tiré au hasard (`randomInt`), **vaut 10 minutes, usage unique** ; un nouveau
  code remplace le précédent. Il vit en mémoire du serveur (un redémarrage l'annule).
- `address` : la première adresse IPv4 non interne des interfaces du Mac, avec le port ; `null` s'il
  n'y en a pas (pas de wifi).
- `lan` : vrai si le serveur écoute `0.0.0.0` ou `::` (`./run.sh --lan`), lu dans `server.address()`.
  Faux : la page dit « Relance avec ./run.sh --lan pour le téléphone ».

### `POST /api/pair { code, name }` (LAN ou Mac, sans jeton)

→ `200 { token, device: { id, name, created } }`
→ `401 { error }` : `'code expiré ou absent'`, `'code faux'`, `'trop d’essais, redemande un code'`.

- `code` : les 6 chiffres, les espaces ignorés (`'482 913'` passe). `name` : le nom de l'appareil,
  coupé à 40 caractères, `'iPhone'` par défaut.
- **5 essais faux annulent le code** (il faut en redemander un sur le Mac). Un bon code est consommé.
- Le jeton : 32 octets aléatoires en base64url (43 caractères), rendu une seule fois ; le serveur ne
  garde que son `sha256` (hex). Perdu, c'est un nouvel appairage.

### La table `devices`

```sql
create table if not exists devices (
  id text primary key,        -- 'd-' + 8 hex
  name text,                  -- 'iPhone de Dev'
  token_hash text unique,     -- sha256 hex du jeton
  expo_push_token text,       -- 'ExponentPushToken[…]' ou null
  created text,               -- ISO ; le jeton expire 90 jours après
  last_seen text,             -- ISO, mis à jour par GET /api/phone
  revoked text                -- ISO quand oublié, sinon null
);
```

## Les routes du téléphone (jeton obligatoire)

| Route | Réponse |
|---|---|
| `GET /api/phone` | `{ device: { id, name }, plans: [{ id, title, created }], now }` ; met `last_seen` à jour : c'est le battement de cœur de l'app au premier plan (B l'appelle toutes les 3 s avec le plan). |
| `POST /api/phone/push-token { expoPushToken }` | `{ ok: true }` ; `400 { error }` si ce n'est pas une chaîne `ExponentPushToken[…]` ou `ExpoPushToken[…]`. |
| `POST /api/phone/forget` | `{ ok: true }` ; l'appareil est révoqué, le jeton ne vaut plus rien, la requête suivante reçoit 401. |
| `GET /api/plans` | comme aujourd'hui. |
| `GET /api/plan/:id` | `{ plan, state, log, estimate }`, la réponse de plan.html, inchangée. |
| `GET /api/plan/:id/session/:sid/messages` | `{ messages }`, inchangé. |
| `GET /api/events?plan=…&token=…` | le SSE du plan (`change`, `message`, `pending`), inchangé. |
| `POST /api/plan/:id/session/:sid/answer { id, allow, always?, message? }` | `{ ok: true }` (400 si la demande n'existe plus). |
| `POST /api/plan/:id/session/:sid/message { text }` | `{ ok: true }`. |
| `POST /api/plan/:id/session/:sid/dismiss { id }` | `{ ok: true }` (400 pour un autre kind ou un id inconnu). |

Rien d'autre. Les corps et les codes d'erreur de ces routes sont ceux de `docs/sessions.md`.

## Côté Mac (loopback seulement, 403 sinon)

- `GET /api/devices` → `{ devices: [{ id, name, created, last_seen, push: true | false }], address, lan,
  code }` : les appareils non révoqués et non expirés, du plus récent au plus ancien ; `push` dit s'il a
  un jeton push ; `address` et `lan` comme dans `/api/pair/code` ; `code` est le code en cours
  (`{ code, expires }`) ou `null`, pour que les deux pages montrent le même et qu'un rechargement ne le
  perde pas.
- `POST /api/devices/:id/forget` → `{ ok: true }` (404 si inconnu). Même effet que `/api/phone/forget`.
- Le SSE du Mac (`/api/events?running=1` et `?plan=…`) reçoit `change` quand un appareil s'appaire, est
  oublié ou donne son jeton push : la ligne « Téléphone » se met à jour seule.

## Le push (service d'Expo, appelé par le serveur)

- **Où** : `POST` sur `ESCADRILLE_PUSH_URL`, défaut `https://exp.host/--/api/v2/push/send`. C'est
  le seul service externe de la phase ; les tests le remplacent par un `node:http` local.
- **Corps** : une liste, un message par appareil :

```json
[{ "to": "ExponentPushToken[xxx]", "title": "Phase 5 : le téléphone", "body": "A attend ta réponse",
   "sound": "default", "data": { "plan": "2026-11-01-phase-5…", "session": "A", "kind": "waiting", "id": "reply-mvx…" } }]
```

  `title` : le titre du plan. `data.id` : le repère (voir plus bas), que l'app peut retrouver dans
  `pending` ; `data.session` est `null` pour `done`.
- **À qui** : chaque appareil non révoqué, non expiré, **avec** `expo_push_token`, et dont `last_seen`
  **date de plus de 15 s** (ou est nul) : une app au premier plan se met à jour seule, inutile de la
  prévenir. L'app en arrière-plan n'appelle rien, donc après 15 s elle reçoit les notifications.
- **Les cinq genres**, chacun poussé **une fois par (plan, session, kind, repère)** :

| kind | quand | body | repère |
|---|---|---|---|
| `waiting` | une session passe en `waiting` avec une entrée `reply` en attente (un arrêt franchi ou pas) | `A attend ta réponse` | l'id de la `reply` |
| `permission` | une entrée `permission` entre dans `pending` | `A demande : Bash curl -s https://…` (80 caractères au plus) | l'id de la demande |
| `budget` | l'alerte budget (`ALERT_BUDGET`, 80 %) ; le plafond atteint | `A : 86 % du plafond` (la part réelle) ; `A : plafond atteint` | `alert` ; `cap` |
| `error` | `health` passe à `error` | `A : <why>` (80 caractères) | le texte de `why` |
| `done` | toutes les sessions du plan sont `done` | `Plan fini : <titre>` | l'id du plan (`session: null`) |

  « A » est l'id de la session. Le message `permission` est `<id> demande : <tool> <input en une
  ligne>` coupé à 80 caractères. Un même repère n'est jamais poussé deux fois, même après un
  redémarrage du serveur : les repères poussés vivent dans une colonne JSON `pushed` de `sessions`
  (`["waiting:reply-…", "permission:ask-…", "budget:alert"]`), comme `alerted` ; le `done` du plan est
  rangé sur la dernière session finie.
- **La réponse d'Expo** : `{ data: [{ status: 'ok', id }, { status: 'error', message, details: { error:
  'DeviceNotRegistered' } }] }`, dans l'ordre du corps. Un `DeviceNotRegistered` efface
  `expo_push_token` de l'appareil (il devra réactiver « Me prévenir »). Toute autre erreur (réseau,
  HTTP non 200, corps illisible) est écrite dans la console du serveur avec le genre et le plan, et
  **jamais relancée**. Un push n'attend rien : rien ne bloque la session.
- **Les repères sont marqués avant l'envoi** : un échec réseau ne fait pas renvoyer la notification
  au tour suivant.
- Code : `lib/push.mjs` (`pushMessages(url, messages)` rend la réponse, c'est tout), appelé par
  `server.mjs` aux cinq endroits du flux (`turn`, `ask`, `error`, `done`) après l'écriture en base.

## Ce que ça change dans `server.mjs`

- `devices` et la colonne `pushed` de `sessions` ; `lib/push.mjs` ; le code d'appairage en mémoire.
- La garde en tête du handler http : OPTIONS, puis loopback ou jeton, puis liste blanche.
- Les `isLoopback … SM_LAUNCH_LAN` disparaissent des routes : la garde du haut suffit (une requête
  LAN qui arrive à une route hors liste blanche est déjà en 403).
- `json()` et le SSE renvoient l'`Origin` reçu.
- La ligne de démarrage dit aussi le nombre d'appareils appairés.

## La ligne « Téléphone » sur le Mac (`public/index.html`, `public/plan.html`)

Une ligne repliée de plus, secondaire, au-dessus de « Sur ce Mac » (`public/phone.js`, le même
mécanisme que `mac.js`) : « Téléphone · aucun appairé » ou « Téléphone · 1 appairé ». Dépliée :
l'adresse LAN, « Nouveau code » qui affiche le code en grand (mono, `482 913`) et le temps restant
(« encore 9 min »), et la liste des appareils avec « Oublier » et, dessous, quand il a été vu et s'il
reçoit les notifications. Si le serveur n'écoute que `127.0.0.1` : une phrase, « Relance avec
./run.sh --lan pour le téléphone ». L'ancre `#phone` ouvre la ligne (pour les captures et un lien).
Captures à 1280 px, `inspect.mjs --app` passé (0 FAIL ; un WARN « texte sous 13 px » qui est la barre
latérale existante) : `docs/phase5-mac-telephone.jpg` (le chat) et `docs/phase5-mac-telephone-plan.jpg`
(le plan).

## La marche de 14 h (pour Dev, sur le vrai iPhone)

Vingt minutes, pas plus. Ce qu'il te faut : le Mac et l'iPhone sur le **même wifi** (pas un réseau
d'invités), **Expo Go** à jour sur l'iPhone (App Store, gratuit). Le `projectId` EAS est déjà dans
`phone/app.json` (`npx eas-cli init` fait par la session B avec ton compte) : pas besoin de le refaire.

1. **Sur le Mac** : `./run.sh --lan`.
   → La ligne de démarrage dit `listening on 0.0.0.0 (LAN open: http://192.168.1.x:3078), 0 phone paired`.
   ✗ Si elle dit `127.0.0.1 only`, le `--lan` manque.
2. **Dans `phone/`** : `npm install` la première fois, puis `npx expo start --lan`.
   → Metro démarre et affiche un QR code et une adresse `exp://192.168.1.x:8081`.
   ✗ « Port 8081 is unavailable » : un autre Expo tourne (celui d'une session) ; arrête-le ou ajoute `--port 8082`.
3. **Sur l'iPhone** : scanne ce QR avec l'appareil photo, touche la bannière : Expo Go s'ouvre sur l'app.
   → L'écran « Appairage » : un champ pour l'adresse du Mac, un pour le code, « Appairer ».
   ✗ Expo Go dit que le projet demande un autre SDK : mets Expo Go à jour (l'app est en SDK 58).
   ✗ « Impossible de se connecter » à Metro : wifi différent ou réseau d'invités.
4. **Sur le Mac, dans la page** (`http://localhost:3078`) : déplie la ligne « Téléphone » (au-dessus de
   « Sur ce Mac »), « Nouveau code ».
   → Six chiffres en grand (`482 913`), l'adresse LAN à côté, « encore 10 min ».
5. **Dans l'app** : l'adresse est préremplie avec `http://192.168.1.x:3078` (vérifie qu'elle est celle de
   la page), tape le code, « Appairer ».
   → L'app passe sur « Plan » (le plus récent, « À faire » en tête) ; la ligne du Mac dit « 1 appairé »
     toute seule.
   ✗ « code faux » : retape ; au cinquième essai faux le code est annulé, refais « Nouveau code ».
   ✗ « code expiré ou absent » : plus de 10 minutes, ou le serveur a redémarré.
   ✗ « Le Mac ne répond pas à cette adresse » : `./run.sh --lan` ne tourne pas, mauvaise adresse, ou le
     pare-feu de macOS refuse `node` (Réglages Système → Réseau → Coupe-feu).
6. **Le push** : dans l'app, la ligne « Réglages » (repliée), active « Me prévenir », accepte la
   permission d'iOS.
   → L'interrupteur reste vert ; dans la ligne « Téléphone » du Mac, l'appareil dit qu'il reçoit les
     notifications.
   ✗ L'interrupteur grisé « Sur le téléphone seulement » : tu es dans le navigateur, pas dans Expo Go.
7. **Le test du push** : sur le Mac, envoie un message à une session d'un plan (ou lance-en une), puis
   **verrouille l'iPhone** et attends : l'app au premier plan se met à jour seule, le serveur ne
   prévient qu'un téléphone qu'il n'a pas vu depuis 15 s.
   → À la fin du tour, une notification « A attend ta réponse » (titre : le plan) ; une autorisation
     demandée donne « A demande : Bash … ». La toucher ouvre l'app sur ce plan et cette session.
   → Réponds depuis l'app (« Autoriser », ou une ligne) : la session repart, la page du Mac le voit en même temps.
8. **Pour finir** (si tu veux) : « Oublier ce téléphone » dans Réglages, ou « Oublier » sur le Mac.
   → L'app revient à l'appairage ; la ligne du Mac dit « aucun appairé ».

Ce qui peut rater encore :

- **Un 401 dans l'app** : elle revient seule à l'appairage. Le jeton a été oublié sur le Mac, ou il a
  plus de 90 jours. Un serveur relancé sans `--lan` ne donne pas 401 mais « Le Mac ne répond pas ».
- **Pas de notification** : l'app était au premier plan (règle des 15 s) ; « Me prévenir » est éteint ;
  le mode Concentration d'iOS ; ou Expo a refusé le jeton : la console du serveur écrit chaque erreur
  du service push avec le genre et le plan (`DeviceNotRegistered` efface le jeton : réactive « Me
  prévenir »). Expo Go sur iOS reçoit les notifications distantes ; il faut le `projectId`, qui est là.
- **Le wifi** : un réseau d'invités ou un « isolement des clients » empêche l'iPhone de voir le Mac ;
  en 4G/5G, rien ne marche (pas de relais, c'est voulu).

## L'essai de bout en bout (session C, 2026-11-01)

Contre le serveur en `--lan` sur un port d'essai, le faux claude, un faux service push, l'app en web à
390 px : tout le contrat ci-dessus vérifié, 12 push, aucun en double, aucune erreur serveur. Le détail
dans `docs/sessions.md` (« Le téléphone (phase 5) »), le journal dans `docs/phase5-essai-journal.json`,
l'écran « À faire » avec deux vraies autorisations dans `docs/phase5-phone-reel.jpg` (et
`docs/phase5-phone-reel-suite.jpg`, le même sur un écran large : l'app garde sa colonne).

Un vrai envoi vers `exp.host` avec le jeton factice `ExponentPushToken[test]` répond `HTTP 200` et
`{ data: [{ status: 'error', message: '… is not a valid Expo push token', details: { error:
'DeviceNotRegistered', expoPushToken: '…' } }] }`, la forme déjà traitée.

## Après la fusion (session C)

A et B étaient déjà fusionnées dans main depuis la page (`9e950cf`, `e412df5`) : aucun conflit.
Un seul écart entre ce contrat et l'app : le type `PhoneInfo` de `phone/src/api.ts` attendait
`device.created` dans `GET /api/phone`, que le serveur ne rend pas (`{ id, name }`). Aucun écran ne le
lisait ; le type est corrigé, le contrat ne change pas. `phone/dev/stub.mjs` (les routes du téléphone
simulées avant A) n'a plus d'usage : `server.mjs` les tient.
