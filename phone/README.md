# calmdev sur le téléphone

Une app Expo (SDK 58) ouverte dans Expo Go sur l'iPhone. Elle parle au serveur calmdev du Mac en
http sur le wifi (`./run.sh --lan`, port 3078) : elle suit le plan, répond à ce qui attend, et reçoit
les notifications. Elle ne lance, ne fusionne et n'arrête rien : cela se fait sur le Mac.

## Les écrans

Une colonne, corps à 16 px, chaque cible tactile à 44 px au moins, une action principale par écran.
Couleurs, rayons et statuts repris de `public/app.css` (clair et sombre, selon le téléphone).

1. **Appairage** (`src/screens/Pair.tsx`) : le code à 6 chiffres affiché sur le Mac, l'adresse du Mac
   (la dernière, sinon `http://192.168.1.x:3078`), « Appairer ». L'erreur en une ligne. Le jeton et
   l'adresse vont dans SecureStore (localStorage en web).
2. **Plan** (accueil) : « À faire » en tête (autoriser ou refuser avec un motif, répondre en une
   ligne, « Vu » sur une alerte ou une info), « Rien à faire, N sessions en vol » quand c'est vide ;
   dessous, le flot : les vagues, une carte par session qui ouvre son fil. Un sélecteur si plusieurs plans.
3. **Sessions** : un onglet par session, le fil (le dernier en bas, les blocs `escadrille:state`
   résumés en une ligne), un champ d'une ligne et « Envoyer ».
4. **Journal** : du plus récent au plus ancien, heure, session, statut, ligne `claude`.

Une barre d'onglets en bas (Plan, Sessions, Journal) et une ligne « Réglages » repliée : l'adresse, « Projet »,
« Me prévenir » (les notifications), « Oublier ce téléphone ».

**Projet.** Dev travaille sur plusieurs projets ; le réglage « Projet » (Réglages, une ligne repliée)
choisit lequel l'app montre. La liste vient des plans de `GET /api/phone` (le champ `project` de
chaque plan, nom court = dernier segment du chemin). « Tous les projets » est le défaut : le sélecteur
de plans est alors groupé, une ligne repliée par projet. Un projet choisi est gardé sous
`escadrille.project`, dans le même stockage que le jeton, envoyé en `?project=` à `GET /api/phone`, et
les écrans « À faire », le flot et les sessions ne montrent que lui, son nom court en tête, discret. Un
projet que plus aucun plan ne porte est oublié : retour à « Tous ». Une notification touchée place
l'app sur le projet de son plan (`data.project`, sinon retrouvé dans les plans). La logique du filtre et
du groupement est dans `lib/projects.ts` (sans import, testée par `test/phone-projects.test.mjs`).

## Les langues

Anglais et français, ceux de l'appareil (anglais si ni l'un ni l'autre). `src/i18n.ts` : `t('clé', { param })`, la langue lue une fois par `Intl` (en web, `?lang=fr|en` la force pour les captures), les pluriels par paires `_one` / `_other` (paramètre `n`), `percent()` et `money()` selon la langue. Les textes vivent dans `src/locales/en.json` et `fr.json` ; `test/phone-i18n.test.mjs` vérifie mêmes clés, mêmes `{paramètres}`, aucune clé manquante ou morte, aucun texte visible resté hors de `t()`. Les messages que le serveur écrit lui-même (erreurs, texte d'une autorisation, ligne `claude`) s'affichent tels quels.

## Les dépendances

Toutes posées par `npx expo install`, aux versions du SDK :

| Paquet | Pourquoi |
| --- | --- |
| `expo`, `react`, `react-native`, `expo-status-bar` | le gabarit `blank-typescript` |
| `expo-secure-store` | garder le jeton d'appareil (90 jours) et l'adresse du Mac hors du stockage en clair |
| `expo-notifications` | recevoir les notifications poussées par le serveur via Expo (pas en web) |
| `expo-device` | le nom de l'appareil envoyé à l'appairage, et savoir si l'on est sur un vrai téléphone (le jeton Expo l'exige) |
| `expo-constants` | lire le `projectId` EAS dans `app.json` pour obtenir le jeton Expo |
| `react-dom`, `react-native-web` | rendre l'app dans un navigateur, pour les essais et les captures à 390 px |

Pas d'expo-router : un état « écran » et une barre d'onglets suffisent. Pas de client SSE : l'app au
premier plan interroge `GET /api/plan/:id` et `GET /api/phone` toutes les 3 secondes, rien en arrière-plan.

## Le contrat avec le serveur

- `Authorization: Bearer <jeton>` sur chaque requête ; une réponse 401 ramène à l'appairage.
- `POST /api/pair { code, name }` (sans jeton) → `{ token, device }` ; 401 `{ error }`.
- `GET /api/phone` → `{ device, plans, now }`, aussi le battement de cœur.
- `POST /api/phone/push-token { expoPushToken }`, `POST /api/phone/forget`.
- `GET /api/plan/:id`, `GET /api/plan/:id/session/:sid/messages`.
- `POST …/session/:sid/answer { id, allow, always?, message }`, `…/message { text }`, `…/dismiss { id }`.

## Lancer

```sh
cd phone
npm install
npx expo start            # puis scanner le QR code avec l'appareil photo de l'iPhone (Expo Go)
npx expo start --web      # dans un navigateur, pour les essais
```

Le Mac lance calmdev avec `./run.sh --lan` ; le téléphone et le Mac sont sur le même wifi.

## Essayer sans téléphone

Un serveur calmdev jetable, nourri par `dev/seed.mjs` (le plan de la phase 5 avec une autorisation,
une réponse, une alerte, des fils et un journal fabriqués), et `dev/stub.mjs`, qui tient les routes du
téléphone (code `123456`) tant qu'elles ne sont pas dans `server.mjs`, et relaie le reste :

```sh
node phone/dev/seed.mjs /tmp/phone-test
ESCADRILLE_DB=/tmp/phone-test/db.sqlite ESCADRILLE_PLANS=/tmp/phone-test/plans PORT=3191 ESCADRILLE_CLAUDE=/usr/bin/false node --no-warnings server.mjs
node phone/dev/stub.mjs 3192 http://127.0.0.1:3191
cd phone && npx expo start --web --port 8081
# http://localhost:8081/?base=http://localhost:3192&token=dev&theme=light   (web seulement : base, token, theme, tab, session,
#   filter=<chemin du projet>, plan=…&project=… pour jouer une notification, screen=settings|project pour ouvrir Réglages)
# phone/dev/seed-projects.mjs <dir> remplace seed.mjs pour avoir trois projets (escadrille, Orchard, Acme)
```

## Les notifications

`src/notify.ts`, chargé seulement sur le téléphone (jamais en web). « Me prévenir », dans Réglages :
demande la permission, obtient le jeton Expo (`getExpoPushTokenAsync({ projectId })`) et l'envoie au
Mac (`POST /api/phone/push-token`). Une notification touchée ouvre l'app sur le plan et la session de
son `data` : le serveur envoie `data: { plan, session }`. En web, ou sans `projectId`, l'interrupteur
est grisé et dit « Sur le téléphone seulement ».

Le `projectId` existe : `npx eas-cli init` a créé le projet gratuit `@gabfranck/escadrille` sur
expo.dev avec le compte de Dev, et `app.json` porte `extra.eas.projectId`
(`161eec76-bc5a-41e6-ab63-d8c472699448`) et `owner: "gabfranck"`. Ce n'est pas un secret : il identifie
le projet, il ne donne aucun droit. Le push est prêt pour l'essai sur l'iPhone : ouvrir l'app dans
Expo Go, s'appairer, activer « Me prévenir » dans Réglages et accepter la permission.

Aucun build EAS n'est nécessaire : Expo Go suffit pour recevoir les notifications sur l'iPhone.

## La dictée

Sur l'iPhone dans Expo Go, pas de Web Speech ni de module natif sans dépendance : le repli est la dictée du clavier iOS, qui marche dans les champs de réponse, de message et de motif de refus (`Field`, correction automatique laissée active).
En mode web (`dev/stub.mjs`, localhost:8081), un bouton « Dicter » apparaît à côté d'« Envoyer » quand `window.webkitSpeechRecognition` existe (`src/dictation.ts`, `useDictation`, même principe que `public/speech.js` sans l'importer) ; sinon rien ne s'affiche.
Aucune dépendance ajoutée.
