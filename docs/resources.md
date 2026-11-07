# Les ressources d'un projet

Phase 7, session O. L'écran 2 du flot d'un projet (décision « Le flot du produit », 09:20) : Conversation →
**Ressources** → Flot → Revue. Ce que le développeur donne au projet pour que les sessions travaillent mieux :
la mémoire, ses règles, les skills et plugins, les dossiers ajoutés, les connecteurs, les fichiers de données.
Tenu par `test/resources.test.mjs`.

**Le disque est la vérité.** Tout est lu à la demande dans le projet et dans `~/.claude/` ; rien n'est recopié en
base. Ce que l'écran ajoute va dans `<projet>/.escadrille/ressources/`, jamais commité (`.escadrille/` est déjà
dans `.git/info/exclude`, `docs/sessions.md`). Aucune installation depuis le réseau, aucun appel sortant.

## `lib/resources.mjs`

`resourcesOf(project, { home, settings })` rend :

```js
{
  project,                                   // chemin absolu
  memory:  { file, lines },                  // docs/decisions.md, sinon .escadrille/memoire.md ; lines : non vides ; file null s'il n'existe pas
  rules:   { file, count },                  // docs/regles.md (session Q) : count = les puces de « ## Règles » ; file null sinon
  skills:  [{ name, path, scope, description, enabled }],
           //  scope 'project' : <projet>/.claude/skills/<nom>/SKILL.md ; 'user' : ~/.claude/skills/<nom>/SKILL.md
           //  description : le champ du frontmatter ; enabled : faux si "Skill(<nom>)" est dans permissions.deny
           //  de <projet>/.claude/settings.json
  plugins: [{ name, enabled, file }],        // enabledPlugins de ~/.claude/settings.json puis du projet (le projet l'emporte)
  addDirs: [chemin],                         // le réglage du projet (docs/multiproject.md)
  connectors: [{ name, ready, why }],        // GitHub : le remote origin de .git/config est sur github.com ;
                                             // Linear : une clé est stockée pour le projet (lib/secrets.mjs, session A) ;
                                             // jamais la clé, seulement ready: true|false. Rien n'est appelé.
  files: [{ path, rel, kind, size, addedAt, note, added }]
           //  added: true : déposé par l'écran dans .escadrille/ressources/ ;
           //  added: false : trouvé dans le projet (tickets.md, backlog.md, *.csv, *.tsv à la racine, dans docs/ et data/)
           //  kind : 'text' | 'table' | 'image' | 'pdf' | 'other' (par l'extension)
}
```

Les notes vivent dans `<projet>/.escadrille/ressources/notes.json` : `{ "<rel>": { note, addedAt } }`, `rel` relatif
au projet. Un fichier trouvé peut aussi recevoir une note.

**Qui la lit**, affiché pour chaque ressource : la mémoire et les fichiers → le planificateur (liste dans son system
prompt) et les sessions (qui lisent les fichiers du projet) ; les règles → la pré-revue (Q) et le planificateur ; un
skill actif → les sessions et le planificateur ; les dossiers ajoutés → les sessions (`--add-dir`) ; un connecteur →
le serveur, au clic « Ouvrir la PR ».

## Les routes (du Mac seulement, 403 au LAN)

```
GET    /api/resources?project=/abs          → 200 resourcesOf(project) | 400 { error }
POST   /api/resources/file                  → 200 { ok, file: <entrée de files> } | 400 { error }
         JSON : { project, name, base64, note? }         un fichier déposé
                { project, name, text, note? }           un texte collé (name défaut « note-<date>.md »)
         20 Mo au plus une fois décodé (413 au-delà) ; corps lu jusqu'à 28 Mo
         nom nettoyé : le dernier segment seulement, [A-Za-z0-9._ -] gardés (accents retirés), pas de point en
         tête, 120 caractères ; refusé (400) s'il reste vide, '.', '..', ou s'il contenait '/', '\', '..' ou un
         caractère de contrôle ; un nom déjà pris reçoit « -2 », « -3 »…
POST   /api/resources/note { project, path, note }   path : rel d'une entrée de files ; note : une ligne, 300 car. au plus
         → 200 { ok } | 400 { error }
DELETE /api/resources/file?project=&path=   seulement un fichier de .escadrille/ressources/ (sa note part avec) ;
         → 200 { ok } | 400 { error } pour tout autre chemin
POST   /api/resources/skill { project, name, enabled, confirm? }
         sans confirm : → 200 { ok: false, preview: { file, line, action: 'add' | 'remove' } } (rien n'est écrit)
         confirm: true : écrit "Skill(<nom>)" dans permissions.deny de <projet>/.claude/settings.json (désactiver)
                         ou l'en retire (activer), le reste du fichier intact → 200 { ok: true, file, line }
GET    /api/resources/skill?project=&name=        → 200 { name, path, scope, description, enabled, text } (SKILL.md, 50 ko au plus)
POST   /api/resources/plugin { project, name, enabled, confirm? }   name : nom@marketplace ; écrit enabledPlugins[name],
         même aperçu sans confirm
GET    /api/resources/capabilities?project=       → 200 { rule, items: [{ id, kind, name, what, why, score, how,
         activate: { type: 'plugin' | 'skill', name } | null, network, source }] } (ci-dessous)
```

Le multipart n'est pas pris : la page lit le fichier (`FileReader`) et l'envoie en base64. Une seule forme, moins de
code, et 20 Mo restent raisonnables sur localhost.

## Les capacités à ajouter (demande de Dev, 09:25)

« Avoir accès à un top des capacités à ajouter à Escadrille. » Une ligne repliée de l'écran, « Capacités à ajouter » :
dix au plus, des skills, plugins, serveurs MCP ou connecteurs utiles à ce projet. Chacune dit son nom, ce qu'elle
apporte, pourquoi elle est classée là et comment l'activer.

**Les sources, toutes locales, sans réseau :**

- `catalog/capabilities.json`, écrit à la main dans le dépôt : 21 entrées connues (Playwright MCP, GitHub MCP,
  Linear MCP, Sentry, Postgres, Supabase, Prisma, le taste skill, Frontend design, les LSP TypeScript et Python, Expo,
  Stripe, Context7, Chrome DevTools, Code review, Semgrep, Figma, Notion, PostHog, Skill creator). Chaque entrée :
  `{ id, kind, name, what, plugin?, skill?, how, match: { words, deps, files, langs, tickets?, remote? } }` ;
- les manifestes des marketplaces déjà sur le Mac (`~/.claude/plugins/marketplaces/*/.claude-plugin/marketplace.json`) :
  ils disent qu'un plugin est disponible ici, et font entrer un plugin hors catalogue quand une dépendance ou un des
  trois langages principaux du projet le nomme (`stripe`, `prisma`, `typescript-lsp`…) ;
- les propositions d'installation des planificateurs du projet (messages `role = 'install'`) ; une proposition
  qu'aucune entrée ne couvre entre telle quelle ;
- le journal des sessions du projet : leurs demandes d'autorisation (`session_messages`, rôle `ask`) et les refus.

Les signaux du projet sont lus sur le disque : les langages par extension (trois niveaux, 4 000 entrées au plus, sans
`node_modules`, `.git`, `dist`…), les dépendances (`package.json`, `requirements.txt`, `pyproject.toml`, `Gemfile`,
`go.mod`, `Cargo.toml`), les fichiers et dossiers de la racine, les identifiants de tickets (`tickets.md`, `backlog.md`)
et le remote `origin`.

**La règle, une addition :**

| Signal | Points |
| --- | --- |
| un planificateur du projet l'a proposée | +3 |
| une session du projet l'a demandée, ou s'est vu refuser une commande qui la nomme | +3 |
| un fichier du projet l'appelle (une dépendance, un fichier, des tickets, le remote) | +2 |
| le langage du projet est l'un des siens | +1 |
| elle est déjà sur le Mac (marketplace présente, ou installée et éteinte ici), en plus d'un autre signal | +1 |

Ce qui est déjà actif n'est pas listé (c'est déjà une ressource) ; un score nul non plus. Tri par score, puis par nom ;
dix au plus. La raison affichée reprend les signaux trouvés (« proposé par le planificateur ; dépendance stripe »).

**Activer reste un clic avec confirmation ; rien ne s'installe depuis le réseau sans Dev.** Une capacité installée et
éteinte pour le projet (un plugin à `false`, un skill refusé) a un bouton « Activer » : le serveur montre la ligne qu'il
écrira dans `.claude/settings.json`, puis l'écrit après « Confirmer ». Les autres montrent la commande à lancer
soi-même (`/plugin install …`, `claude mcp add …`), marquée « réseau » ; le serveur ne la lance jamais.

## Le planificateur

`systemPromptFor(e)` ajoute, après la mémoire, une section courte (40 lignes au plus, aucun contenu de fichier) :

```
## Les ressources du projet

- mémoire : docs/decisions.md (412 lignes)
- règles : docs/regles.md (17)
- skill plan : .claude/skills/plan/SKILL.md, The Escadrille planning run…
- fichier .escadrille/ressources/tickets-q4.csv : les tickets du trimestre
- dossier ajouté : ~/Dev/shared
- connecteur GitHub
```

Seuls les skills du projet actifs y sont (ceux de `~/.claude/skills/`, Claude Code les donne déjà) ; au-delà de 40 lignes, une dernière ligne « … et N autres (écran Ressources) ».
Rien quand le projet n'a aucune ressource.

## L'écran `/resources?project=`

`public/resources.html`, même coque que les autres (`app.css`). L'action principale : **Ajouter** (déposer un fichier
ou coller un texte, avec une note d'une ligne : à quoi il sert). Dessous, une ligne repliée par famille, avec son
compte : « Mémoire · 42 lignes », « Règles · 9 », « Skills · 3 », « Plugins · 2 », « Dossiers · 1 »,
« Fichiers · 5 », « Connecteurs · GitHub », « Capacités à ajouter · 10 ». Une ressource ouverte montre son chemin, sa note, qui la lit. Un skill
s'ouvre sur sa description et son `SKILL.md` (lecture), et un interrupteur Actif / Inactif qui montre la ligne écrite
avant de confirmer. La navigation du projet tient en une ligne dans la barre du haut (`public/projnav.js`, aussi sur l'accueil) :
Conversation · Ressources · Flot · Revue. Flot mène à `/flow.html` quand la page existe, sinon au dernier plan du
projet ; Revue à `/review.html` quand elle existe, sinon le mot reste grisé, à sa place.

## Les limites

- `ESCADRILLE_HOME` remplace le dossier personnel pour la lecture de `~/.claude/` (les tests s'en servent).

- Le planificateur voit la liste, pas les fichiers : il les lit lui-même s'il en a besoin (le hook frugal s'applique).
- Désactiver un skill passe par `permissions.deny` (`Skill(<nom>)`) : la session ne peut plus l'appeler ; le skill
  reste sur le disque.
- Un serveur lancé dans le bac à sable d'une session ne lit pas `~/.claude/` : les skills et plugins de l'utilisateur
  y sont vides (même limite que `docs/access.md`).
