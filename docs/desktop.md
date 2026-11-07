# calmdev sur le bureau (étape A)

- **Prérequis** : Rust 1.77 ou plus (`rustup update stable`), Node 22.13+, Xcode Command Line Tools ; puis `cd desktop && npm install` (réseau : npm, puis crates.io au premier build).
- **Lancer** : `cd desktop && npm run dev` (un autre port : `PORT=3090 npm run dev`).
- **Construire** : `npm run build:debug` écrit `desktop/src-tauri/target/debug/bundle/macos/calmdev.app`, non signé, non notarisé, publié nulle part.
- **Installer ou mettre à jour** : `npm run install:app` construit la version release (cible dans `~/Library/Caches/calmdev-desktop-target`, hors du dépôt) et la copie dans `/Applications/calmdev.app` (la précédente est remplacée). `install.sh` et `./run.sh --open` l'ouvrent ensuite à la place du navigateur. C'est la seule app : l'ancienne app Chrome (manifeste, ligne « Installer ») est retirée (7 nov.).
- **Ce que fait l'app** : une fenêtre calmdev de 1440×900 sur http://localhost:3078 (ou le port de `PORT`), ouverte par le lien de garde (`~/.config/calmdev/guard-link`, docs/gate.md) pour que la fenêtre puisse agir. Si rien n'écoute, elle lance `./run.sh` du dépôt, affiche « calmdev démarre », et ouvre la page dès que le serveur répond. Si le serveur ne répond pas, une phrase dit quoi faire. À la fermeture, elle n'arrête que le serveur qu'elle a démarré elle-même.
- **Réglages** : `calmdev.json` contient les défauts. `~/Library/Application Support/ai.calmdev.desktop/config.json` les remplace (`{"repo": "/chemin/du/dépôt", "port": 3078, "waitSeconds": 60}`). Par défaut, le dépôt est le dossier parent de `desktop/`. Le journal du serveur lancé est écrit dans `~/Library/Logs/ai.calmdev.desktop/server.log`.
- **Sécurité** : la CSP de l'écran d'attente n'ouvre que localhost. La fenêtre ne navigue que vers localhost, et les autres liens s'ouvrent dans le navigateur par défaut. La page du serveur garde sa propre CSP.
- **Icônes** : `npm run icons` les régénère depuis la marque (`docs/design-system/calmdev/brand/icon-1024.svg`, avec rsvg-convert).
- **Dépendances** (elles restent dans `desktop/`, le serveur n'en a aucune) : `@tauri-apps/cli` sert à lancer et construire l'app avec npm ; la crate `tauri` fournit la fenêtre native (WKWebView) sans embarquer de navigateur ; `serde_json`, déjà tirée par Tauri, lit `config.json` ; `tauri-plugin-updater` cherche une version plus récente et vérifie la signature minisign de chaque mise à jour avec la clé publique de `tauri.conf.json` (sa raison d'être : une mise à jour non signée par la clé de Dev est refusée) ; `tauri-plugin-dialog` ne sert qu'à la boîte native « Mettre à jour / Plus tard » (la boîte de l'updater exige ce plugin, sinon il faudrait une page web ou `osascript`).
- **Mise à jour** : dès que la page est ouverte, l'app interroge en arrière-plan `https://github.com/Gabfranck/calmdev/releases/latest/download/latest.json` (rien ne bloque la fenêtre ; hors ligne ou sans release, l'échec est écrit dans le journal et ignoré). Si une version plus récente existe, une boîte native propose « Mettre à jour » (télécharge, vérifie la signature, installe, arrête le serveur que l'app avait lancé, relance) ou « Plus tard ». Tant que `plugins.updater.pubkey` vaut `PLACEHOLDER_UPDATER_PUBLIC_KEY`, rien n'est vérifié et les deux plugins ne sont même pas chargés : l'app marche comme avant. Les builds locaux (`build:debug`, `install:app`) coupent `createUpdaterArtifacts` : ils n'ont pas besoin de la clé privée.
- **Ce qui viendra** : B, une barre de menus avec l'état des sessions et les notifications natives. Un `.exe` (décision du 4 novembre). Ce sera le clic de Dev.

## Publier une version

Pour qui publie l'app, une fois la mise en place faite (étapes 1 à 5), une version ne demande que les étapes 6 et 7. Rien ne part tout seul : le workflow `release.yml` (docs/ci.md) ne crée qu'un **brouillon**.

Les fichiers sensibles vivent dans un dossier hors de tout dépôt, `~/.calmdev-prod/` par défaut (700, fichiers en 600 ; `CALMDEV_PROD` en choisit un autre) : `calmdev-developer-id.p12` et `updater.key` / `updater.key.pub`. Les mots de passe restent dans un gestionnaire de mots de passe.

1. **Certificat Developer ID Application** : developer.apple.com > Certificates > « + » > Developer ID Application (avec une demande de signature faite par Trousseau d'accès > Assistant de certification), puis Trousseau d'accès > Mes certificats > clic droit > Exporter en `.p12` avec un mot de passe (`APPLE_CERTIFICATE_PASSWORD`), rangé sous `~/.calmdev-prod/calmdev-developer-id.p12`. `APPLE_SIGNING_IDENTITY` est son nom complet, `Developer ID Application: Nom (TEAMID)` (`security find-identity -v -p codesigning` l'affiche).
2. **Le mot de passe d’app Apple, le Team ID** : account.apple.com > Connexion et sécurité > Mots de passe d’app (c'est `APPLE_PASSWORD`, pas le mot de passe du compte). `APPLE_ID` est l'e-mail du compte Apple Developer. `APPLE_TEAM_ID` est l'identifiant à 10 caractères de developer.apple.com > Membership details.
3. **Clé de mise à jour** : `cd desktop && npx tauri signer generate -w ~/.calmdev-prod/updater.key` (son mot de passe est `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). La clé privée ne se commite ni ne s'envoie jamais ailleurs que dans le secret ; sans elle, aucune app déjà installée ne peut plus se mettre à jour.
4. **Clé publique** : le contenu de `updater.key.pub` va dans `desktop/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) ; tant qu'il y a `PLACEHOLDER_UPDATER_PUBLIC_KEY`, l'app ne vérifie rien.
5. **Poser les huit secrets** dans le dépôt, d'un coup dans un terminal : `sh desktop/scripts/release-secrets.sh [OWNER/REPO]`. Il vérifie `gh`, le dépôt et les deux fichiers, pose le `.p12` (en base64) et la clé par redirection, demande l'identité et le Team ID s'ils ne sont pas dans l'environnement, puis les quatre mots de passe à l'invite masquée de `gh`. À la main, la même chose (jamais un mot de passe en clair dans une commande) :

   ```sh
   R=OWNER/REPO
   base64 -i ~/.calmdev-prod/calmdev-developer-id.p12 | gh secret set APPLE_CERTIFICATE -R $R
   gh secret set APPLE_CERTIFICATE_PASSWORD -R $R          # tapé à l'invite
   gh secret set APPLE_SIGNING_IDENTITY -R $R              # Developer ID Application: Nom (TEAMID)
   gh secret set APPLE_ID -R $R                            # l'e-mail du compte Apple Developer
   gh secret set APPLE_PASSWORD -R $R                      # le mot de passe d'app
   gh secret set APPLE_TEAM_ID -R $R                       # TEAMID
   gh secret set TAURI_SIGNING_PRIVATE_KEY -R $R < ~/.calmdev-prod/updater.key
   gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R $R  # tapé à l'invite
   gh secret list -R $R                                    # les huit noms, sans valeur
   ```

   Sans les `APPLE_*`, le `.dmg` sort non signé ; sans les deux `TAURI_*`, le job s'arrête avant de construire. Le code doit d'abord être arrivé sur Gabfranck/calmdev (export public) : le workflow tourne là.
6. **Taguer.** Monter `version` dans `desktop/src-tauri/tauri.conf.json` (et `Cargo.toml`), commiter, puis `git tag v0.2.0 && git push origin v0.2.0` (le tag doit valoir `v` + la version, le workflow le vérifie). Le job « Desktop .dmg (draft release) » construit l'app universelle (Apple Silicon et Intel) ; son résumé liste les secrets manquants, le cas échéant.
7. **Publier le brouillon.** GitHub > Releases : le brouillon contient `calmdev_<version>_universal.dmg`, `calmdev.app.tar.gz`, sa `.sig` et `latest.json`. Lire, puis « Publish release ». Dès cet instant, les apps installées proposent la mise à jour au prochain démarrage. Le `.dmg` est ce qu'on donne à un nouvel utilisateur.

Limite connue : une app construite avant la clé publique (celle installée par `npm run install:app` avant le 7 novembre) ne cherche aucune mise à jour ; elle se réinstalle une fois depuis le `.dmg`.
