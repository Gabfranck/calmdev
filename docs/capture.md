# La capture d'écran d'une session

Phase 8 B. Une session demande une capture en écrivant une ligne ; le serveur photographie la page, sans shell et
sans jamais ouvrir de fenêtre (`docs/decisions.md`, « Rien ne s'ouvre à l'écran », 10:40).

## Le contrat

- **La demande** : une ligne `CAPTURE: <cible>`, seule sur sa ligne, dans le texte d'un tour ou dans un champ texte
  du bloc `escadrille:state`. Rien d'autre de ce que la session a écrit n'est lu ni exécuté. Une capture par cible
  et par arrêt, trente au plus par tour (`MAX_PER_TURN`), prises en file, une à la fois.
- **Les cibles** : `http://localhost:<port>`, `http://127.0.0.1:<port>`, ou un fichier `.html` dont le chemin
  réel (liens symboliques suivis) est dans le worktree de la session. Tout le reste est refusé en une ligne.
- **Le navigateur** : le chrome-headless-shell de Playwright, la révision la plus récente de
  `~/Library/Caches/ms-playwright` (`~/.cache/ms-playwright` sous Linux) ; `CHROME_PATH` l'emporte, sauf un
  navigateur d'un paquet `.app`. Profil temporaire, processus tué et profil effacé dans tous les cas, 30 s au plus.
  Rien ne sort de la machine : les requêtes vers un autre hôte échouent (`Fetch.enable`) et sont comptées.
- **La sortie** : `<worktree>/.escadrille/captures/<arrêt>-<cible>/` avec `1440.png` et `390.png`
  (page entière) et `console.json` `{ url, at, errors, warnings, blocked, blockedHosts }`. Jamais commité
  (`.escadrille/` est dans `.gitignore`).
- **Le retour** : un message system d'une ligne dans la page, repris en tête du prochain message envoyé à la
  session : le dossier et le nombre d'erreurs de console, ou la raison du refus. Sans chrome-headless-shell, la
  ligne le dit (`npx playwright install chromium-headless-shell`).
- **La reprise** : quand la file d'une session est vide et que son tour est fini (en attente, processus vivant, personne
  n'a écrit entre-temps, le tour n'a franchi aucun nouvel arrêt du plan et aucune question n'attend le développeur), le serveur lui envoie lui-même les lignes `[système] CAPTURE …` suivies de « Les captures sont
  prises : reprends. » ; sinon les lignes restent en tête du prochain message. Une capture qui échoue le dit en une
  ligne et la file continue.
- **Pour le pilote** : `captureTarget({ target, worktree, name? })` de `lib/capture.mjs` rend
  `{ ok, dir, files, errors, warnings, blocked }` ou `{ ok: false, error }`, sans jamais lever d'erreur.

## Exemple

La session termine son tour par :

```
L'écran du flot est prêt.
CAPTURE: http://localhost:3078/flow
CAPTURE: test/fixtures/capture/page.html
```

Le serveur répond dans la page :

```
CAPTURE http://localhost:3078/flow : …/.escadrille/captures/1-localhost-3078-flow (0 erreur de console)
CAPTURE test/fixtures/capture/page.html : …/.escadrille/captures/1-test-fixtures-capture-page-html (1 erreur de console, 1 requête hors machine bloquée)
```

Dans le bac à sable d'une session, Chromium ne démarre pas (mach port refusé) : le serveur, lui, n'y tourne pas.
Les tests passent par un faux pilote (`driver`) et ne font la vraie capture que si le navigateur démarre.
