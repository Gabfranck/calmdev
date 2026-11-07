# CI/CD du dépôt public

Le dépôt public `Gabfranck/calmdev` porte deux workflows, sous `.github/workflows/`, exportés avec le code
(`public-manifest.json`, « include ») ; `pages.yml` reste dans le dépôt privé. Rien ne se publie seul : la release
est un brouillon, npm attend un lancement à la main et une approbation.

Chaque job porte `if: github.repository == 'Gabfranck/calmdev'` : dans le dépôt privé (qui reçoit aussi ces fichiers),
rien ne tourne, car ses minutes Actions seraient facturées (macOS compte dix fois) et ses traces y sont voulues.

## ci.yml : les tests et la recherche de traces

- **Quand** : chaque pull request, chaque push sur `main` et `dev`. Un nouveau push sur la même branche annule le
  passage en cours.
- **Droits** : `permissions: contents: read`, aucun secret requis pour passer ; aucun job n'élargit les droits.
- **Tests** : `node --test 'test/*.test.mjs'` sur `ubuntu-latest` et `macos-latest`, Node 22.13 (`actions/setup-node`),
  `CI=true`. Une identité git factice (`CI`, `ci@example.invalid`) sert aux tests qui committent dans un dépôt temporaire.
  Sur Linux, `bubblewrap` et `socat` sont installés (sans eux le serveur refuse de lancer une session, comme
  `install.sh --check` le dit) et la restriction AppArmor d'Ubuntu 24.04 sur les espaces de noms est levée pour `bwrap`.
- **Traces** : `scripts/trace-scan.mjs --fixtures` échoue (code 1) si un secret, un dossier personnel, un téléphone, une
  adresse du réseau local ou un nom privé sort. `--fixtures` lit la liste `EXEMPT` du script (les fichiers dont les
  traces sont voulues : le garde-fou de vie privée et ses tests) et n'y cherche que les noms privés. Les noms privés (clients, collègues) ne sont jamais commités : ils viennent du
  secret `TRACE_WORDS`, un tableau JSON d'expressions régulières (la liste `traceWords` de `public-manifest.json`).
  Sans ce secret (une PR venue d'un fork n'en reçoit pas), le scan tourne quand même et un avertissement le dit.

### Les tests sautés sous CI

Un test qui exige ce que le runner n'a pas se saute lui-même avec sa raison, il n'est jamais supprimé. Aucun ne lit
`CI` pour se sauter : chacun teste ce dont il a besoin, ce qui vaut aussi sur un Mac sans navigateur. Sous `CI=true`
sur le Mac, 4 sautés, 1 077 passés, 0 échec hors la ligne du dépôt privé dite plus bas.

| Test | Ce qu'il exige | Condition |
|---|---|---|
| `test/automerge.test.mjs` « the real Seatbelt box » | le bac à sable macOS (`sandbox-exec`) | macOS et `sandbox-exec` utilisable |
| `test/capture.test.mjs`, `test/qarun.test.mjs` (captures réelles) | un navigateur (`chrome-headless-shell`) | le navigateur est installé et démarre |
| `test/playbooks.test.mjs` « the private edu-quiz playbook » | un playbook privé de la machine du développeur | le fichier est lisible |
| `test/leftfixes.test.mjs` « the fix left by the session NOM » | un document du dépôt privé | le fichier existe |
| `test/e2e-real.test.mjs`, `test/release*.test.mjs`, `test/qa.test.mjs`, `test/selfedit.test.mjs` | git lancé depuis Node | git se lance (toujours vrai sur un runner) |

Les tests restent sur le faux `claude` (`test/fake-claude.mjs`) : aucun n'appelle le vrai, ni le réseau, ni un paiement.

### Ce que le premier passage a appris (7 novembre, run 42315765123)

Sept échecs, tous dans les tests, aucun dans le code livré ; aucun test sauté pour les régler :
- **Un PATH de faux ne s'allonge jamais de `/usr/bin:/bin` entiers** : le runner y a `bwrap` (installé plus haut) et
  `google-chrome`. `test/linux.test.mjs` et `test/open-app.test.mjs` montent un dossier d'outils système nommés
  (`sed`, `cut`, `git`…), chacun un wrapper vers le vrai.
- **Node 22.13 est le plancher** : il n'importe pas un `.ts` sans drapeau (`test/phone-projects.test.mjs` retire les
  types par `module.stripTypeScriptTypes`) et ignore l'option `timeout` de `DatabaseSync`, arrivée en 22.16 (la base
  s'ouvre par `lib/sqlite.mjs`, qui pose `pragma busy_timeout` ; sans lui, `database is locked` sur macOS).
- **Un port de test n'est jamais un port éphémère** : Linux tire ses ports éphémères au hasard et les donne aussi aux
  connexions sortantes ; un port relâché par `freePort` était repris avant que le serveur du test s'y lie, et le test
  parlait à un autre serveur (les délais d'`api.test` et `qa.test` sous Linux). `test/free-port.mjs` tire entre 20000
  et 32767 et réserve le port entre processus. Diagnostic sans le journal sous la main : à vérifier au prochain passage.

## release.yml : l'app desktop et le paquet npm

### Sur un tag `v*` : le .dmg en brouillon

- Job `desktop` sur `macos-latest`. **Première étape** : « Secrets present? » liste dans le résumé du job (`GITHUB_STEP_SUMMARY`)
  les secrets absents parmi les huit attendus (noms seulement) ; si `TAURI_SIGNING_PRIVATE_KEY` ou son mot de passe manque,
  elle échoue (`::error::`) avant tout checkout et tout build ; les `APPLE_*` absents ne donnent qu'un avertissement.
  Puis : le tag doit valoir `v` + la `version` de `tauri.conf.json` ; Rust stable (rustup du runner) avec les deux cibles
  `aarch64-apple-darwin` et `x86_64-apple-darwin` ; `npm ci` dans `desktop/` (la CLI Tauri de `desktop/package-lock.json`) ;
  `tauri build --target universal-apple-darwin --bundles app,dmg` (un seul binaire pour Apple Silicon et Intel).
- Sont attachés à une **GitHub Release en brouillon** (`gh release create --draft`), depuis
  `desktop/src-tauri/target/universal-apple-darwin/release/bundle/` : le `.dmg`, le `calmdev.app.tar.gz` de la mise à jour,
  sa `.sig` (signée par `TAURI_SIGNING_PRIVATE_KEY`, minisign) et un `latest.json` (version, signature, URL du tag, pour
  `darwin-aarch64` et `darwin-x86_64`) que l'app installée lit à `releases/latest/download/latest.json` (docs/desktop.md).
  Un brouillon déjà là reçoit les fichiers à la place. Seul ce job a `contents: write`. Le pas à pas de Dev (certificat,
  clé, secrets, tag, publication) est dans docs/desktop.md, « Publier une version ».
- **Signature Apple** : branchée seulement si `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` et
  `APPLE_SIGNING_IDENTITY` existent ; Tauri signe, puis notarise si `APPLE_ID`, `APPLE_PASSWORD` et `APPLE_TEAM_ID`
  existent aussi. Sans eux, le `.dmg` est construit non signé et le passage porte un avertissement ; la note du brouillon
  le dit (clic droit > Ouvrir au premier lancement).
- Publier la release reste un clic sur GitHub.

### À la main seulement : npm

- Job `npm`, lancé par « Run workflow » (`workflow_dispatch`) avec la case `npm` cochée ; un tag ne publie jamais rien
  sur npm.
- Il tourne dans l'environnement `release` (l'approbation obligatoire y vit), relance les tests sous `CI=true`, puis
  publie avec le secret `NPM_TOKEN` (provenance npm, `id-token: write`).
- Il refuse s'il n'y a pas de `package.json` publiable à la racine (aujourd'hui il n'y en a pas : `npx escadrille` viendra).

## Les secrets attendus (noms seulement)

| Secret | Où | Sert à |
|---|---|---|
| `TRACE_WORDS` | dépôt | les noms privés que le scan cherche (facultatif) |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | dépôt | signer le `.dmg` (facultatif) |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | dépôt | notariser (facultatif) |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | dépôt | signer la mise à jour (`.app.tar.gz.sig`) ; sans eux le job de release s'arrête |
| `NPM_TOKEN` | environnement `release` | publier sur npm |

`GITHUB_TOKEN` est fourni par GitHub, rien à créer.

## Les réglages GitHub, à cliquer par le mainteneur

1. **Settings > Environments > New environment** `release` : cocher « Required reviewers » (le mainteneur), restreindre les
   branches de déploiement à `main`, puis y ajouter le secret `NPM_TOKEN`.
2. **Settings > Branches > Add rule** (ou Rulesets) sur `main` : pull request obligatoire, statuts requis
   `Tests (ubuntu-latest)`, `Tests (macos-latest)` et `Trace scan`, pas de push forcé, pas de suppression. Même règle,
   plus légère, sur `dev` si voulu.
3. **Settings > Actions > General** : « Read repository contents permission » par défaut ; exiger l'approbation des
   workflows pour les contributeurs extérieurs.
4. **Settings > Secrets and variables > Actions** : `TRACE_WORDS`, puis les `APPLE_*` et les deux `TAURI_SIGNING_*` (docs/desktop.md, « Publier une version »).

## Vérifié en local, et ce qui ne l'est pas

- `test/workflows.test.mjs` lit les deux workflows (un petit lecteur YAML sans dépendance) et vérifie déclencheurs,
  matrice, Node 22.13, droits, brouillon, signature conditionnelle, npm derrière `release`, actions épinglées.
- `actionlint` n'est pas installé sur la machine : il n'a pas tourné.
- Les actions sont épinglées sur un commit (`actions/checkout` v4.2.2, `actions/setup-node` v4.4.0) ; ces empreintes ont
  été écrites sans accès réseau : le premier passage sur GitHub les confirme (un commit inconnu échoue dès la première étape).
- `test/updater.test.mjs` vérifie le build universel, les huit secrets, le brouillon, la forme de `latest.json` (le script du
  workflow est exécuté), l'endpoint, `createUpdaterArtifacts` et le placeholder de la clé publique qui coupe la vérification.
- `cargo check` avec les deux nouvelles crates passe en local, sans avertissement (7 novembre ; `tauri-plugin-updater`
  2.14.1, `tauri-plugin-dialog` 2.8.4, `Cargo.lock` à jour).
- Le passage Linux, la construction du `.dmg` (universel), la signature et la mise à jour réelle n'ont jamais tourné :
  ils tourneront au premier tag sur Gabfranck/calmdev.
- Sur l'arbre exporté (`scripts/public-export.mjs HEAD`, 506 fichiers), le scan `--fixtures` avec les `traceWords` passe
  et la suite sous `CI=true` passe : 950 tests, 0 échec, 5 sautés, 2 en attente (le patch des garde-fous). Pour y
  arriver : les tests de fichiers qui restent privés ne partent pas (`payments`, `site-public`, `capacites`),
  `scripts/first-run-check.mjs` part avec son test, le test du correctif NOM se saute sans son fichier, et
  `backlog-page`, `entry` ne dépendent plus de l'ordre ni de la taille que les renommages changent.
- Dans le dépôt privé, `test/trace-scan.test.mjs` reste rouge (`docs/decisions-archive.md`, chemins personnels) :
  ce fichier ne part pas dans le dépôt public, où le test passe.
