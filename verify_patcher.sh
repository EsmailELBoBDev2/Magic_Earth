#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"
for f in payload/cairodrive-google-search-only.js payload/search-core.mjs payload/nav-core.mjs payload/traffic-core.mjs payload/libcairodrive_filter.so payload/helper/com/cairodrive/bootstrap/CairoDriveBootstrapProvider.java payload/helper/com/cairodrive/search/AsyncHttp.java tools/discover_gem_globals.py tools/patch_search_debounce.py tools/rewrite_manifest.py; do [[ -s "$f" ]] || { echo "missing $f" >&2; exit 1; }; done
node search_core_selftest.mjs
node nav_core_selftest.mjs
node traffic_core_selftest.mjs
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cp payload/cairodrive-google-search-only.js "$TMP/agent.mjs"; node --check "$TMP/agent.mjs"
grep -q 'GEM_DART_PORT_OFFSET' payload/cairodrive-google-search-only.js
grep -q 'GEM_POST_COBJECT_SLOT_OFFSET' payload/cairodrive-google-search-only.js
grep -q 'ROUTE_RECOMPUTE_TARGET_MS = 1000' payload/cairodrive-google-search-only.js
grep -q 'GOOGLE_TRAFFIC_ROADBLOCK' payload/cairodrive-google-search-only.js
grep -q 'native-better-route-decision' payload/cairodrive-google-search-only.js
grep -q 'NARROW_EVIDENCE' payload/cairodrive-google-search-only.js
grep -q 'SIMULATION_REWRITE_APPLIED' payload/cairodrive-google-search-only.js
grep -q 'ExternalCh' payload/cairodrive-google-search-only.js
grep -q 'allowonlinecalculation' payload/nav-core.mjs
grep -q 'avoidtraffic' payload/nav-core.mjs
grep -q 'avoidunpavedroads' payload/nav-core.mjs
grep -q 'alternativesNever' payload/nav-core.mjs
! grep -q 'EXPECTED_LIBAPP_SHA256' payload/build_patch.sh
! grep -q 'patch_libflutter.py' payload/build_patch.sh
! grep -RqsE 'AIza[0-9A-Za-z_-]{25,}' payload
file payload/libcairodrive_filter.so | grep -qi 'aarch64\|ARM64'
echo 'v22.3 portable KISS + fast-reroute + auto-sim static verification: PASS'
