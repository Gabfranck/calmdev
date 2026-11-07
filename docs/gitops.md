# Les lignes GIT: (gestes git d'une session, hors du bac)

Le 3 novembre sur Harbor, le bac à sable a interdit aux sessions de commiter, de brancher et de fusionner dans le git
des sous-modules ; le pilote l'a fait une dizaine de fois à la main, réveillé à chaque fois. Une ligne `GIT:` seule
sur sa ligne, dans le message d'une session, demande ce geste au serveur : il l'exécute hors du bac, dans le dépôt de
la session seulement, le journalise et rend le résultat en tête du message suivant. Il ne pousse jamais rien.

Code : `lib/gitops.mjs` (sur le modèle de `lib/docker.mjs`), test : `test/gitops.test.mjs`, branchement : `server.mjs`.

Toute fusion d'une branche de session (bouton, tests verts, revue) passe d'abord ses lignes ajoutées par
`lib/mergeprivacy.mjs` (la règle de `lib/privacy.mjs`, celle du bouton de push) : une trace privée refuse la fusion
avec `fichier:ligne (genre)` et le chemin qui marche (docs/publication.md).

Un worktree de session ne se supprime que par `worktree.remove()` (`lib/worktree.mjs`), qui copie d'abord son `.escadrille/` non commité dans `<racine>/.escadrille/archive/<nom du worktree>/` (suffixe horodaté si le dossier existe ; une copie ratée est journalisée et n'empêche pas la suppression). L'archive ne garde que ce qui sert à reprendre : elle laisse les copies d'arbre (`before/`, `*-base*`, `tri-trees/`, `public-solo*`, `node_modules`, tout dossier avec un `package.json` ou un `server.mjs` à sa racine) et tout fichier de plus de 5 Mo, et écrit en tête un `LAISSE.txt` qui dit en une ligne chacun ce qui a été laissé et pourquoi.

## Le contrat

Une ligne seule, éventuellement précédée de `>`, `-` ou `*` :

```
GIT: [-C <chemin>] <verbe> <arguments>
```

| Verbe | Forme | Ce que le serveur lance |
| --- | --- | --- |
| commit | `commit -m "<message>"` · `commit -a -m "<message>"` · `commit -m "<message>" <chemin>…` | `git commit -m <message> [-a]` · avec des chemins : `git add -- <chemins>` puis `git commit -m <message> -- <chemins>` (un fichier neuf passe, le bac interdit `git add` à la session) |
| branch | `branch <nom> [<depuis>]` | `git branch <nom> [<depuis>]` |
| switch | `switch <branche>` | `git switch <branche>` |
| merge | `merge --no-ff <branche>` · `merge --ff-only <branche>` | `git merge --no-ff --no-edit <branche>` · `git merge --ff-only <branche>` |

- `-C <chemin>` est relatif au worktree de la session et vise un sous-module (ou tout dossier du worktree) ; sans lui,
  le geste vise la racine du worktree.
- Le message de commit tient entre guillemets doubles (`\"` pour un guillemet) ; il ne porte jamais de ligne
  `Co-Authored-By` : le serveur l'enlève s'il y en a une (CLAUDE.md).
- Au plus 4 lignes `GIT:` par tour (`MAX_PER_TURN`), exécutées dans l'ordre, une à la fois par worktree (la file de
  `createQueue`) : un `commit` puis un `merge` du même tour se suivent.
- Chaque commande a un délai (30 s) et sa sortie est coupée aux 60 dernières lignes, masquées comme celles de Docker.
- Le résultat revient en tête du message suivant : `GIT <commande> (<dépôt>) : ok (code 0)` ou `refusé : <raison>`,
  puis les lignes de sortie.
- Une ligne au journal du pilote par geste : session, dépôt, commande entière, code de sortie.

## Les refus (la raison en une ligne)

- Tout verbe hors de la liste : `push`, `fetch`, `pull`, `remote`, `reset`, `clean`, `rebase`, `worktree` (un
  `git worktree prune` a cassé git pour six sessions du Studio le 3 novembre), `checkout`, `config`, `tag`, `stash`…
- Toute option hors de la forme ci-dessus (`--force`, `-D`, `--amend`, `--no-verify`, `-c`, `--git-dir`, `--exec-path`…),
  tout nom de branche qui commence par `-` ou n'est pas un nom de ref valide.
- Tout `-C` qui sort du worktree : le chemin est résolu par `realpath` (liens symboliques compris) et doit rester sous
  le `realpath` du worktree ; un chemin absolu, `..` qui sort, ou un dossier absent sont refusés.
- Tout dossier qui n'est pas la racine d'un dépôt git (le geste ne remonte jamais vers un dépôt parent).
- `main` et `master` partout, sous-modules compris (le pilote, 3 novembre) : pas de `commit` ni de `merge` quand la
  branche courante est l'une d'elles, pas de `switch` vers elles, pas de `branch main`. Fusionner dans main reste le
  geste du pilote après les tests ; Harbor fusionne en local sur sa branche de ticket ou sur `dev`. Lire main reste
  permis (`branch x main`, `merge --no-ff main` dans une branche de ticket). Une HEAD détachée refuse aussi commit et merge.
- Un chemin de commit absolu, qui commence par `-` ou `:`, ou qui sort du dépôt par `..`.
- Une config du dépôt (portée `local` ou `worktree`) qui ferait lancer un programme à git : `filter.*`,
  `core.hooksPath`, `core.fsmonitor`, `core.editor`, `core.pager`, `core.sshCommand`, `diff.*.textconv`,
  `merge.*.driver`, `include*`, `alias.*`, `credential.*`… La session peut écrire `.git/` : sans ce refus, un geste
  hors du bac lancerait un programme qu'elle a choisi.
- Une ligne sans worktree connu (session sans worktree) : refusée, rien ne s'exécute à la racine du projet.

Toujours, en plus : `git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgSign=false`, aucune
variable `GIT_*` héritée, `GIT_EDITOR=true`, `GIT_TERMINAL_PROMPT=0`. Les hooks du projet (husky, pre-commit) ne
tournent donc pas sur ces commits : la session lance ses vérifications elle-même avant de demander le commit.

## Brancher un verbe de plus

1. Ajoute le verbe à `VERBS` dans `lib/gitops.mjs` (et retire-le de `FORBIDDEN` s'il y est) et sa forme dans
   `plan(words)` : il rend `{ steps: [argv…], show, head? }` (les argv exacts, `head: true` si le geste écrit sur la
   branche courante, qui ne doit pas être main ni master) ou `{ error }`. Jamais de texte de la session passé tel quel : chaque mot est vérifié.
2. Ajoute un cas réussi et un cas refusé dans `test/gitops.test.mjs`.
3. Ajoute la ligne au tableau ci-dessus et, si la consigne change, à `INSTRUCTION` (une phrase).

Pour un autre préfixe que `GIT:` (la future ligne `TEST:`), réutilise le canal : `parseLines(prefix, text, state)`
pour lire les lignes d'un tour, `createQueue` de `lib/docker.mjs` pour la file, et dans `server.mjs` le même
branchement que `gitOps.ofTurn` (onNote → message système + `captureNotes`, onIdle → `resumeAfterCaptures`,
`record` → journal du pilote).
