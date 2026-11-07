# Règles du projet fixture

## Règles

- Pas de console.log dans src/ {deny: console\.log in src/**}
- Une migration ne se modifie jamais {immutable: migrations/**}
- Tout nouveau fichier dans api/ a un test {requires-test: api/**}
- Pas de nouvelle dépendance sans ligne dans decisions.md {deps: package.json}
- Les noms de variables sont en anglais
- Un motif cassé {deny: ([ in src/**}
- Un mot inconnu {forbid: x}

## Vérifications

- `node -e "console.log('ok')"`
- `node -e "process.exit(3)"`
