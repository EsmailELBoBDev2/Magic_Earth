#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/input/base.apk}"
INFO="${2:-$ROOT/input/SOURCE_INFO.txt}"
mkdir -p "$(dirname "$OUT")"

sha_file(){ sha256sum "$1" | awk '{print $1}'; }

# Preferred future-input path: immutable-by-name APK asset on a private GitHub release.
if [[ -f "$ROOT/base_apk_release.json" ]]; then
  command -v python3 >/dev/null || { echo 'ERROR: python3 missing' >&2; exit 1; }
  command -v gh >/dev/null || { echo 'ERROR: gh CLI missing; required for private release APK input' >&2; exit 1; }
  readarray -t META < <(python3 - "$ROOT/base_apk_release.json" <<'PY'
import json,sys
j=json.load(open(sys.argv[1],encoding='utf-8'))
for k in ('release_tag','asset_name','sha256'):
    v=j.get(k)
    if not isinstance(v,str) or not v:
        raise SystemExit(f'ERROR: base_apk_release.json missing {k}')
print(j['release_tag'])
print(j['asset_name'])
print(j['sha256'].lower())
print(j.get('original_name','unknown.apk'))
PY
)
  TAG="${META[0]}"; ASSET="${META[1]}"; EXPECTED="${META[2]}"; ORIGINAL="${META[3]}"
  REPO="${GITHUB_REPOSITORY:-${CAIRODRIVE_REPO:-EsmailELBoBDev2/Magic_Earth}}"
  [[ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]] || {
    # gh may already have a local authenticated keyring session.
    gh auth status >/dev/null 2>&1 || { echo 'ERROR: no GH_TOKEN/GITHUB_TOKEN and gh is not authenticated' >&2; exit 1; }
  }
  export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  echo "Downloading private release input: $REPO release=$TAG asset=$ASSET"
  gh release download "$TAG" --repo "$REPO" --pattern "$ASSET" --dir "$TMP"
  [[ -f "$TMP/$ASSET" ]] || { echo "ERROR: release asset not downloaded: $ASSET" >&2; exit 1; }
  ACTUAL="$(sha_file "$TMP/$ASSET")"
  [[ "$ACTUAL" == "$EXPECTED" ]] || { echo "ERROR: release APK SHA256 mismatch expected=$EXPECTED actual=$ACTUAL" >&2; exit 1; }
  mv "$TMP/$ASSET" "$OUT"
  cat > "$INFO" <<TXT
source=github_release
repository=$REPO
release_tag=$TAG
asset_name=$ASSET
original_name=$ORIGINAL
sha256=$ACTUAL
size_bytes=$(stat -c '%s' "$OUT")
TXT
  echo "Release APK materialized + SHA256 verified: $ACTUAL"
  exit 0
fi

# Backward-compatible path for the Git-safe 24 MiB chunks already in this repo.
"$ROOT/ci/reassemble-base-apk.sh" "$OUT"
cat > "$INFO" <<TXT
source=git_chunks
original_name=$(cat "$ROOT/base_apk_parts/ORIGINAL_NAME.txt" 2>/dev/null || echo unknown.apk)
sha256=$(sha_file "$OUT")
size_bytes=$(stat -c '%s' "$OUT")
TXT
