# La progression

Récompenser ce qui rend serein : relire, garder l'architecture, finir, économiser. Rien pour les lignes
écrites ni pour la présence. Pas de classement, rien qui clignote, une série qui ne culpabilise jamais.

Tout se calcule dans la base déjà là (`lib/game.mjs`, `levelOf(db)`), rétroactivement. Aucun suivi neuf.
`GET /api/game?project=` ; `'game': false` dans les réglages du projet coupe tout (lignes et toasts).

## Les points (XP)

| Action | XP | Lu dans |
|---|---|---|
| Session fusionnée | 10 | `sessions.worktree.merged` |
| Revue terminée | 15 (25 si stricte) | `reviews.verdict_at` |
| Fichier vu | 1 (20 au plus par revue) | `review_viewed` |
| Commentaire résolu | 3 | `review_comments.resolved` |
| Plan fini sous budget | 20 | coût des sessions ≤ somme des `budget` |
| Économie | 1 par 0,10 $ sous le budget (30 au plus par plan) | idem |
| Plan fini sans intervention | 10 | mesure de F (`unattended`) |
| Passation réussie | 5 | `handoffs` d'une session ensuite finie |
| Règle du dev | 5 | une puce de `docs/regles.md` du projet |

Les lignes de code : 0.

Les tokens du planificateur frugal ne sont pas en base : l'économie se compte en dollars sous budget.

## Les grades

| Grade | XP |
|---|---|
| Élève pilote | 0 |
| Pilote | 100 |
| Pilote confirmé | 250 |
| Chef de patrouille | 500 |
| Chef d'escadrille | 900 |
| Commandant | 1 500 |
| Chef d'escadre | 2 400 |
| Commandant de l'air | 3 600 |

## Les succès

| Succès | Gagné quand |
|---|---|
| Première escadrille | une escadrille créée |
| Première fusion | une session fusionnée |
| Nuit blanche pour Claude, pas pour toi | une session finie entre 0 h et 6 h |
| Premier regard | une revue terminée |
| Relecteur | 10 revues terminées |
| Exigeant | une revue stricte terminée |
| Gardien de l'architecture | une revue terminée avant la fusion de sa session |
| Rien en suspens | 10 commentaires résolus |
| Frugal | un plan fini sous 80 % de son budget |
| Pilote automatique | un plan fini sans intervention |
| Zéro rouge | 10 fusions sans session en erreur |
| Relais | une passation suivie d'une session finie |
| Règle d'or | une règle dans `docs/regles.md` |
| Escadre | un plan de 10 sessions fini |
| Régulier | une série de 7 jours |

Ternes tant qu'ils ne sont pas gagnés ; icône SVG au trait, pas d'émoji.

## La semaine

Trois quêtes, remises à zéro le lundi :

- Relis 3 revues.
- Finis un plan sous budget.
- Ajoute une règle à `docs/regles.md`.

La série : un jour compte s'il porte une action qui rapporte. Un jour sans action par semaine est gelé
d'office. Une série rompue repart à 1, sans message.

## À l'écran

Une ligne par endroit : en-tête (grade, barre, XP en chiffres monospace) ; accueil (dernier succès, la
grille au clic) ; plan (« +N XP » que ce plan rapporte) ; revue (« +15 XP en terminant ») ; téléphone (une
ligne dans Réglages). Un toast de 4 s à la fusion et au succès gagné, une fois.
