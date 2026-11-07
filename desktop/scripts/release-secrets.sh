#!/bin/zsh
# Sets the eight secrets of the release workflow (docs/desktop.md « Publier une version », docs/ci.md) in one go.
# Usage, in a real terminal: sh desktop/scripts/release-secrets.sh [OWNER/REPO]
# Files are read by redirection, passwords are typed at gh's masked prompt: no secret value ever appears in a command
# line, in the shell history or in this script. APPLE_SIGNING_IDENTITY and APPLE_TEAM_ID come from the environment,
# or are asked (they are not secret: the signed app shows them). CALMDEV_PROD picks another folder than ~/.calmdev-prod.
REPO="${1:-Gabfranck/calmdev}"
DIR="${CALMDEV_PROD:-$HOME/.calmdev-prod}"
P12="$DIR/calmdev-developer-id.p12"
KEY="$DIR/updater.key"

[ -t 0 ] || { echo "Run this in a terminal: the passwords are typed at a prompt." >&2; exit 1; }
command -v gh >/dev/null || { echo "gh is not installed (brew install gh)." >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not logged in: gh auth login, then run this again." >&2; exit 1; }
gh repo view "$REPO" >/dev/null 2>&1 || { echo "$REPO not found: push the code to it first, then run this again." >&2; exit 1; }
for f in "$P12" "$KEY"; do [ -r "$f" ] || { echo "Missing $f (docs/desktop.md « Publier une version »)." >&2; exit 1; }; done

IDENTITY="$APPLE_SIGNING_IDENTITY"
[ -n "$IDENTITY" ] || { printf 'APPLE_SIGNING_IDENTITY (Developer ID Application: Nom (TEAMID)) : '; read -r IDENTITY; }
TEAM="$APPLE_TEAM_ID"
[ -n "$TEAM" ] || { printf 'APPLE_TEAM_ID (10 caractères) : '; read -r TEAM; }
[ -n "$IDENTITY" ] && [ -n "$TEAM" ] || { echo "The identity and the Team ID are needed." >&2; exit 1; }

set_file() { echo "→ $1"; gh secret set "$1" -R "$REPO" || exit 1; }
set_typed() { echo "→ $1 : $2"; gh secret set "$1" -R "$REPO" || exit 1; }

base64 -i "$P12" | set_file APPLE_CERTIFICATE
set_file TAURI_SIGNING_PRIVATE_KEY < "$KEY"
printf %s "$IDENTITY" | set_file APPLE_SIGNING_IDENTITY
printf %s "$TEAM" | set_file APPLE_TEAM_ID
set_typed APPLE_CERTIFICATE_PASSWORD "le mot de passe du .p12"
set_typed APPLE_ID "l'e-mail du compte Apple Developer"
set_typed APPLE_PASSWORD "le mot de passe d'app Apple (pas celui du compte)"
set_typed TAURI_SIGNING_PRIVATE_KEY_PASSWORD "le mot de passe de la clé de mise à jour"

echo
gh secret list -R "$REPO"
echo "Done: the eight secrets are set on $REPO. Next: tag v<version> (docs/desktop.md, step 6)."
