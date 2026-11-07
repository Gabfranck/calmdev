# Les modèles

La liste des modèles n'est écrite nulle part à la main : `lib/models.mjs` la construit au démarrage du serveur
et à chaque `GET /api/models`. Décision de Dev, 2026-11-01 08:55 : les nouveaux modèles s'ajoutent seuls, et à
terme n'importe quel modèle, local compris.

## D'où elle vient

1. **Les transcriptions de Claude Code** (`~/.claude/projects`, champ `message.model`) : tout modèle `claude-*`
   vu apparaît, sans date ni suffixe de contexte. Seule la fin des 80 fichiers les plus récents (30 jours) est lue :
   le scan complet de `lib/usage.mjs` prend plusieurs secondes sur un gros dossier, et le démarrage n'attend pas.
2. **Le repli, dans le code** : les clés de la table des prix de `lib/usage.mjs` (Fable 5.1, Opus 5.5, Sonnet 5.5,
   Haiku 5.5). Le défaut est **Opus 5.5** (Fable est presque épuisé).
3. **Le fichier local `~/.escadrille/models.json`** (`ESCADRILLE_MODELS` pour un autre chemin), jamais dans le dépôt :

```json
{
  "default": "claude-sonnet-5-5",
  "hide": ["claude-haiku-5-5"],
  "add": [
    { "id": "claude-next-1", "name": "Next", "price": { "input": 1, "output": 5, "cacheRead": 0.1 } },
    { "id": "llama3.2", "provider": "ollama", "baseUrl": "http://localhost:11434" },
    { "id": "mon-modele", "name": "Mon modèle", "provider": "openai-compatible", "baseUrl": "http://localhost:8000/v1" }
  ]
}
```

`add` ajoute ou complète un modèle (nom, prix), `hide` le retire, `default` choisit le défaut. Un fichier absent
ou illisible ne change rien. Un `provider` autre que `claude` est listé avec `available: false` et la raison
« pas encore d'adaptateur » : il ne se lance pas tant que l'adaptateur de `docs/avenir.md` (ligne 11) n'existe pas.

## Ce que le serveur en fait

- `GET /api/models` → `{ models: [{ id, name, provider, available, reason?, price?, default?, source }] }`, le défaut
  en premier. `price` : dollars par million de jetons (`input`, `output`, `cacheRead`), absent quand il est inconnu.
- `GET /api/projects` garde son champ `models` (`{ id, name }`), limité aux modèles disponibles.
- Le nom lisible se dérive de l'id quand il n'est pas connu : `claude-opus-5-5` → Opus 5.5.
- `validatePlan`, `startSession` et les réglages de projet acceptent tout modèle **disponible**.
- Le modèle du planificateur : celui de l'escadrille, sinon le réglage du projet (ou le dernier choisi), sinon le
  défaut de la liste. Un modèle retiré est sauté. Un modèle envoyé mais inconnu reste refusé (400).
- Les pages lisent `/api/models` pour les noms (`MODEL_NAMES`) ; un id inconnu s'affiche tel quel.
- Les prix du coût réel restent dans `lib/usage.mjs` (`PRICES`), seul endroit où des ids sont écrits avec le défaut.

Tests : `test/models.test.mjs`.
