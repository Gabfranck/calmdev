# calmdev sous Linux

Phase 7, session E (2026-11-01). Aucune machine Linux n'était disponible : tout ce qui suit est testé par
des stubs (plateforme passée en paramètre, faux binaires dans un PATH de test), jamais sur un vrai Linux.

## Ce qui est fait

- **Le bac à sable** : `sandboxSettingsFor(platform)` (`lib/planner.mjs`) rend les réglages `sandbox` de
  Claude Code pour la plateforme ; `SANDBOX_SETTINGS` reste exporté et vaut `sandboxSettingsFor()`. Sous
  Linux, mêmes clés que sous macOS, plus `~/.bashrc` et `~/.profile` refusés en lecture (l'équivalent Linux
  de `~/.zshrc` et `~/.bash_profile`, souvent porteurs de jetons).
- **bubblewrap requis** : `sandboxStatus({ platform, which })` dit si le bac à sable peut tourner (sous
  Linux : `bwrap` et `socat` sur le PATH). S'il manque, le serveur le dit au démarrage (ligne `listen`) et
  `startSession` refuse de lancer une session (règle de la phase 3 : pas de session hors bac à sable).
- **Le terminal** : `pickTerminal({ platform, env, which })` (`lib/terminal.mjs`) choisit, sous Linux,
  `SM_TERMINAL` s'il est donné, puis une nouvelle fenêtre tmux si l'on est dans tmux (`TMUX`), puis kitty,
  gnome-terminal, konsole, xterm ; sinon une erreur lisible. Sous macOS : Ghostty, sinon Terminal.app.
- **L'installeur** : `./install.sh` (POSIX sh) vérifie Node 22.13+, `claude` sur le PATH, `bwrap` sous
  Linux, puis lance `./run.sh` et ouvre la page ; `--check` vérifie sans lancer, `--no-open` n'ouvre pas.

## Ce que fait le bac à sable sous Linux, et ce qui a pu être lu

Ce qui a été vérifié depuis le Mac : **rien sur le Claude Code installé**. La session tourne elle-même dans
le bac à sable ; `claude` n'est pas sur son PATH et `~/.local/bin/claude`, `~/.local/share/claude` sont
refusés en lecture (« Operation not permitted »). `claude --help` n'a donc pas pu être lu, ni sa doc
embarquée ; les plugins de `~/.claude/plugins` ne mentionnent ni bubblewrap ni bwrap (recherche faite).

Ce qui suit vient de la documentation publique de Claude Code telle que je la connais, **non vérifié ici** :

- macOS isole par Seatbelt (`sandbox-exec`), Linux par bubblewrap (`bwrap`) ; WSL2 marche comme Linux,
  WSL1 non.
- Sous Linux, le réseau passe par un proxy local relié au bac à sable par `socat` : les paquets à installer
  sont `bubblewrap` et `socat` (`sudo apt install bubblewrap socat`, `sudo dnf install bubblewrap socat`).
- Les clés de `settings.json` sont les mêmes (`sandbox.enabled`, `failIfUnavailable`,
  `network.allowedDomains`, `allowLocalBinding`, `filesystem.denyRead`) ; `failIfUnavailable: true` fait
  échouer la session si `bwrap` manque, ce que calmdev vérifie aussi avant de lancer.
- Différences connues : les motifs glob dans les chemins du bac à sable sont moins bien pris en charge sous
  Linux (calmdev n'en met pas dans `filesystem.denyRead`, seulement dans `permissions.deny`, qui ne dépend
  pas du bac à sable) ; `allowUnixSockets` ne s'applique pas sous Linux (calmdev ne s'en sert pas) ; un
  conteneur sans espaces de noms utilisateur (Docker non privilégié) empêche `bwrap` de démarrer.

## Ce qui n'a pas été vérifié faute de machine

1. Qu'une session lancée par calmdev démarre sous Linux avec ces réglages (bwrap présent).
2. Qu'une session refuse de démarrer quand bwrap manque (côté Claude Code, `failIfUnavailable`).
3. Qu'une lecture de `~/.ssh`, `~/.bashrc` échoue dans la session, et qu'une écriture dans le worktree passe.
4. Qu'une connexion sortante échoue, et qu'un domaine du plan (`plan.network`) passe.
5. Que `allowLocalBinding` laisse `node --test` ouvrir un port local.
6. Les lignes de commande des terminaux : tmux `new-window -c`, kitty `--directory`, gnome-terminal
   `--working-directory … --`, konsole `--workdir … -e`, xterm `-e` (formes connues, jamais lancées).
7. `install.sh` sous dash (le `sh` de Debian/Ubuntu) et `xdg-open` ; `run.sh` sans bash (passé en
   `#!/bin/sh`, son contenu était déjà POSIX). La commande d'installation de Claude Code qu'il affiche
   (`curl -fsSL https://claude.ai/install.sh | bash`) est écrite de mémoire, pas relue ici.
8. Le chemin des transcripts JSONL de Claude Code sous Linux (`~/.claude/projects/…`, supposé identique).
9. L'estimation d'usage (`lib/usage.mjs`) sous Linux, non touchée.

## La marche de test pour la première VM

```sh
sudo apt install -y git bubblewrap socat          # Ubuntu 24.04, ou dnf sur Fedora
# Node 22.13+ par nvm, puis Claude Code (commande officielle), puis `claude` une fois pour se connecter
git clone <dépôt> escadrille && cd escadrille
./install.sh --check                              # doit tout dire vert
node --test test/*.test.mjs                       # tout vert
./install.sh                                      # la page s'ouvre sur http://localhost:3078
# Un plan d'une session : demander « cat ~/.ssh/id_ed25519 » puis « curl https://example.com » : deux refus
sudo mv /usr/bin/bwrap /usr/bin/bwrap.off && ./run.sh   # la ligne de démarrage le dit ; lancer : refusé
sudo mv /usr/bin/bwrap.off /usr/bin/bwrap
# « Ouvrir dans un terminal » : une fenêtre dans tmux, puis hors tmux (kitty ou gnome-terminal)
```
