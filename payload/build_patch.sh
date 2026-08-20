#!/usr/bin/env bash
set -euo pipefail

APK="${1:-magic-earth-7-1-26-26-21db1f1b-3c81f7001.apk}"
GADGET="${2:-$HOME/.cache/frida/gadget-android-arm64.so}"
OUTAPK="${3:-MagicEarth-CairoDrive-v22.3-complete-drive-assist.apk}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d "$ROOT/.cairodrive-build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
EXPECTED_LIBAPP_SHA256='558e04e9a41aca50a3409ee7640785eedfefb23ff1fe787865b7595f029e19a4'

need(){ command -v "$1" >/dev/null 2>&1 || { echo "Missing command: $1" >&2; exit 1; }; }
for c in node npm python3 unzip zip zipalign apksigner keytool javac jar sha256sum; do need "$c"; done
[[ -f "$APK" ]] || { echo "APK not found: $APK" >&2; exit 1; }
[[ -f "$GADGET" ]] || { echo "Frida Gadget not found: $GADGET" >&2; exit 1; }

# Future-safe gate: direct users of payload/build_patch.sh must receive the same
# structural compatibility check as build_cairodrive.sh. Unknown future builds
# are accepted only when the required Magic Lane/Flutter surface is still present.
python3 "$ROOT/../tools/preflight.py" "$APK" --report "$WORK/preflight.json"

find_d8(){
  if command -v d8 >/dev/null 2>&1; then command -v d8; return 0; fi
  local base cand
  for base in "${ANDROID_SDK_ROOT:-}" "${ANDROID_HOME:-}" /opt/android-sdk "$HOME/Android/Sdk"; do
    [[ -n "$base" && -d "$base/build-tools" ]] || continue
    cand="$(find "$base/build-tools" -mindepth 2 -maxdepth 2 -type f -name d8 -print 2>/dev/null | sort -V | tail -1)"
    [[ -z "$cand" ]] || { printf '%s\n' "$cand"; return 0; }
  done
  return 1
}
find_android_jar(){
  local base cand
  for base in "${ANDROID_SDK_ROOT:-}" "${ANDROID_HOME:-}" /opt/android-sdk "$HOME/Android/Sdk"; do
    [[ -n "$base" && -d "$base/platforms" ]] || continue
    cand="$(find "$base/platforms" -mindepth 2 -maxdepth 2 -type f -name android.jar -print 2>/dev/null | sort -V | tail -1)"
    [[ -z "$cand" ]] || { printf '%s\n' "$cand"; return 0; }
  done
  return 1
}
D8="$(find_d8 || true)"
ANDROID_JAR="$(find_android_jar || true)"
[[ -n "$D8" ]] || { echo "Android d8 not found. Install Android SDK build-tools or set ANDROID_SDK_ROOT." >&2; exit 1; }
[[ -n "$ANDROID_JAR" ]] || { echo "Android platform android.jar not found." >&2; exit 1; }

cd "$ROOT"
echo "==> Installing Frida compiler dependencies"
if [[ ! -d node_modules/frida-java-bridge || ! -x node_modules/.bin/frida-compile ]]; then
  npm install --no-audit --no-fund
fi
if [[ ! -f node_modules/frida/build/frida_binding.node ]]; then
  npm rebuild frida >/dev/null
fi
[[ -f node_modules/frida/build/frida_binding.node ]] || { echo "frida_binding.node missing after install/rebuild" >&2; exit 1; }

echo "==> Compiling CairoDrive HTTPS + navigation-banner helpers"
mkdir -p "$WORK/helper-classes" "$WORK/helper-dex"
javac --release 8 -cp "$ANDROID_JAR" -d "$WORK/helper-classes" \
  "$ROOT/helper/com/cairodrive/search/AsyncHttp.java" \
  "$ROOT/helper/com/cairodrive/search/AutocompletePanel.java" \
  "$ROOT/helper/com/cairodrive/nav/NavBanner.java" \
  "$ROOT/helper/com/cairodrive/log/CairoLog.java" \
  "$ROOT/helper/com/cairodrive/bootstrap/GadgetBootstrapProvider.java"
jar cf "$WORK/cairodrive-helper.jar" -C "$WORK/helper-classes" .
"$D8" --min-api 21 --lib "$ANDROID_JAR" --output "$WORK/helper-dex" "$WORK/cairodrive-helper.jar" >/dev/null
[[ -s "$WORK/helper-dex/classes.dex" ]] || { echo "CairoDrive helper DEX missing" >&2; exit 1; }

node "$ROOT/../search_core_selftest.mjs"
node "$ROOT/../nav_core_selftest.mjs"
node "$ROOT/../traffic_core_selftest.mjs"
echo "==> Bundling v22.3.3 Places + traffic-advisory + drive-assist agent"
# Compile the entry file in-place so frida-compile resolves search-core.mjs,
# nav-core.mjs and traffic-core.mjs from their real source directory. v22.3.2
# copied only the entry file to a temp directory, which broke these imports in CI.
# Google keys are intentionally NOT embedded in the APK/AAB; runtime provisioning
# migrates them into CairoDrive-private SharedPreferences after installation.
./node_modules/.bin/frida-compile "$ROOT/cairodrive-google-search-only.js" -o "$WORK/libgadget.script.so" -S -c
[[ -s "$WORK/libgadget.script.so" ]] || { echo "Agent bundle missing" >&2; exit 1; }

mkdir -p "$WORK/root"
echo "==> Extracting exact Magic Earth target"
unzip -q "$APK" -d "$WORK/root"
[[ -f "$WORK/root/lib/arm64-v8a/libapp.so" ]] || { echo "libapp.so missing" >&2; exit 1; }
ACTUAL_LIBAPP_SHA256="$(sha256sum "$WORK/root/lib/arm64-v8a/libapp.so" | awk '{print $1}')"
if [[ "$ACTUAL_LIBAPP_SHA256" == "$EXPECTED_LIBAPP_SHA256" ]]; then
  CAIRODRIVE_TARGET_MODE=exact
else
  CAIRODRIVE_TARGET_MODE=future-compatible
  echo "==> Future-target compatibility mode: libapp=$ACTUAL_LIBAPP_SHA256"
  echo "    Exact binary-only optimizations will be skipped; exported/API hooks remain fail-open."
fi
DEX_TARGET="$(python3 - "$WORK/root" <<'PYDEX'
import re,sys
from pathlib import Path
root=Path(sys.argv[1])
nums=[]
for p in root.glob('classes*.dex'):
    m=re.fullmatch(r'classes(\d*)\.dex',p.name)
    if not m: continue
    nums.append(1 if m.group(1)=='' else int(m.group(1)))
n=max(nums or [1])+1
print(f'classes{n}.dex')
PYDEX
)"
echo "==> Helper DEX slot: $DEX_TARGET"

# Search-as-you-type is intentionally conservative: the exact stock 1000 ms
# debounce is only reduced to 400 ms, while CairoDrive itself requires >=3
# useful codepoints, serializes requests on one worker, and cancels stale calls.
if [[ "$CAIRODRIVE_TARGET_MODE" == exact ]]; then
  python3 "$ROOT/../tools/patch_search_debounce.py" "$WORK/root/lib/arm64-v8a/libapp.so"
else
  echo "==> Skipping exact-offset search debounce patch on future target"
fi
cp "$WORK/helper-dex/classes.dex" "$WORK/root/$DEX_TARGET"
echo "==> Gadget load bootstrap: private ContentProvider (no libflutter binary patch)"
cp "$GADGET" "$WORK/root/lib/arm64-v8a/libgadget.so"
cp "$ROOT/libgadget.config.so" "$WORK/root/lib/arm64-v8a/libgadget.config.so"
cp "$WORK/libgadget.script.so" "$WORK/root/lib/arm64-v8a/libgadget.script.so"
cp "$ROOT/libcairodrive_filter.so" "$WORK/root/lib/arm64-v8a/libcairodrive_filter.so"
echo "==> Manifest native-lib extraction will be set during decoded CairoDrive repack"
rm -rf "$WORK/root/META-INF"

(
  cd "$WORK/root"
  zip -q -0 "$WORK/unsigned.apk" resources.arsc \
    lib/arm64-v8a/libflutter.so lib/arm64-v8a/libgadget.so \
    lib/arm64-v8a/libgadget.config.so lib/arm64-v8a/libgadget.script.so \
    lib/arm64-v8a/libcairodrive_filter.so
  find . -type f \
    ! -path './resources.arsc' \
    ! -path './lib/arm64-v8a/libflutter.so' \
    ! -path './lib/arm64-v8a/libgadget.so' \
    ! -path './lib/arm64-v8a/libgadget.config.so' \
    ! -path './lib/arm64-v8a/libgadget.script.so' \
    ! -path './lib/arm64-v8a/libcairodrive_filter.so' \
    ! -path './META-INF/*' -print0 | xargs -0 zip -q "$WORK/unsigned.apk"
)
zipalign -f 4 "$WORK/unsigned.apk" "$WORK/aligned.apk"
zipalign -c -v 4 "$WORK/aligned.apk" >/dev/null

KS="${CAIRODRIVE_KEYSTORE:-$ROOT/cairodrive-patch.keystore}"
PATCHER_DIR="$(cd "$ROOT/.." && pwd)"
PARENT_DIR="$(cd "$PATCHER_DIR/.." && pwd)"
for prior in \
  "$PARENT_DIR/magic-earth-cairodrive-patcher-v10.8.1-boot-safe/payload/cairodrive-patch.keystore" \
  "$PARENT_DIR/magic-earth-cairodrive-patcher-v10.8-hazard-dedupe/payload/cairodrive-patch.keystore" \
  "$PARENT_DIR/magic-earth-cairodrive-patcher-v10.7-all-remaining/payload/cairodrive-patch.keystore" \
  "$PARENT_DIR/cairodrive-blutter-native-v8.2/cairodrive-patch.keystore"; do
  if [[ ! -f "$KS" && -f "$prior" ]]; then
    echo "==> Reusing prior CairoDrive signing key: $prior"
    cp "$prior" "$KS"
  fi
done
if [[ ! -f "$KS" ]]; then
  echo "==> Creating persistent local signing key"
  keytool -genkeypair -noprompt -keystore "$KS" -storepass changeit -keypass changeit \
    -alias cairodrivepatch -keyalg RSA -keysize 2048 -validity 10000 \
    -dname 'CN=CairoDrive Local Patch, OU=Local, O=Local, C=EG' >/dev/null 2>&1
fi

rm -f "$OUTAPK" "$OUTAPK.idsig"
apksigner sign --ks "$KS" --ks-pass pass:changeit --key-pass pass:changeit \
  --ks-key-alias cairodrivepatch --out "$OUTAPK" "$WORK/aligned.apk"
apksigner verify --verbose --print-certs "$OUTAPK" >/dev/null
CERT="$(keytool -list -v -keystore "$KS" -storepass changeit 2>/dev/null | awk -F': ' '/SHA1:/{print $2; exit}')"

cat <<REPORT

============================================================
BUILD SUCCESSFUL — CairoDrive v22.3 KISS + FAST-REROUTE
APK: $(realpath "$OUTAPK")
SHA256: $(sha256sum "$OUTAPK" | awk '{print $1}')
Android package: com.generalmagic.magicearth
Patch signing SHA-1: $CERT

ACTIVE:
  - Google Places API (New): Autocomplete + Text/Nearby Search with stock Magic Earth fallback
  - adaptive selected Place Details field masks; navigation/contact data always, lifestyle fields only for matching place types
  - native Magic Earth LandmarkList injection; stock Magic Earth/Magic Lane remains sole route renderer/navigator
  - minimal car routing patch: Fastest + avoidTraffic=All + avoidUnpavedRoads + accurate waypoint approach + fresh heading
  - terrain profile only on initial calculateRoute requests; active-navigation requests disable it and use alternatives=Never for fast reroute
  - Google Routes traffic remains advisory only; strong matched jams may trigger a corrected distance-ahead Magic Lane roadblock; in-flight Google traffic work is cancelled when native recompute starts
  - native better-route invalidation cancels pending auto-switch; stock callback gets first chance, CairoDrive fallback delay is 40 ms
  - route recalculation timing uses WaitingRoute/onRouteUpdated plus optional callbacks and end-to-end roadblock timing; target is <1000 ms
  - compact supplemental overlay only for CairoDrive-specific traffic/restriction/status/waypoint/speed/arrival alerts
  - one small CairoDrive action button opens Report / Pause media / Repeat; report categories come from Magic Lane for the current country
  - >=3 Unicode codepoints, exact stock debounce 400 ms, session token, stale cancellation, max 5 predictions
  - casual Nearby category browsing stays distance-ranked; traffic-aware routing summaries are enabled only during active navigation

REMOVED / PRESERVED STOCK DEFAULTS:
  - no fake 200 cm truckProfile width on a normal car
  - no forced avoidTurnAroundInstruction
  - no forced alternatives=Always, resultDetails, pathAlgorithm, balanced sorting, accurateTrackMatch, max-distance, online/timestamp defaults
  - no forced enableSafetyCamera / enableSocialReports; current Magic Earth state and regional behavior are respected
  - no second routing engine, Google route rendering, speculative Places prefetch, or persistent full Places cache
============================================================
REPORT
