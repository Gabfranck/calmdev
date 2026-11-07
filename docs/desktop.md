# calmdev sur le bureau (étape A)

- **Prérequis** : Rust 1.77 ou plus (`rustup update stable`), Node 22.13+, Xcode Command Line Tools ; puis `cd desktop && npm install` (réseau : npm, puis crates.io au premier build).
- **Lancer** : `cd desktop && npm run dev` (un autre port : `PORT=3090 npm run dev`).
- **Construire** : `npm run build:debug` écrit `desktop/src-tauri/target/debug/bundle/macos/calmdev.app`, non signé, non notarisé, publié nulle part.
- **Ce que fait l'app** : une fenêtre calmdev de 1440×900 sur http://localhost:3078 (ou le port de `PORT`). Si rien n'écoute, elle lance `./run.sh` du dépôt, affiche « calmdev démarre », et ouvre la page dès que le serveur répond. Si le serveur ne répond pas, une phrase dit quoi faire. À la fermeture, elle n'arrête que le serveur qu'elle a démarré elle-même.
- **Réglages** : `calmdev.json` contient les défauts. `~/Library/Application Support/ai.calmdev.desktop/config.json` les remplace (`{"repo": "/chemin/du/dépôt", "port": 3078, "waitSeconds": 60}`). Par défaut, le dépôt est le dossier parent de `desktop/`. Le journal du serveur lancé est écrit dans `~/Library/Logs/ai.calmdev.desktop/server.log`.
- **Sécurité** : la CSP de l'écran d'attente n'ouvre que localhost. La fenêtre ne navigue que vers localhost, et les autres liens s'ouvrent dans le navigateur par défaut. La page du serveur garde sa propre CSP.
- **Icônes** : `npm run icons` les régénère depuis la marque (`docs/design-system/calmdev/brand/icon-1024.svg`, avec rsvg-convert).
- **Dépendances** (elles restent dans `desktop/`, le serveur n'en a aucune) : `@tauri-apps/cli` sert à lancer et construire l'app avec npm ; la crate `tauri` fournit la fenêtre native (WKWebView) sans embarquer de navigateur ; `serde_json`, déjà tirée par Tauri, lit `config.json`.
- **Ce qui viendra** : B, une barre de menus avec l'état des sessions et les notifications natives. C, un `.dmg` signé et notarisé, avec mise à jour, et un `.exe` (décision du 4 novembre). Ce sera le clic de Dev.
