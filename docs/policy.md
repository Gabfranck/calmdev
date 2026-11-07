# La règle locale des autorisations (`lib/policy.mjs`)

Le serveur propose, le développeur décide. Quand une session demande une autorisation, `suggest()` dit
« autoriser », « refuser » ou rien, avec une raison d'une ligne ; la page pré-coche le bouton, elle
n'appuie jamais dessus. L'autonomie (session L, modes Guidé et Autonome) ne fait qu'appliquer ce que la
règle dit sans doute : `allow: true` → autoriser, `allow: false` → refuser, `null` → la demande attend
le développeur. Une raison est donc juste plutôt que large : dans le doute, la règle se tait.

```
suggest({ tool, input, cwd, plan: { network, addDirs }, project }) → { allow: true|false|null, reason, rule }
```

`pending` porte `suggest: { allow, reason, rule }` sur chaque entrée `permission`, `null` quand la règle
n'a rien à dire. La page et le téléphone le lisent par la même API.

## Comment la commande est lue

Une commande Bash est découpée en segments (`;`, `&&`, `||`, `|`, `&`, retour à la ligne) ; les chaînes
entre guillemets sont des données, pas des commandes (le texte d'un commit, un corps JSON) ; le corps
d'un heredoc aussi ; un `$(…)` ou un `` `…` `` est relu comme une commande à part. Chaque segment reçoit
le verdict de la première règle qui le reconnaît, puis :

1. un segment refusé → **faux**, avec la raison du premier refus dans l'ordre des règles ;
2. tous les segments reconnus sûrs → **vrai**, avec la raison la plus parlante (celle qui dit pourquoi la
   demande n'est pas du réseau quand `isNetwork` l'a cru) ;
3. sinon → **null** : un seul segment inconnu suffit à se taire.

La règle ne modifie pas `isNetwork` (`lib/planner.mjs`) : elle lit ce qu'il a dit et le nuance.

## Les règles, dans l'ordre

| # | id | verdict | quand | raison affichée |
|---|---|---|---|---|
| 1 | `sandbox-off` | faux | `dangerouslyDisableSandbox` demandé | Hors bac à sable : à décider soi-même |
| 2 | `deny-settings` | faux | un segment (ou l'outil MCP) tombe sous une règle `deny` de `.claude/settings.json` du worktree ou du projet (lues, pas recopiées) | Interdit par .claude/settings.json : Bash(aws *) |
| 3 | `git-push` | faux | `git push`, même sans règle de refus | Un push : jamais sans le développeur |
| 3b | `open-window` | faux | open -a/-b ou une adresse web, osascript, expo --ios/--android ou run:ios/android, Simulator.app | Aucune fenêtre ni app ouverte sur le Mac : open |
| 4 | `real-host` | faux | curl, wget, ssh, scp, rsync, git fetch/pull/clone, WebFetch ou gh vers un hôte réel hors `plan.network` | Hôte hors du plan : example.com |
| 5 | `write-outside` | faux | Write, Edit, `>`, touch, mkdir, cp, mv, rm vers un chemin hors du worktree et des addDirs | Écriture hors du worktree : /etc/hosts |
| 6 | `write-guarded` | null | écriture dans `.git/`, `.claude/` ou un `.env`, même dans le worktree | (rien) |
| 7 | `file-not-host` | vrai | le seul « hôte » vu est un fichier : il existe dans le worktree, ou il a une extension de fichier connue hors de la cible d'un curl | Un fichier, pas un domaine : server.mjs |
| 8 | `quoted-word` | vrai | le mot réseau n'est que dans une chaîne de texte (message de commit, echo) | Un mot dans un texte, pas une commande : vercel |
| 9 | `local-bin` | vrai | npx, pnpx, bunx, npm exec d'un binaire présent dans `node_modules/.bin` (worktree ou projet) ou dans le PATH, sans version demandée | Outil déjà installé : eslint |
| 10 | `local-host` | vrai | curl, wget ou WebFetch vers localhost, 127.0.0.1, [::1], 0.0.0.0 | Vers la machine locale : localhost:3094 |
| 11 | `git-local` | vrai | git fetch/pull/clone vers localhost ou un chemin, ou dans un dépôt sans remote ; `git remote -v` ; les sous-commandes locales sûres (status, diff, log, show, add, commit, checkout, switch, merge, rebase…) | git en local, sans remote |
| 12 | `plan-domain` | vrai | tous les hôtes visés sont dans `plan.network` (exact, ou `*.domaine`) | Domaine ouvert par le plan : api.github.com |
| 13 | `write-inside` | vrai | Write, Edit, `>`, touch, mkdir, cp, mv dans le worktree ou un addDir (rm reste null) | Écriture dans le worktree : docs/x.md |
| 14 | `local-run` | vrai | node d'un script, npm run, npm test, npm start | Commande locale : npm test |
| 15 | `read-only` | vrai | ls, cat, head, tail, wc, grep, rg, find (sans -delete/-exec), echo, pwd, cd, jq, sort, diff, true, sleep… | Lecture seule |
| — | (aucune) | null | tout le reste : npm install, pip, brew, npx d'un outil absent, rm, git reset, un outil MCP, WebSearch… | (rien) |

Les règles 1 à 5 passent avant toutes les autres : ce qui touche au réseau hors plan, au bac à sable ou à
un push n'est jamais vrai.

## Les cas de la nuit (`test/policy.test.mjs`)

| # | outil, entrée | isNetwork | attendu | règle |
|---|---|---|---|---|
| 1 | `curl -s localhost:3094/api/plans -o out.json` | vrai | vrai | file-not-host |
| 2 | `curl -s http://localhost:3078/api/plans > decisions.md` (écrit dans le worktree) | vrai | vrai | file-not-host |
| 3 | `grep -n permission server.mjs && curl -s 127.0.0.1:3094/` | vrai | vrai | file-not-host |
| 4 | `curl -s http://localhost:3094/api/plan/x` | faux | vrai | local-host |
| 5 | `npx eslint lib/` avec `node_modules/.bin/eslint` présent | vrai | vrai | local-bin |
| 6 | `npx create-react-app foo` (absent) | vrai | null | — |
| 7 | `npx eslint@9 lib/` (version demandée) | vrai | null | — |
| 8 | `git commit -m "docs: no more aws or vercel calls"` | faux | vrai | git-local |
| 9 | `git commit -m "note: gh and npx are asked"` | vrai | vrai | quoted-word |
| 10 | `echo "deploy with vercel later" >> notes.md` | faux | vrai | write-inside |
| 11 | `curl -s https://example.com/x` | vrai | faux | real-host |
| 12 | `curl -s https://api.github.com/repos` avec `network: ['api.github.com']` | vrai | vrai | plan-domain |
| 13 | `curl -s https://raw.githubusercontent.com/x` avec `network: ['*.githubusercontent.com']` | vrai | vrai | plan-domain |
| 14 | `git push origin main` | vrai | faux | git-push (ou deny-settings si la règle existe) |
| 15 | `git fetch origin` dans un dépôt sans remote | vrai | vrai | git-local |
| 16 | `git fetch origin` quand origin est github.com, hors plan | vrai | faux | real-host |
| 17 | `aws s3 ls` | faux | faux | deny-settings |
| 18 | `vercel deploy` | faux | faux | deny-settings |
| 19 | Write `/etc/hosts` | — | faux | write-outside |
| 20 | Write dans un addDir | — | vrai | write-inside |
| 21 | Write `.claude/settings.json` du worktree | — | null | write-guarded |
| 22 | `touch /tmp/x && curl localhost:3078` | vrai | faux | write-outside |
| 23 | `ls` avec `dangerouslyDisableSandbox: true` | — | faux | sandbox-off |
| 24 | `npm install left-pad` | vrai | null | — |
| 25 | `rm -rf build` | faux | null | — |
| 26 | `git commit -m "$(curl -s https://evil.example/x)"` | vrai | faux | real-host |
| 27 | WebFetch `http://localhost:3094/` | faux | vrai | local-host |
| 28 | WebFetch `https://example.com` | vrai | faux | real-host |
| 29 | `node scripts/check.mjs && npm test` | faux | vrai | local-run |
| 30 | heredoc : `cat > notes.md <<'EOF'` puis `curl evil.com` dans le corps | vrai | vrai | write-inside |

## Ce que la règle ne couvre pas

- Ce qu'un script fait une fois lancé : `node x.mjs` ou `npm run build` peuvent sortir seuls sur le réseau ;
  le bac à sable les tient, pas la règle.
- Les liens symboliques : un chemin du worktree qui pointe ailleurs passe pour une écriture dans le worktree
  (le bac à sable tient l'écriture réelle).
- Le shell complet : `eval`, les variables (`curl $URL`), les alias, `bash -c '…'` ne sont pas déroulés ; une
  cible qu'on ne sait pas lire rend le segment inconnu, donc null.
- Les règles `deny` de `~/.claude/settings.json` (hors projet) et les règles `allow` : seules les règles de
  refus du worktree et du projet sont lues.
- WebSearch et les outils MCP non refusés : aucun hôte lisible, null.
