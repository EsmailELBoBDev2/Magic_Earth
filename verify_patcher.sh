#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"
for f in \
  payload/cairodrive-google-search-only.js \
  payload/search-core.mjs \
  payload/traffic-core.mjs \
  payload/helper/com/cairodrive/traffic/GoogleTrafficTileVectorizer.java   payload/helper/com/cairodrive/diag/DriveDiagnostics.java \
  payload/libcairodrive_filter.so \
  payload/helper/com/cairodrive/bootstrap/CairoDriveBootstrapProvider.java \
  payload/helper/com/cairodrive/search/AsyncHttp.java \
  tools/discover_gem_globals.py \
  tools/rewrite_manifest.py; do
  [[ -s "$f" ]] || { echo "missing $f" >&2; exit 1; }
done

node search_core_selftest.mjs
node traffic_core_selftest.mjs
node free_drive_google_traffic_selftest.mjs
node deep_audit_selftest.mjs
node drive_ready_corridor_selftest.mjs
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cp payload/cairodrive-google-search-only.js "$TMP/agent.mjs"
node --check "$TMP/agent.mjs"

grep -q 'GEM_DART_PORT_OFFSET' payload/cairodrive-google-search-only.js
grep -q 'GEM_POST_COBJECT_SLOT_OFFSET' payload/cairodrive-google-search-only.js
grep -Fq "VERSION='v24.3-drive-test-ready'" payload/cairodrive-google-search-only.js
grep -Fq "RUNTIME_TUNING='r8-drive-observability'" payload/cairodrive-google-search-only.js
grep -Fq 'SEARCH_POLL_MS=35' payload/cairodrive-google-search-only.js
grep -Fq 'NEARBY_POLL_MS=40' payload/cairodrive-google-search-only.js
grep -Fq 'NAV_INITIAL_ASSIST_MS=400' payload/cairodrive-google-search-only.js
grep -Fq 'TRAFFIC_POLL_MS=100' payload/cairodrive-google-search-only.js
grep -Fq 'ROADBLOCK_BINDINGS_CACHED' payload/cairodrive-google-search-only.js
grep -Fq 'bindingCached=yes' payload/cairodrive-google-search-only.js
grep -Fq 'initialAssistRetryDelay' payload/cairodrive-google-search-only.js
grep -Fq 'GOOGLE_RETRY endpoint=text' payload/cairodrive-google-search-only.js
grep -Fq 'GOOGLE_EMPTY' payload/cairodrive-google-search-only.js
grep -Fq 'carEnum=known-id-0' payload/cairodrive-google-search-only.js
grep -Fq 'hotfix=${RUNTIME_TUNING}' payload/cairodrive-google-search-only.js
grep -Fq 'SEARCH_INTERCEPT kind=typed' payload/cairodrive-google-search-only.js
grep -Fq 'SEARCH_INTERCEPT kind=category' payload/cairodrive-google-search-only.js
grep -Fq 'FAST_SEARCH_MAX_RESULTS=10' payload/cairodrive-google-search-only.js
grep -Fq 'ADDRESS_INJECT streetNumber=' payload/cairodrive-google-search-only.js
grep -Fq 'NATIVE_SEARCH_FALLBACK_DEFERRED' payload/cairodrive-google-search-only.js
grep -Fq 'noNativeReentry=yes' payload/cairodrive-google-search-only.js
! grep -Fq 'replayStockSearch(' payload/cairodrive-google-search-only.js
! grep -Fq 'Date.now()+15000' payload/cairodrive-google-search-only.js
grep -Fq 'burstMax=4' payload/cairodrive-google-search-only.js
grep -Fq "'startSimulation'" payload/cairodrive-google-search-only.js
grep -Fq "'startSimulationWithRoute'" payload/cairodrive-google-search-only.js
grep -Fq 'MAGICLANE_TRAFFIC_POLICY owner=stock forceEnable=no' payload/cairodrive-google-search-only.js
! grep -Fq 'Traffic.$new()' payload/cairodrive-google-search-only.js
grep -Fq 'GOOGLE_TRAFFIC_REQUEST' payload/cairodrive-google-search-only.js
grep -Fq 'NARROW_EVIDENCE' payload/cairodrive-google-search-only.js
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

# The production runtime must remain minimal: no custom overlays, diagnostics,
# simulation, route-algorithm experiments, or stock binary performance patch.
! grep -Fq 'AutocompletePanel' payload/cairodrive-google-search-only.js
! grep -Fq 'NavBanner' payload/cairodrive-google-search-only.js
! grep -Fq 'CairoLog' payload/cairodrive-google-search-only.js
! grep -Fq 'driveTraceEnabled' payload/cairodrive-google-search-only.js
! grep -Fq 'SIMULATION_REWRITE' payload/cairodrive-google-search-only.js
! grep -Fq 'ROUTE_ALGO_' payload/cairodrive-google-search-only.js
! grep -Fq 'BETTER_ROUTE_' payload/cairodrive-google-search-only.js
! grep -Fq 'NATIVE_SPEED_ALARM' payload/cairodrive-google-search-only.js
! grep -Fq 'SOCIAL_REPORT_' payload/cairodrive-google-search-only.js
! grep -Fq 'onDrawFrameCustom' payload/cairodrive-google-search-only.js
! grep -Fq 'patch_search_debounce.py' payload/build_patch.sh
! grep -q 'EXPECTED_LIBAPP_SHA256' payload/build_patch.sh
! grep -q 'patch_libflutter.py' payload/build_patch.sh
! grep -RqsE 'AIza[0-9A-Za-z_-]{25,}' payload
grep -Fq 'FREE_TRAFFIC_READY source=Google-layerTraffic-raster-vector' payload/cairodrive-google-search-only.js
grep -Fq 'NAV_TRAFFIC_RENDER_STEP_M=12' payload/cairodrive-google-search-only.js
grep -Fq 'FREE_TRAFFIC_MAX_PATHS=36' payload/cairodrive-google-search-only.js
grep -Fq 'layerTraffic' payload/helper/com/cairodrive/traffic/GoogleTrafficTileVectorizer.java
grep -Fq 'overlay\":true' payload/helper/com/cairodrive/traffic/GoogleTrafficTileVectorizer.java
grep -Fq 'If-None-Match' payload/helper/com/cairodrive/traffic/GoogleTrafficTileVectorizer.java
grep -Fq 'finishedAtMs>0L' payload/helper/com/cairodrive/search/AsyncHttp.java
grep -Fq 'com.magiclane.sdk.places.Coordinates' payload/cairodrive-google-search-only.js
! grep -Fq 'com.magiclane.sdk.core.Coordinates' payload/cairodrive-google-search-only.js
! grep -Fq "['network','empty','parse'].includes" payload/cairodrive-google-search-only.js
! grep -Fq 'prefs.setTrafficVisibility(true)' payload/cairodrive-google-search-only.js
! grep -Fq 'onDrawFrameCustom' payload/cairodrive-google-search-only.js
file payload/libcairodrive_filter.so | grep -qi 'aarch64\|ARM64'

echo 'v24.3 drive-test observability + deep-audit verification: PASS'

grep -Fq 'DRIVE_DIAGNOSTICS_READY' payload/cairodrive-google-search-only.js
grep -Fq 'METRIC cpuCorePct=' payload/helper/com/cairodrive/diag/DriveDiagnostics.java
grep -Fq 'RETAIN_MS = 3L' payload/helper/com/cairodrive/diag/DriveDiagnostics.java
