#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"
REPO="${CAIRODRIVE_REPO:-EsmailELBoBDev2/Magic_Earth}"
RELEASE_TAG="${CAIRODRIVE_UPSTREAM_RELEASE:-upstream-apks}"
MODE=release
WATCH=0
PUSH=1

usage(){ cat <<'TXT'
Usage:
  ./UPDATE_APK.sh /path/to/new-MagicEarth.apk
  ./UPDATE_APK.sh --watch /path/to/new-MagicEarth.apk
  ./UPDATE_APK.sh --no-push /path/to/new-MagicEarth.apk
  ./UPDATE_APK.sh --legacy-chunks /path/to/new-MagicEarth.apk

Default/recommended: upload the whole APK to the private GitHub release, commit only a tiny
SHA-pinned manifest, push main, and let CI patch it. --legacy-chunks keeps the old 24 MiB mode.
TXT
}

ARGS=()
while (($#)); do
  case "$1" in
    --watch) WATCH=1;;
    --no-push) PUSH=0;;
    --legacy-chunks) MODE=chunks;;
    -h|--help) usage; exit 0;;
    --*) echo "ERROR: unknown option: $1" >&2; usage; exit 2;;
    *) ARGS+=("$1");;
  esac
  shift
done
((${#ARGS[@]}==1)) || { usage; exit 2; }
APK="${ARGS[0]}"
[[ -f "$APK" ]] || { echo "ERROR: APK not found: $APK" >&2; exit 2; }
APK="$(realpath "$APK")"
command -v git >/dev/null || { echo 'ERROR: git missing' >&2; exit 2; }
command -v sha256sum >/dev/null || { echo 'ERROR: sha256sum missing' >&2; exit 2; }
command -v unzip >/dev/null || { echo 'ERROR: unzip missing' >&2; exit 2; }
git rev-parse --is-inside-work-tree >/dev/null
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || {
  echo 'ERROR: tracked working-tree changes exist. Commit/stash them before importing a new upstream APK.' >&2
  git status --short >&2
  exit 3
}
unzip -tq "$APK" >/dev/null || { echo 'ERROR: input is not a valid APK/ZIP' >&2; exit 4; }
unzip -Z1 "$APK" | grep -qx 'AndroidManifest.xml' || { echo 'ERROR: AndroidManifest.xml missing; supply the base/standalone .apk, not an HTML/download wrapper.' >&2; exit 4; }

SHA="$(sha256sum "$APK" | awk '{print $1}')"
SIZE="$(stat -c '%s' "$APK")"
ORIGINAL="$(basename "$APK")"
VERSION=""
if command -v aapt2 >/dev/null 2>&1; then
  VERSION="$(aapt2 dump badging "$APK" 2>/dev/null | sed -n "s/^package:.*versionName='\([^']*\)'.*/\1/p" | head -1 || true)"
fi

if [[ "$MODE" == chunks ]]; then
  echo "Legacy chunk import: $ORIGINAL sha256=$SHA"
  ./tools/import_base_apk.sh "$APK"
  rm -f base_apk_release.json
  git add -A base_apk_parts base_apk_release.json 2>/dev/null || true
else
  command -v gh >/dev/null || { echo 'ERROR: gh CLI missing. On Arch: sudo pacman -S github-cli' >&2; exit 5; }
  gh auth status >/dev/null
  VIS="$(gh repo view "$REPO" --json visibility -q .visibility)"
  [[ "$VIS" == PRIVATE ]] || { echo "ERROR: $REPO must remain PRIVATE; current visibility=$VIS" >&2; exit 5; }
  ASSET="MagicEarth-${SHA:0:16}.apk"
  echo "Whole-APK release import: $ORIGINAL -> $RELEASE_TAG/$ASSET"
  if ! gh release view "$RELEASE_TAG" --repo "$REPO" >/dev/null 2>&1; then
    gh release create "$RELEASE_TAG" --repo "$REPO" --target main \
      --title 'Private upstream Magic Earth APK inputs' \
      --notes 'Private CI input assets. Each APK is SHA-pinned by base_apk_release.json.'
  fi
  if gh release view "$RELEASE_TAG" --repo "$REPO" --json assets -q '.assets[].name' | grep -Fxq "$ASSET"; then
    echo "Release asset already exists: $ASSET"
  else
    TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
    if ! ln "$APK" "$TMP/$ASSET" 2>/dev/null; then cp --reflink=auto "$APK" "$TMP/$ASSET"; fi
    gh release upload "$RELEASE_TAG" "$TMP/$ASSET" --repo "$REPO"
  fi
  python3 - "$ORIGINAL" "$SHA" "$SIZE" "$RELEASE_TAG" "$ASSET" "$VERSION" > base_apk_release.json <<'PY'
import datetime,json,sys
orig,sha,size,tag,asset,version=sys.argv[1:]
print(json.dumps({
  "schema":1,
  "source":"private_github_release",
  "release_tag":tag,
  "asset_name":asset,
  "original_name":orig,
  "sha256":sha,
  "size_bytes":int(size),
  "version_name":version or None,
  "imported_utc":datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()
},indent=2))
PY
  git add base_apk_release.json
fi

if git diff --cached --quiet; then
  echo 'Nothing changed: this upstream APK is already selected.'
  exit 0
fi
MSG="Update upstream Magic Earth APK"
[[ -n "$VERSION" ]] && MSG+=" $VERSION"
MSG+=" (${SHA:0:12})"
git commit -m "$MSG"

if (( ! PUSH )); then
  echo 'Committed locally. --no-push requested, so CI was not started.'
  exit 0
fi

git push origin HEAD:main
HEADSHA="$(git rev-parse HEAD)"
echo
echo "Pushed upstream APK selector commit: $HEADSHA"
echo 'GitHub Actions will: compatibility-check -> patch/build if safe -> automatic forensics if incompatible/build fails.'

RUN_ID=""
for _ in {1..12}; do
  ROW="$(gh run list --repo "$REPO" --workflow build.yml --limit 10 --json databaseId,headSha,url,status --jq ".[] | select(.headSha == \"$HEADSHA\") | [.databaseId,.status,.url] | @tsv" | head -1 || true)"
  if [[ -n "$ROW" ]]; then
    IFS=$'\t' read -r RUN_ID STATUS URL <<<"$ROW"
    echo "Run: $URL ($STATUS)"
    break
  fi
  sleep 2
done

if (( WATCH )) && [[ -n "$RUN_ID" ]]; then
  set +e
  gh run watch "$RUN_ID" --repo "$REPO" --exit-status
  RC=$?
  set -e
  echo
  "$ROOT/GET_LATEST_RESULT.sh" "$RUN_ID" || true
  exit "$RC"
fi
