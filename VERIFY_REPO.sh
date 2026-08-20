#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"
[[ -f .github/workflows/build.yml ]]
[[ -f ci/signing/drive-test.keystore.b64 ]]
[[ -f base_apk_parts/SHA256.txt ]]
# GitHub hard file limit guard: fail on tracked/working files >=100 MiB.
BIG="$(find . -type f -not -path './.git/*' -size +99M -printf '%p %s\n' || true)"
[[ -z "$BIG" ]] || { echo 'ERROR: files >=100 MiB:' >&2; echo "$BIG" >&2; exit 1; }
# Reassemble the bundled exact baseline and run structural checks.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
./ci/reassemble-base-apk.sh "$TMP/base.apk" >/dev/null
python3 ./tools/preflight.py "$TMP/base.apk" --report "$TMP/preflight.json" >/dev/null
python3 ./ci/verify-target-routing-surface.py "$TMP/base.apk" >/dev/null
unzip -q "$TMP/base.apk" lib/arm64-v8a/libGEM.so -d "$TMP/gem"
python3 ./tools/discover_gem_globals.py "$TMP/gem/lib/arm64-v8a/libGEM.so" >/dev/null
# No embedded Google credentials/build markers.
! grep -RqsE 'AIza[0-9A-Za-z_-]{25,}' . --exclude-dir=.git
! grep -Rqs '__CAIRODRIVE_BUILD_GOOGLE_KEY__\|__CAIRODRIVE_BUILD_GOOGLE_ROUTES_KEY__' payload
# Future-portability invariants.
grep -q 'CairoDriveBootstrapProvider' tools/rewrite_manifest.py
grep -q 'discover_gem_globals.py' payload/build_patch.sh
! grep -q 'patch_libflutter.py' payload/build_patch.sh
! grep -q 'EXPECTED_LIBAPP_SHA256' payload/build_patch.sh
grep -q 'safe signature count' tools/patch_search_debounce.py
grep -q 'MAX_RESPONSE_BYTES' payload/helper/com/cairodrive/search/AsyncHttp.java
grep -q 'endpoint not allowlisted' payload/helper/com/cairodrive/search/AsyncHttp.java
# Syntax.
for s in ./*.sh ci/*.sh tools/*.sh payload/build_patch.sh experiments/*.sh; do [[ -f "$s" ]] && bash -n "$s"; done
python3 -m py_compile tools/*.py ci/*.py experiments/*.py
cp payload/cairodrive-google-search-only.js "$TMP/agent.mjs"; node --check "$TMP/agent.mjs"
node search_core_selftest.mjs >/dev/null
node nav_core_selftest.mjs >/dev/null
node traffic_core_selftest.mjs >/dev/null
# Workflow must build on push and use zero GitHub secrets.
grep -q 'push:' .github/workflows/build.yml
! grep -q 'secrets\.' .github/workflows/build.yml
echo 'VERIFY_REPO: PASS — portable/fail-closed v22.3 repo is GitHub-safe (<100MiB/file) and zero-secret CI ready.'
