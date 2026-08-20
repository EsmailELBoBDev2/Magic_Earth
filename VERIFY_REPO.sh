#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
fail(){ echo "VERIFY_REPO: FAIL — $*" >&2; exit 1; }
need(){ command -v "$1" >/dev/null 2>&1 || fail "missing local verifier command: $1"; }
for c in bash python3 node sha256sum unzip zip cc keytool; do need "$c"; done

# 1) Source APK parts are push-safe and reconstruct the configured base APK.
(cd base_apk_parts && sha256sum -c PARTS_SHA256SUMS.txt >/dev/null)
while IFS= read -r -d '' f; do
  sz=$(stat -c %s "$f")
  (( sz < 50*1024*1024 )) || fail "GitHub part is >=50 MiB: $f"
done < <(find base_apk_parts -type f -name 'magic-earth-base.apk.part-*' -print0)
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
./ci/reassemble-base-apk.sh "$TMP/base.apk" >/dev/null
EXPECTED_BASE="$(awk 'NF {print $1; exit}' base_apk_parts/BASE_APK_SHA256.txt | tr 'A-F' 'a-f')"
[[ "$EXPECTED_BASE" =~ ^[0-9a-f]{64}$ ]] || fail 'invalid base APK SHA256 metadata' 
[[ "$(sha256sum "$TMP/base.apk" | awk '{print $1}')" == "$EXPECTED_BASE" ]] || fail 'base APK hash mismatch'
unzip -t "$TMP/base.apk" >/dev/null || fail 'base APK ZIP integrity'
python3 ./tools/preflight.py "$TMP/base.apk" --report "$TMP/preflight.json" >/dev/null || fail 'base APK compatibility preflight'
python3 ./ci/verify-target-routing-surface.py "$TMP/base.apk" >/dev/null || fail 'route/simulation surface'

# 2) Code/selftests.
node search_core_selftest.mjs >/dev/null
node nav_core_selftest.mjs >/dev/null
node traffic_core_selftest.mjs >/dev/null
cc -std=c11 -O2 filter_selftest.c -o "$TMP/filter_selftest"
"$TMP/filter_selftest" >/dev/null
python3 -m py_compile tools/*.py ci/*.py experiments/*.py
python3 ./ci/verify-agent-module-graph.py >/dev/null || fail 'agent module graph'
find . -type f -name '*.sh' -print0 | while IFS= read -r -d '' f; do bash -n "$f" || exit 1; done

# 3) Security/economy invariants introduced by v22.3.3.
# API keys must never be committed or embedded. The built agent keeps inert
# placeholders and loads runtime-provisioned values from private app storage.
key_hits="$(grep -RIlE 'AIza[0-9A-Za-z_-]{20,}' --exclude='*.part-*' --exclude='*.jks' --exclude='google_keys.env' --exclude-dir='.git' . 2>/dev/null || true)"
[[ -z "$key_hits" ]] || fail "Google API key material found in tracked/source files: $key_hits"
grep -qx 'config/google_keys.env' .gitignore || fail 'runtime key config is not ignored'
if [[ -d .git ]] && git ls-files --error-unmatch config/google_keys.env >/dev/null 2>&1; then fail 'config/google_keys.env is still tracked; run ./PUSH_TO_GITHUB.sh to untrack it'; fi
grep -q '__CAIRODRIVE_EMBEDDED_GOOGLE_PLACES_KEY__' payload/cairodrive-google-search-only.js || fail 'inert Places placeholder missing'
grep -q '__CAIRODRIVE_EMBEDDED_GOOGLE_ROUTES_KEY__' payload/cairodrive-google-search-only.js || fail 'inert Routes placeholder missing'
! grep -q 'embed_google_keys.py' payload/build_patch.sh || fail 'build still embeds Google keys'
! grep -q 'config/google_keys.env' payload/build_patch.sh || fail 'build still depends on tracked Google key config'
grep -q 'frida-compile "$ROOT/cairodrive-google-search-only.js"' payload/build_patch.sh || fail 'Frida in-place module-resolution fix missing'
grep -q 'stagingCleared=' payload/cairodrive-google-search-only.js || fail 'runtime key migration cleanup marker missing'
grep -q '/data/local/tmp/gpk' provision_google_key.sh || fail 'runtime Places provisioning path missing'
grep -q '/data/local/tmp/grk' provision_google_key.sh || fail 'runtime Routes provisioning path missing'
grep -q 'places.googleapis.com' payload/helper/com/cairodrive/search/AsyncHttp.java || fail 'Places allowlist missing'
grep -q 'routes.googleapis.com' payload/helper/com/cairodrive/search/AsyncHttp.java || fail 'Routes allowlist missing'
grep -q 'MAX_RESPONSE_CHARS = 4 \* 1024 \* 1024' payload/helper/com/cairodrive/search/AsyncHttp.java || fail 'HTTP response cap missing'
grep -q 'MAX_STATES = 32' payload/helper/com/cairodrive/search/AsyncHttp.java || fail 'HTTP state cap missing'
grep -q "return false; // missing duration evidence" payload/traffic-core.mjs || fail 'traffic missing-duration fail-closed rule missing'
grep -q 'jamRunM>=300' payload/traffic-core.mjs || fail 'long-jam fallback gate missing'
grep -q "allowBackup','false" tools/rewrite_manifest.py || fail 'allowBackup hardening missing'
grep -q 'Manifest.permission.CAPTURE_AUDIO_OUTPUT' tools/rewrite_manifest.py || fail 'manifest malformed permission cleanup missing'

# 4) Signing/build policy. The committed key is intentionally TEST ONLY.
KS='ci/test-signing/cairodrive-drive-test.jks'
[[ -f "$KS" ]] || fail 'drive-test signing key missing'
keytool -list -keystore "$KS" -storepass 'cairodrive-drive-test-2026' -alias cairodrive >/dev/null || fail 'drive-test key invalid'
[[ "$(sha256sum "$KS" | awk '{print $1}')" == '9fa250ded8cb6ab097157f0ebc5edaa88a002dea346563984e255547c00ed232' ]] || fail 'drive-test key changed unexpectedly'
grep -q 'committed-drive-test-key' build_cairodrive.sh || fail 'zero-setup signing fallback missing'
grep -q 'push:' .github/workflows/build.yml || fail 'push trigger missing'
grep -q 'reassemble-base-apk.sh' .github/workflows/build.yml || fail 'self-contained base APK CI missing'
! grep -q 'secrets\.' .github/workflows/build.yml || fail 'workflow unexpectedly requires GitHub Secrets'
grep -q 'CairoDrive-v22.3-DRIVE-TEST-com.cairodrive.app' .github/workflows/build.yml || fail 'artifact name mismatch'
grep -q 'startSimulationWithRoute' tools/preflight.py || fail 'future-target simulation gate missing'
grep -q 'ExternalCh' tools/preflight.py || fail 'future-target CH gate missing'
grep -q 'tools/preflight.py' payload/build_patch.sh || fail 'standalone build future preflight missing'
grep -q 'tools/preflight.py' ci/update-base-apk.sh || fail 'future base-update preflight missing'
python3 - <<'PYORDER'
from pathlib import Path
s=Path('ci/update-base-apk.sh').read_text()
assert s.index('tools/preflight.py') < s.index('rm -f "$PARTS"/magic-earth-base.apk.part-*')
PYORDER
grep -q "APKTOOL_VERSION='3.0.3'" ci/install-deps.sh || fail 'Apktool pin missing'
grep -q 'dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423' ci/install-deps.sh || fail 'Apktool SHA-256 pin missing'

# 5) Required repository docs/helpers.
for f in README.md DEEP_REVERSE_ENGINEERING_AUDIT.md FUTURE_APK_COMPATIBILITY.md INSTALL_DRIVE_TEST.sh provision_google_key.sh PUSH_TO_GITHUB.sh config/google_keys.env.example experiments/run_route_algo_ab_simulation.sh; do [[ -f "$f" ]] || fail "missing $f"; done

printf '%s\n' \
  'VERIFY_REPO: PASS' \
  'configured base APK: PASS' \
  'route/simulation target surface: PASS' \
  'search/nav/traffic/native-filter selftests: PASS' \
  'runtime-only Google key provisioning + no embedded keys: PASS' \
  'Google host/body/state HTTP hardening: PASS' \
  'Level-3 missing-delay guard: PASS' \
  'manifest backup/permission hygiene: PASS' \
  'zero-secret GitHub Actions drive-test signing: PASS' \
  'GitHub source parts all <50 MiB: PASS'
