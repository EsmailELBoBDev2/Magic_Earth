#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"
command -v git >/dev/null || { echo 'ERROR: git missing' >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo 'ERROR: VERIFY_REPO.sh must run inside a Git work tree' >&2; exit 1; }
[[ -f .github/workflows/build.yml ]]
[[ -f ci/signing/drive-test.keystore.b64 ]]
[[ -f base_apk_release.json || -f base_apk_parts/SHA256.txt ]] || { echo 'ERROR: no base APK source configured' >&2; exit 1; }

# GitHub hard file-limit guard: inspect only tracked + non-ignored prospective Git files.
# Generated input/base.apk, out/, dist/, etc. are intentionally ignored and MUST NOT fail this check.
mapfile -d '' REPO_FILES < <(git ls-files -co --exclude-standard -z)
BIG=''
LIMIT=$((100*1024*1024))
for f in "${REPO_FILES[@]}"; do
  [[ -f "$f" ]] || continue
  size="$(stat -c '%s' -- "$f")"
  if (( size >= LIMIT )); then BIG+="$f $size"$'\n'; fi
done
[[ -z "$BIG" ]] || { echo 'ERROR: Git-visible files >=100 MiB:' >&2; printf '%s' "$BIG" >&2; exit 1; }

# No embedded Google credentials/build markers in files that Git can see.
if ((${#REPO_FILES[@]})); then
  ! grep -IqsE 'AIza[0-9A-Za-z_-]{25,}' "${REPO_FILES[@]}"
fi
! grep -Rqs '__CAIRODRIVE_BUILD_GOOGLE_KEY__\|__CAIRODRIVE_BUILD_GOOGLE_ROUTES_KEY__' payload

# Validate target when it is locally available. CI materializes input/base.apk before invoking us.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
BASE=''
if [[ -f "$ROOT/input/base.apk" ]]; then
  BASE="$ROOT/input/base.apk"
elif [[ -f "$ROOT/base_apk_parts/SHA256.txt" && ! -f "$ROOT/base_apk_release.json" ]]; then
  ./ci/reassemble-base-apk.sh "$TMP/base.apk" >/dev/null
  BASE="$TMP/base.apk"
elif [[ -f "$ROOT/base_apk_parts/SHA256.txt" ]]; then
  # Release input selected, but legacy chunks still provide an offline baseline sanity check.
  ./ci/reassemble-base-apk.sh "$TMP/base.apk" >/dev/null
  BASE="$TMP/base.apk"
  echo 'VERIFY_REPO: NOTE — release-selected APK is not materialized locally; validating legacy baseline + repo invariants. CI validates the selected release APK.'
fi
if [[ -n "$BASE" ]]; then
  python3 ./tools/preflight.py "$BASE" --report "$TMP/preflight.json" >/dev/null
  python3 ./ci/verify-target-routing-surface.py "$BASE" >/dev/null
  unzip -q "$BASE" lib/arm64-v8a/libGEM.so -d "$TMP/gem"
  python3 ./tools/discover_gem_globals.py "$TMP/gem/lib/arm64-v8a/libGEM.so" >/dev/null
fi

# Future-portability invariants.
grep -q 'CairoDriveBootstrapProvider' tools/rewrite_manifest.py
grep -q 'discover_gem_globals.py' payload/build_patch.sh
! grep -q 'patch_libflutter.py' payload/build_patch.sh
! grep -q 'EXPECTED_LIBAPP_SHA256' payload/build_patch.sh
grep -q 'safe signature count' tools/patch_search_debounce.py
grep -q 'MAX_RESPONSE_BYTES' payload/helper/com/cairodrive/search/AsyncHttp.java
grep -q 'endpoint not allowlisted' payload/helper/com/cairodrive/search/AsyncHttp.java

# Syntax/selftests.
for s in ./*.sh ci/*.sh tools/*.sh payload/build_patch.sh experiments/*.sh; do [[ -f "$s" ]] && bash -n "$s"; done
python3 -m py_compile tools/*.py ci/*.py experiments/*.py
cp payload/cairodrive-google-search-only.js "$TMP/agent.mjs"; node --check "$TMP/agent.mjs"
node search_core_selftest.mjs >/dev/null
node nav_core_selftest.mjs >/dev/null
node traffic_core_selftest.mjs >/dev/null
grep -q 'push:' .github/workflows/build.yml
! grep -q 'secrets\.' .github/workflows/build.yml
echo 'VERIFY_REPO: PASS — Git-visible files are GitHub-safe; portable/fail-closed repo invariants and zero-secret CI checks pass.'
