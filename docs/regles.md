# Les règles de calmdev

Les règles de `CLAUDE.md` dans le format de la pré-revue (`docs/prereview.md`) : une règle par puce ; un motif
entre accolades se vérifie sur le diff, une puce sans motif est lue par la revue.

## Règles

- Le serveur reste sans dépendance : il n'importe que `node:` et ses propres fichiers {deny: ^\s*import\b.*\bfrom\s+['"](?!node:|\.) in server.mjs, lib/**}
- Une dépendance (dans `phone/` seulement) se justifie par une ligne dans decisions.md {deps: package.json}
- Pas de secret dans le dépôt : ni clé, ni jeton, ni clé privée {deny: (sk-ant-[A-Za-z0-9]|ghp_[A-Za-z0-9]|github_pat_[A-Za-z0-9]|AKIA[0-9A-Z]+|BEGIN [A-Z ]*PRIVATE KEY|ExponentPushToken\[[^\]x])}
- Le serveur n'appelle aucun service externe : pas d'URL hors localhost dans le code du serveur {deny: https?://(?!127\.0\.0\.1|localhost|x\b|exp\.host) in server.mjs, lib/**}
- Une passation vit dans `.escadrille/` du worktree, jamais commitée {deny: . in .escadrille/**}
- Les captures et journaux d'essai d'une phase ne se réécrivent pas {immutable: docs/phase*-*.jpg, docs/phase*-essai-journal.json}
- Tout nouveau module de `lib/` a son test dans `test/` {requires-test: lib/**}
- Le port par défaut est 3078
- Node 22.13+ ; `node:http` et `node:sqlite` pour le serveur
- Aucune réponse au LAN sans jeton d'appareil (`docs/phone.md`)
- Le code est en anglais ; les textes de l'interface et les docs en français
- Pas de ligne de co-auteur dans les commits ; licence MIT
- Une session travaille dans son worktree et sa branche ; main ne bouge que par fusion
- Chaque écran : une action principale, le secondaire replié en une ligne, les détails à la demande
- Rien en production, aucun service externe au nom de Dev, rien qui lui soit facturé
- Une décision nouvelle de Dev s'ajoute, datée, à `docs/decisions.md` ; les lignes passées ne se réécrivent pas
- Un plan dit son budget par session et ses domaines réseau (vides par défaut)
- Une commande à autoriser se montre entière, au développeur comme au pilote, jamais coupée.

## Vérifications

- `node --test test/*.test.mjs`
