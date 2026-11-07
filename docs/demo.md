# La démo du logiciel vivant

Un prompt, une modification visible dans la page ouverte en moins de deux minutes, retirée d'un clic : de quoi montrer
en quelques minutes ce qu'est un logiciel qui change pendant qu'on le regarde (Dev, 2 novembre, soir). Le code :
`lib/demo.mjs` ; le branchement : trois lignes de `server.mjs`.

## Le déroulé

1. `POST /api/demo { prompt, model? }` crée la branche éphémère `escadrille/demo/<horodatage>` depuis la branche du
   dépôt d'Escadrille (main), dans le worktree `.claude/worktrees/demo-<horodatage>`.
2. Une session Claude Code y part avec le prompt (Sonnet par défaut, `model` le change ; 2 $ au plus), dans le bac à
   sable, outils de fichiers seulement (Read, Glob, Grep, Edit, Write, MultiEdit : ni Bash, ni réseau), consigne :
   ne toucher que `public/`, ne rien commiter, aller vite.
3. Le serveur regarde le worktree chaque seconde (`git diff` contre le départ, plus les fichiers nouveaux). Un fichier de
   `public/` ajouté ou modifié dans la branche est servi **par-dessus** celui du serveur (la surcouche) ; tout le reste
   vient de main. La surcouche suit les écritures en direct, sans attendre la fin de la session.
4. À chaque changement de la surcouche, le flux `/api/events` envoie l'événement `change` sur la clé `demo` ;
   `public/events.js` recharge alors la page ouverte.
5. Le statut passe à `live` dès qu'un fichier de `public/` est servi.

## Les routes (Mac seulement, comme les réglages : 403 depuis le LAN)

| Route | Réponse |
|---|---|
| `POST /api/demo { prompt, model? }` | `{ id, status: "preparing" }` ; 409 si une démo tourne déjà, 400 sans prompt ou si le modèle est inconnu |
| `GET /api/demo` | `{ on, id, prompt, model, status: preparing\|live\|failed, startedAt, endsAt, files, refused, error }` ; `{ on: false }` sans démo |
| `POST /api/demo/remove` | `{ ok: true, removed }` : la surcouche coupée, la session arrêtée, le worktree et la branche supprimés |

`files` : les fichiers de `public/` servis depuis la branche ; `refused` : ce que la session a écrit hors de `public/`.

## Le retrait

- « Retirer » (`POST /api/demo/remove`) : la surcouche tombe d'abord (la page suivante est celle de main, octet pour
  octet), la page se recharge, puis la session s'arrête, le worktree (`git worktree remove --force`) et la branche
  (`git branch -D`) s'effacent.
- Seul au bout d'une heure (`ESCADRILLE_DEMO_TTL_MS` pour les tests).
- Une démo laissée par un serveur arrêté n'est plus servie (l'état vit en mémoire) ; ses restes `escadrille/demo/*` sont
  effacés au lancement de la démo suivante.

## Ce qui est refusé

- Tout fichier hors de `public/` : jamais servi, listé dans `refused`. `server.mjs`, `lib/`, les garde-fous et la
  configuration ne sont donc jamais pris de la branche : le serveur qui tourne reste celui de main.
- `public/events.js` n'est jamais pris de la branche : c'est lui qui recharge la page, une démo qui le casserait
  empêcherait le retour.
- Un chemin qui sort de `public/` (`..`) ou un lien symbolique : refusés.
- Une seule démo à la fois.
- La démo ne fusionne jamais, ne pousse jamais, n'écrit rien dans la base : elle n'apparaît ni dans les plans, ni dans
  la file de revue, ni dans le journal.
