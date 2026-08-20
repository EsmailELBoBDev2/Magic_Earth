#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
EXPECTED_REPO='EsmailELBoBDev2/Magic_Earth'

command -v git >/dev/null || { echo 'ERROR: git is required.' >&2; exit 1; }
[[ -d .git ]] || { echo 'ERROR: unzip this bundle into your already-cloned Magic_Earth repository.' >&2; exit 2; }
origin="$(git remote get-url origin 2>/dev/null || true)"
case "$origin" in
  "https://github.com/${EXPECTED_REPO}"|"https://github.com/${EXPECTED_REPO}.git"|"git@github.com:${EXPECTED_REPO}.git") ;;
  *) echo "ERROR: origin is '$origin'; expected https://github.com/${EXPECTED_REPO}.git" >&2; exit 3;;
esac

# v22.3.3 never commits or embeds Google keys. If an older v22.3.x revision
# tracked config/google_keys.env, untrack it while leaving the local copy in place
# for the user's own reference. The .gitignore entry prevents re-adding it.
if git ls-files --error-unmatch config/google_keys.env >/dev/null 2>&1; then
  echo 'SECURITY: removing config/google_keys.env from Git tracking (local file kept).'
  git rm --cached --ignore-unmatch config/google_keys.env >/dev/null
  echo 'NOTE: if that file ever contained a real API key in a pushed commit, rotate that key after this fix.'
fi
if git ls-files --error-unmatch tools/embed_google_keys.py >/dev/null 2>&1; then
  git rm --ignore-unmatch tools/embed_google_keys.py >/dev/null
fi

./VERIFY_REPO.sh

if git rev-parse --verify HEAD >/dev/null 2>&1; then
  git checkout -B main >/dev/null
else
  git symbolic-ref HEAD refs/heads/main
fi
if ! git config user.name >/dev/null; then git config user.name 'EsmailELBoBDev2'; fi
if ! git config user.email >/dev/null; then git config user.email 'EsmailELBoBDev2@users.noreply.github.com'; fi

git add -u
while IFS= read -r -d '' f; do git add -- "$f"; done < <(git ls-files --others --exclude-standard -z)
if git diff --cached --quiet; then
  echo 'Nothing new to commit. Pushing existing main.'
else
  git commit -m 'CairoDrive v22.3.3 fix Frida module bundling and runtime-only Google keys'
fi

if [[ "${CAIRODRIVE_DRY_RUN:-0}" == '1' ]]; then
  echo 'DRY RUN: verification + commit path passed; skipping network push.'
  exit 0
fi

echo 'Pushing CairoDrive source to GitHub...'
git push -u origin main
cat <<'MSG'

PUSH COMPLETE.
GitHub Actions should now run: Build CairoDrive signed APK + AAB
Artifact: CairoDrive-v22.3-DRIVE-TEST-com.cairodrive.app
After installing the artifact APK, run ./provision_google_key.sh once.
MSG
