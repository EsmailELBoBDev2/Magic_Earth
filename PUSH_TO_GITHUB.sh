#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
EXPECTED_REPO='EsmailELBoBDev2/Magic_Earth'
CONFIG="$ROOT/config/google_keys.env"

command -v git >/dev/null || { echo 'ERROR: git is required.' >&2; exit 1; }
[[ -d .git ]] || { echo 'ERROR: unzip this bundle into your already-cloned Magic_Earth repository.' >&2; exit 2; }
origin="$(git remote get-url origin 2>/dev/null || true)"
case "$origin" in
  "https://github.com/${EXPECTED_REPO}"|"https://github.com/${EXPECTED_REPO}.git"|"git@github.com:${EXPECTED_REPO}.git") ;;
  *) echo "ERROR: origin is '$origin'; expected https://github.com/${EXPECTED_REPO}.git" >&2; exit 3;;
esac

get_cfg(){ sed -n "s/^$1=//p" "$CONFIG" | tail -1; }
places="${GOOGLE_PLACES_API_KEY:-$(get_cfg GOOGLE_PLACES_API_KEY)}"
routes="${GOOGLE_ROUTES_API_KEY:-$(get_cfg GOOGLE_ROUTES_API_KEY)}"
if [[ -z "$places" || "$places" == REPLACE_* ]]; then
  read -r -s -p 'Google Places API key (will be committed to this PRIVATE repo and embedded in APK): ' places; echo
fi
[[ -n "$places" ]] || { echo 'ERROR: Google Places key cannot be empty.' >&2; exit 4; }
if [[ -z "$routes" || "$routes" == REPLACE_* ]]; then
  read -r -s -p 'Google Routes API key [Enter = reuse Places key]: ' routes; echo
  [[ -n "$routes" ]] || routes="$places"
fi
mkdir -p config
umask 077
cat > "$CONFIG" <<EOF
# PRIVATE REPOSITORY FILE — intentionally tracked and embedded into CairoDrive.
GOOGLE_PLACES_API_KEY=$places
GOOGLE_ROUTES_API_KEY=$routes
EOF
chmod 0600 "$CONFIG"

# Repository/source verification runs before Git mutation.
./VERIFY_REPO.sh

# Never print the secret-bearing config. Show only path-level status.
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  git checkout -B main >/dev/null
else
  git symbolic-ref HEAD refs/heads/main
fi
if ! git config user.name >/dev/null; then git config user.name 'EsmailELBoBDev2'; fi
if ! git config user.email >/dev/null; then git config user.email 'EsmailELBoBDev2@users.noreply.github.com'; fi

git add -- . ':!out' ':!dist' ':!input' ':!payload/node_modules' ':!node_modules'
if git diff --cached --quiet; then
  echo 'Nothing new to commit. Pushing existing main.'
else
  git commit -m 'CairoDrive v22.3 drive-test CI'
fi

if [[ "${CAIRODRIVE_DRY_RUN:-0}" == '1' ]]; then
  echo 'DRY RUN: verification + commit path passed; skipping network push.'
  exit 0
fi
echo 'Pushing private CairoDrive source to GitHub...'
git push -u origin main
cat <<'MSG'

PUSH COMPLETE.
GitHub Actions should now run: Build CairoDrive signed APK + AAB
Artifact: CairoDrive-v22.3-DRIVE-TEST-com.cairodrive.app
MSG
