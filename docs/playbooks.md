# Les playbooks

L'idée de Dev (09:05) : « moteur gratuit, mais on fait payer des playbooks ou guides d'escadrille : des
automatisations bien pensées par l'outil, avec les bases qu'on a avec Orchard et ses données business, pour
proposer des startups prêtes à être testées commercialement en quelques clics de config ».

État : **format et brouillon seulement.** Rien n'est vendu, publié ni branché au serveur ; aucune donnée
d'Orchard dans ce dépôt.

## Gabarit ou playbook

| | Gabarit (`plans/templates/<id>.json`, session H) | Playbook (`playbook.json` et ses actifs) |
|---|---|---|
| Ce qu'il porte | une idée à trous et des consignes pour le planificateur | plusieurs plans enchaînés en vagues, des actifs, un formulaire, un critère « prêt » et des métriques |
| Ce qu'il produit | **un** plan d'escadrille | un produit entier, prêt à montrer à des clients |
| Taille | 20 lignes de JSON | un dossier : le JSON, un squelette d'app, des pages, des textes, des tickets |
| Prix | gratuit, MIT, dans le dépôt | payant, hors du dépôt public (sauf l'exemple anonyme) |
| Qui l'écrit | n'importe qui, la communauté | Dev, à partir de ce qui a marché pour de vrai (Orchard) |

Un playbook **réutilise** les gabarits : un de ses plans peut être `{ "template": "passe-design" }` au lieu d'une
idée écrite. Le gabarit reste la brique gratuite ; le playbook, c'est l'assemblage pensé, les actifs et le savoir.

## Ce qu'il y a dans un playbook

```
 formulaire (2 min)      vague 1           vague 2              vague 3            vague 4         prêt ?
 ┌───────────────┐   ┌─────────────┐   ┌────────────────┐   ┌──────────────┐   ┌───────────┐   ┌────────────────┐
 │ nom, cible,   │──▶│ socle (API, │──▶│ app prof       │──▶│ paiement     │──▶│ lancement │──▶│ landing locale │
 │ langue, prix, │   │ données,    │   │ app élève      │   │ en mode test │   │ (vérifie  │   │ paiement test  │
 │ couleurs,     │   │ seed)       │   │ analytics      │   │ passe design │   │  ready)   │   │ analytics      │
 │ domaine…      │   │ landing     │   │ locales        │   │ (gabarit)    │   │           │   │ 10 interviews  │
 └───────────────┘   └─────────────┘   └────────────────┘   └──────────────┘   └───────────┘   └────────────────┘
                       chaque plan = une escadrille (ses sessions, ses arrêts, son budget) ; edu-quiz : 143 $
```

Le format est `playbooks/format/playbook.schema.json` ; `lib/playbooks.mjs` (`validatePlaybook`) l'applique sans
dépendance, avec les règles qu'un schéma ne sait pas dire. `node lib/playbooks.mjs <playbook.json>` valide un
fichier ; `test/playbooks.test.mjs` valide l'exemple et, s'il est sur la machine, le playbook privé.

| Champ | Ce que c'est | Règle vérifiée |
|---|---|---|
| `id`, `title`, `version`, `status`, `license` | identité ; `license` vaut `example` (dépôt public) ou `proprietary` (payant) | slug, x.y.z |
| `promise` | une phrase : ce que l'acheteur a à la fin | une seule phrase, 200 caractères |
| `audience` | pour qui | — |
| `price` | indicatif : `{ amount, currency, model, note }`, `model` parmi `one-time`, `subscription`, `revenue-share`, `free` | — |
| `config` | le formulaire : `{ key, label, kind, default }`, `kind` parmi texte, choix, langue, prix, couleur, domaine, nombre, oui/non | clés uniques ; le défaut va avec son genre |
| `plans` | `{ id, template \| idea, after, budget, domains? }` ; `{{clé}}` reprend la config | un seul de `template` ou `idea` ; `after` connu ; pas de cycle ; budget en dollars par plan ; `domains` vide par défaut |
| `assets` | `{ path, kind, state }` : squelette, schéma, page, textes, tickets, checklist, tableau de bord, seed, doc | chemin relatif au playbook ; un actif `ready` doit exister |
| `ready` | les critères « prêt à tester commercialement », chacun vérifiable : `file`, `command`, `url`, `count` | une URL n'est que `localhost` (rien en production) |
| `metrics` | ce qu'on suit pour décider : `{ key, label, unit, source, target }` | clés uniques |
| partout | — | aucune clé (Stripe, GitHub, Anthropic, Linear, Slack), aucune adresse mail réelle, aucun chemin personnel (`~/…`) |

**« Prêt à tester commercialement »**, c'est : la landing répond en local, un parcours de paiement de bout en
bout en mode test (simulé en local par défaut ; les clés de test Stripe du développeur s'il les met lui-même),
des analytics locales qui reçoivent les événements, une seed synthétique qui montre chaque état d'abonnement,
des textes légaux en brouillon marqués « à faire relire », et une liste d'au moins dix interviews clients à
faire avec leur guide. Pas de mise en ligne : le playbook s'arrête à la porte, le développeur l'ouvre.

## Le modèle économique

Le moteur reste MIT et gratuit (décision du 1er novembre). Ce qui se paie : le temps gagné et le savoir d'un
produit qui a déjà eu des clients. Trois façons de le faire payer :

| Modèle | Pour | Contre |
|---|---|---|
| **À l'unité** (≈ 79 à 149 € le playbook, mises à jour un an) | simple à comprendre, une seule vente suffit à tester ; pas d'infrastructure | revenu ponctuel ; copie facile une fois acheté |
| Abonnement (≈ 19 €/mois, tout le catalogue) | revenu récurrent, pousse à sortir un playbook par mois | il faut un catalogue avant ; un abonnement sans catalogue déçoit |
| Partage de revenus (x % du chiffre de la startup) | aligné sur le succès | invérifiable sans accès aux comptes, contrat lourd, juridiquement coûteux |

Ma recommandation : **à l'unité d'abord**, un seul playbook, vendu à la main à quelques développeurs une fois
que Dev l'a lui-même passé de bout en bout ; l'abonnement quand il y en a trois. Le partage de revenus, non.

Le coût pour l'acheteur s'ajoute : le playbook tourne sur **son** abonnement Claude. Le brouillon d'`edu-quiz`
annonce 143 $ d'API au tarif public pour ses huit plans ; il faut que ce chiffre soit dit avant l'achat.

### Les risques

- **La licence.** Le moteur est MIT : n'importe qui peut écrire ses playbooks, et un playbook acheté se copie.
  La valeur ne peut donc pas être le format (il est public), seulement le contenu et sa mise à jour. Le
  playbook payant a sa propre licence (usage par l'acheteur, pas de revente) ; le code **généré** appartient à
  l'acheteur. Point à noter : l'API d'Orchard est déjà sous MIT (`LICENSE.md`, au nom de son auteur) ; la copier
  dans un actif payant n'a pas de sens, le squelette doit être neuf.
- **Ce qui peut sortir d'Orchard.** Oui : l'architecture (API, app prof, app élève, landing, analytics à côté),
  la taxonomie d'événements, les états d'abonnement à tester, la forme de la checklist de QA, la forme du
  système design, le découpage en tickets. Non : la marque (nom, logo, violet, avatars), les contenus
  (questions, articles, textes légaux tels quels), **toute donnée d'élève ou de prof**, même anonymisée (la seed
  de dev vient de la production, et ce sont des mineurs), les clés, les chiffres de revenus et de conversion.
  Des fourchettes agrégées seulement si Dev le décide (question 2).
- **Le support.** Un playbook qui casse chez l'acheteur, c'est du support. Le critère « prêt » vérifiable et un
  passage complet par Dev avant chaque version le réduisent ; une page « limites connues » par playbook.
- **La qualité.** Un playbook ne se vend que s'il a été joué de bout en bout sur une machine vierge, critères
  `ready` tous verts ; sinon il reste `draft`. Rembourser sans discuter si ce n'est pas le cas.
- **L'encaissement.** Vendre, c'est l'entité, Stripe, des CGV (`docs/avenir.md` §3.2) : rien de ça n'est fait, et
  aucune session ne le fera. « Rien en production » tient.

## La frontière entre le dépôt public et les playbooks privés

| Dans le dépôt public (MIT) | Hors du dépôt (privé, payant) |
|---|---|
| `playbooks/format/` (le schéma), `lib/playbooks.mjs`, ses tests, cette doc | `~/.escadrille/playbooks/<id>/playbook.json` et ses actifs |
| `playbooks/examples/` : un exemple **anonyme et réduit**, `license: "example"`, gratuit | plus tard, un dépôt GitHub **privé** à part (`escadrille-playbooks`), si Dev le crée |
| les gabarits gratuits `plans/templates/` | les chiffres éventuels tirés d'Orchard |

Le test `the public repository only holds the format and anonymous examples` garde la frontière : `playbooks/` ne
contient que `format/` et `examples/`, chaque exemple est `example`, rien n'y est vendu, le nom d'Orchard n'y
apparaît pas. Le validateur refuse les clés, les adresses et les chemins personnels partout.

Ce qui manque au moteur pour jouer un playbook (pas fait, phase à venir) : lire `~/.escadrille/playbooks/`, montrer
le formulaire, créer les plans dans l'ordre des vagues (`playbookWaves`), lancer la vague suivante quand la
précédente est fusionnée, puis vérifier `ready`.

## Le premier brouillon

`~/.escadrille/playbooks/edu-quiz/` : « Une startup éducative de quiz à partir d'Orchard ». Huit plans en quatre
vagues, douze champs de config, huit critères `ready`, douze métriques ; `SOURCES.md` dit pour chaque actif ce
qui vient d'Orchard (la forme) et ce qui n'en vient pas (le reste). L'exemple réduit du dépôt est
`playbooks/examples/quiz-de-classe.json`.

## Questions pour Dev

1. Le prix : **[x] à l'unité, ≈ 99 €, mises à jour un an** · [ ] abonnement au catalogue · [ ] partage de revenus.
2. Ce qui sort d'Orchard : **[x] la forme seulement (architecture, événements, états d'abonnement), aucun chiffre** · [ ] plus des fourchettes de conversion agrégées.
3. Le squelette d'app : **[x] neuf, écrit par le playbook à partir de la forme d'Orchard** · [ ] extrait du code d'Orchard (déjà MIT, donc sans valeur de vente).
4. Où vivent les playbooks : **[x] `~/.escadrille/playbooks/` en local, un dépôt privé quand il y en a deux** · [ ] un dépôt privé dès maintenant.
5. Avant de vendre : **[x] Dev joue `edu-quiz` de bout en bout et fait cinq interviews de développeurs acheteurs** · [ ] vendre le brouillon en prévente.
