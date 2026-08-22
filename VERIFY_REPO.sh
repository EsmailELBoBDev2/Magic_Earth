#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"
command -v git >/dev/null || { echo 'ERROR: git missing' >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo 'ERROR: VERIFY_REPO.sh must run inside a Git work tree' >&2; exit 1; }
[[ -f .github/workflows/build.yml ]]
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
grep -q 'MAX_RESPONSE_BYTES' payload/helper/com/cairodrive/search/AsyncHttp.java
grep -q 'endpoint not allowlisted' payload/helper/com/cairodrive/search/AsyncHttp.java
# Minimal build: stock Magic Earth internals stay stock. Only bootstrap + bounded
# background HTTP helper enter the injected DEX.
! grep -Fq 'patch_search_debounce.py' payload/build_patch.sh
grep -Fq 'CairoDriveBootstrapProvider.java' payload/build_patch.sh
grep -Fq 'AsyncHttp.java' payload/build_patch.sh
! grep -Fq 'AutocompletePanel.java' payload/build_patch.sh
! grep -Fq 'NavBanner.java' payload/build_patch.sh
! grep -Fq 'CairoLog.java' payload/build_patch.sh


# Smart-update / fail-safe invariants.
[[ -x SMART_UPDATE.sh ]]
[[ -f DROP_NEW_APK_HERE/README.txt ]]
[[ -f baseline/known-good.json ]]
[[ -x tools/compatibility_delta.py ]]
[[ -x tools/apk_inventory_delta.py ]]
[[ -x tools/classify_build_failure.py ]]
grep -q 'AGENT_REL=' payload/build_patch.sh
grep -q 'frida-compile "$AGENT_REL"' payload/build_patch.sh
! grep -q 'frida-compile "$WORK/cairodrive-agent.js"' payload/build_patch.sh
grep -q 'compatibility_delta.py' .github/workflows/build.yml
grep -q 'discover_gem_globals.py' .github/workflows/build.yml
grep -q 'gem_discovery_rc' .github/workflows/build.yml
grep -q 'CairoDrive-FUTURE-APK-HANDOFF' .github/workflows/build.yml
grep -q 'actions/download-artifact@v8' .github/workflows/build.yml
grep -q 'actions/cache@v5' .github/workflows/build.yml
! grep -q 'Verify repository is private' .github/workflows/build.yml
! grep -q 'github.event.repository.private != true' .github/workflows/build.yml
! grep -q 'must remain PRIVATE' UPDATE_APK.sh
grep -q 'git merge --ff-only origin/main' UPDATE_APK.sh
grep -q 'npm ci --no-audit --no-fund' payload/build_patch.sh
grep -q 'PATCH_VERSION="${CAIRODRIVE_PATCH_VERSION:-23.3}"' build_cairodrive.sh
grep -q 'VERSION_NAME_SUFFIX="${CAIRODRIVE_VERSION_NAME_SUFFIX:--cairodrive233}"' build_cairodrive.sh
grep -Fq -- '"--version-name-suffix=$VERSION_NAME_SUFFIX"' build_cairodrive.sh
! grep -Fq -- '--version-name-suffix "${CAIRODRIVE_VERSION_NAME_SUFFIX:--cairodrive23}"' build_cairodrive.sh
grep -q 'APK="${1:-$ROOT/input/base.apk}"' build_cairodrive.sh
grep -q 'APK="${1:-$ROOT/input/base.apk}"' build_and_update.sh
grep -q 'BOOT agent=' watch_search.sh
grep -q 'BOOT agent=' watch_nav.sh
grep -q 'CAIRODRIVE_PATCH_VERSION:' .github/workflows/build.yml
# Self-signed Android/AAB signing regression guards.
! grep -q 'jarsigner -verify -strict' tools/build_aab.sh
! grep -q 'jarsigner -verify -strict' .github/workflows/build.yml
grep -q 'AAB signer certificate does not match selected keystore' tools/build_aab.sh
grep -q 'keytool -printcert -jarfile' tools/build_aab.sh
python3 - <<'PY'
import json
p=json.load(open('payload/package.json'))
assert p.get('allowScripts',{}).get('frida@17.17.0') is True
PY

# Syntax/selftests.
for s in ./*.sh ci/*.sh tools/*.sh payload/build_patch.sh experiments/*.sh; do [[ -f "$s" ]] && bash -n "$s"; done
python3 -m py_compile tools/*.py ci/*.py experiments/*.py
cp payload/cairodrive-google-search-only.js "$TMP/agent.mjs"; node --check "$TMP/agent.mjs"
node search_core_selftest.mjs >/dev/null
node traffic_core_selftest.mjs >/dev/null
node drive_ready_corridor_selftest.mjs >/dev/null
grep -q 'push:' .github/workflows/build.yml
[[ -x ci/validate-signing-key.sh ]]
grep -Fq 'secrets.CAIRODRIVE_KEYSTORE_BASE64' .github/workflows/build.yml
grep -Fq 'secrets.ANDROID_KEYSTORE_PASSWORD' .github/workflows/build.yml
grep -Fq 'secrets.ANDROID_KEY_PASSWORD' .github/workflows/build.yml
grep -Fq 'secrets.ANDROID_KEY_ALIAS' .github/workflows/build.yml
grep -Fq 'EXPECTED_UPLOAD_CERT_SHA1: D9:19:59:58:60:C9:47:E3:FC:A6:5A:16:EF:FB:BF:9F:C3:E7:2F:9A' .github/workflows/build.yml
! grep -Fq 'CAIRODRIVE_KEYSTORE_B64_FILE: ${{ github.workspace }}/ci/signing/drive-test.keystore.b64' .github/workflows/build.yml
! grep -Fq 'ANDROID_KEYSTORE_PASSWORD: cairodrive-drive-test-2026' .github/workflows/build.yml
grep -Fq 'Play signing fingerprint guard: PASS' build_cairodrive.sh

# v23.3 minimal runtime regression guards.
grep -Fq "VERSION='v23.3-drive-ready-r2'" payload/cairodrive-google-search-only.js
grep -Fq 'SEARCH_INTERCEPT kind=typed' payload/cairodrive-google-search-only.js
grep -Fq 'SEARCH_INTERCEPT kind=category' payload/cairodrive-google-search-only.js
grep -Fq 'FAST_SEARCH_MAX_RESULTS=10' payload/cairodrive-google-search-only.js
grep -Fq 'ADDRESS_INJECT streetNumber=' payload/cairodrive-google-search-only.js
grep -Fq 'NATIVE_SEARCH_FALLBACK_DEFERRED' payload/cairodrive-google-search-only.js
grep -Fq 'noNativeReentry=yes' payload/cairodrive-google-search-only.js
! grep -Fq 'replayStockSearch(' payload/cairodrive-google-search-only.js
grep -Fq 'burstMax=4' payload/cairodrive-google-search-only.js
grep -Fq "'startSimulation'" payload/cairodrive-google-search-only.js
grep -Fq "'startSimulationWithRoute'" payload/cairodrive-google-search-only.js
grep -Fq "mode:simulation?'simulation':'live'" payload/cairodrive-google-search-only.js
grep -Fq 'MAGICLANE_TRAFFIC_POLICY owner=stock forceEnable=no' payload/cairodrive-google-search-only.js
! grep -Fq 'Traffic.$new()' payload/cairodrive-google-search-only.js
grep -Fq "nk==='avoidunpavedroads'" payload/cairodrive-google-search-only.js
grep -Fq "nk==='buildterrainprofile'" payload/cairodrive-google-search-only.js
grep -Fq 'NARROW_EVIDENCE' payload/cairodrive-google-search-only.js
grep -Fq 'GOOGLE_TRAFFIC_REQUEST' payload/cairodrive-google-search-only.js

# Near-native traffic renderer: real stock MapView, refresh-driven, merged,
# adaptively simplified, and snapshot-replaced only when traffic changes.
grep -Fq 'TRAFFIC_MAP_MAX_PATHS=16' payload/cairodrive-google-search-only.js
grep -Fq 'TRAFFIC_MAP_MAX_POINTS_PER_PATH=96' payload/cairodrive-google-search-only.js
grep -Fq 'GemSurfaceView' payload/cairodrive-google-search-only.js
grep -Fq 'produceWithCoords' payload/cairodrive-google-search-only.js
grep -Fq 'TRAFFIC_MAP_RENDERED' payload/cairodrive-google-search-only.js
grep -Fq 'renderer=MagicLane-native' payload/cairodrive-google-search-only.js
grep -Fq 'replaceSnapshot=yes' payload/cairodrive-google-search-only.js
! grep -Fq 'differential=yes' payload/cairodrive-google-search-only.js
grep -Fq 'simplified=yes' payload/cairodrive-google-search-only.js
grep -Fq 'simplifyTrafficCoordinates' payload/cairodrive-google-search-only.js
grep -Fq '__trafficMapEntries' payload/cairodrive-google-search-only.js
grep -Fq 'stockInternals=untouched' payload/cairodrive-google-search-only.js
! grep -Fq 'onDrawFrameCustom' payload/cairodrive-google-search-only.js

# Removed runtime surfaces must stay out of the production agent.
! grep -Fq 'AutocompletePanel' payload/cairodrive-google-search-only.js
! grep -Fq 'NavBanner' payload/cairodrive-google-search-only.js
! grep -Fq 'CairoLog' payload/cairodrive-google-search-only.js
! grep -Fq 'driveTraceEnabled' payload/cairodrive-google-search-only.js
! grep -Fq 'getNavigationInstruction' payload/cairodrive-google-search-only.js
! grep -Fq 'VOICE_REPEAT' payload/cairodrive-google-search-only.js
! grep -Fq 'BETTER_ROUTE_' payload/cairodrive-google-search-only.js
! grep -Fq 'SIMULATION_REWRITE' payload/cairodrive-google-search-only.js
! grep -Fq 'ROUTE_ALGO_' payload/cairodrive-google-search-only.js
! grep -Fq 'SOCIAL_REPORT_' payload/cairodrive-google-search-only.js
! grep -Fq 'NATIVE_SPEED_ALARM' payload/cairodrive-google-search-only.js
! grep -Fq 'isNavigationActive(null)' payload/cairodrive-google-search-only.js
! grep -Fq 'getNavigationRoute(null)' payload/cairodrive-google-search-only.js

# Play releases must never reuse the upstream versionCode for a CairoDrive rebuild.
grep -Fq 'SOURCE_VERSION_CODE=' build_cairodrive.sh
grep -Fq 'PLAY_VERSION_OFFSET="${GITHUB_RUN_NUMBER:-1}"' build_cairodrive.sh
grep -Fq -- '--version-code "$PLAY_VERSION_CODE"' build_cairodrive.sh
grep -Fq 'play_version_code=$PLAY_VERSION_CODE' build_cairodrive.sh
echo 'VERIFY_REPO: PASS — v23.3 drive-ready r2: lean Google Places, safe stock fallback, simulation-aware Google traffic, conservative narrow-road handling, bounded native traffic rendering, stock performance preservation, monotonic Play versionCode, and Play-key signing checks pass.'
