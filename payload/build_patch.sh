#!/usr/bin/env bash
set -euo pipefail
APK="${1:?usage: build_patch.sh SOURCE.apk FRIDA_GADGET OUT.apk}"
GADGET="${2:?}"
OUTAPK="${3:?}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
need(){ command -v "$1" >/dev/null 2>&1 || { echo "ERROR: missing command: $1" >&2; exit 1; }; }
for c in node npm python3 unzip zip zipalign apksigner keytool javac jar sha256sum readelf; do need "$c"; done
[[ -f "$APK" ]] || { echo "ERROR: APK not found: $APK" >&2; exit 1; }
[[ -f "$GADGET" ]] || { echo "ERROR: Frida Gadget not found: $GADGET" >&2; exit 1; }
find_d8(){ if command -v d8 >/dev/null 2>&1; then command -v d8; return; fi; for b in "${ANDROID_SDK_ROOT:-}" "${ANDROID_HOME:-}" /opt/android-sdk "$HOME/Android/Sdk"; do [[ -n "$b" && -d "$b/build-tools" ]] || continue; find "$b/build-tools" -mindepth 2 -maxdepth 2 -type f -name d8 -print 2>/dev/null | sort -V | tail -1; done | tail -1; }
find_android_jar(){ for b in "${ANDROID_SDK_ROOT:-}" "${ANDROID_HOME:-}" /opt/android-sdk "$HOME/Android/Sdk"; do [[ -n "$b" && -d "$b/platforms" ]] || continue; find "$b/platforms" -mindepth 2 -maxdepth 2 -type f -name android.jar -print 2>/dev/null | sort -V | tail -1; done | tail -1; }
D8="$(find_d8)"; ANDROID_JAR="$(find_android_jar)"; [[ -x "$D8" && -f "$ANDROID_JAR" ]] || { echo 'ERROR: Android d8/android.jar missing' >&2; exit 1; }

mkdir -p "$WORK/root"
echo '==> Extracting source APK'
unzip -q "$APK" -d "$WORK/root"
for f in libapp.so libflutter.so libGEM.so; do [[ -f "$WORK/root/lib/arm64-v8a/$f" ]] || { echo "ERROR: arm64 $f missing" >&2; exit 1; }; done

# Derive libGEM globals from the exported set_dart_port function. This is the
# key v22.3 portability change: no fixed June-build addresses.
echo '==> Discovering version-specific libGEM globals from code shape'
python3 "$ROOT/../tools/discover_gem_globals.py" "$WORK/root/lib/arm64-v8a/libGEM.so" --json "$WORK/gem-globals.json" >/dev/null
DART_OFF="$(python3 -c 'import json,sys;print(hex(json.load(open(sys.argv[1]))["dart_port_offset"]))' "$WORK/gem-globals.json")"
POST_OFF="$(python3 -c 'import json,sys;print(hex(json.load(open(sys.argv[1]))["post_cobject_slot_offset"]))' "$WORK/gem-globals.json")"
echo "    dart_port=$DART_OFF post_cobject_slot=$POST_OFF"

cd "$ROOT"
if [[ ! -d node_modules/frida-java-bridge || ! -x node_modules/.bin/frida-compile ]]; then npm install --no-audit --no-fund; fi
if [[ ! -f node_modules/frida/build/frida_binding.node ]]; then npm rebuild frida >/dev/null; fi

mkdir -p "$WORK/helper-classes" "$WORK/helper-dex"
echo '==> Compiling CairoDrive helper/bootstrap DEX'
javac --release 8 -cp "$ANDROID_JAR" -d "$WORK/helper-classes" \
  "$ROOT/helper/com/cairodrive/bootstrap/CairoDriveBootstrapProvider.java" \
  "$ROOT/helper/com/cairodrive/search/AsyncHttp.java" \
  "$ROOT/helper/com/cairodrive/search/AutocompletePanel.java" \
  "$ROOT/helper/com/cairodrive/nav/NavBanner.java" \
  "$ROOT/helper/com/cairodrive/log/CairoLog.java"
jar cf "$WORK/cairodrive-helper.jar" -C "$WORK/helper-classes" .
"$D8" --min-api 21 --lib "$ANDROID_JAR" --output "$WORK/helper-dex" "$WORK/cairodrive-helper.jar" >/dev/null
[[ -s "$WORK/helper-dex/classes.dex" ]] || { echo 'ERROR: helper DEX missing' >&2; exit 1; }

node "$ROOT/../search_core_selftest.mjs"
node "$ROOT/../nav_core_selftest.mjs"
node "$ROOT/../traffic_core_selftest.mjs"
cp "$ROOT/cairodrive-google-search-only.js" "$WORK/cairodrive-agent.js"
python3 - "$WORK/cairodrive-agent.js" "$DART_OFF" "$POST_OFF" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]);s=p.read_text();vals={'__CAIRODRIVE_GEM_DART_PORT_OFFSET__':sys.argv[2],'__CAIRODRIVE_GEM_POST_COBJECT_SLOT_OFFSET__':sys.argv[3]}
for k,v in vals.items():
    if s.count(k)!=1:raise SystemExit(f'ERROR: marker {k} missing/duplicated')
    s=s.replace(k,v)
# Never compile API credentials into artifacts.
for forbidden in ('__CAIRODRIVE_BUILD_GOOGLE_KEY__','__CAIRODRIVE_BUILD_GOOGLE_ROUTES_KEY__'):
    if forbidden in s: raise SystemExit('ERROR: obsolete build-key marker remained')
p.write_text(s)
PY
./node_modules/.bin/frida-compile "$WORK/cairodrive-agent.js" -o "$WORK/libgadget.script.so" -S -c
[[ -s "$WORK/libgadget.script.so" ]] || { echo 'ERROR: agent bundle missing' >&2; exit 1; }

# Optional performance-only AOT patch. Unknown future compiler layouts simply
# keep the stock debounce; correctness does not depend on this optimization.
python3 "$ROOT/../tools/patch_search_debounce.py" "$WORK/root/lib/arm64-v8a/libapp.so"

# Never assume classes7.dex remains free on future releases.
DEXNUM="$(python3 - "$WORK/root" <<'PY'
from pathlib import Path
import re,sys
m=1
for p in Path(sys.argv[1]).glob('classes*.dex'):
 n=p.name
 x=1 if n=='classes.dex' else int(re.fullmatch(r'classes(\d+)\.dex',n).group(1))
 m=max(m,x)
print(m+1)
PY
)"
cp "$WORK/helper-dex/classes.dex" "$WORK/root/classes${DEXNUM}.dex"
echo "    injected helper DEX: classes${DEXNUM}.dex"

# v22.3 uses a manifest ContentProvider bootstrap instead of target-specific
# libflutter binary edits. libflutter.so remains byte-for-byte stock.
cp "$GADGET" "$WORK/root/lib/arm64-v8a/libgadget.so"
cp "$ROOT/libgadget.config.so" "$WORK/root/lib/arm64-v8a/libgadget.config.so"
cp "$WORK/libgadget.script.so" "$WORK/root/lib/arm64-v8a/libgadget.script.so"
cp "$ROOT/libcairodrive_filter.so" "$WORK/root/lib/arm64-v8a/libcairodrive_filter.so"
python3 "$ROOT/patch_manifest_extract.py" "$WORK/root/AndroidManifest.xml"
rm -rf "$WORK/root/META-INF"
(
 cd "$WORK/root"
 zip -q -0 "$WORK/unsigned.apk" resources.arsc lib/arm64-v8a/libgadget.so lib/arm64-v8a/libgadget.config.so lib/arm64-v8a/libgadget.script.so lib/arm64-v8a/libcairodrive_filter.so
 find . -type f ! -path './resources.arsc' ! -path './lib/arm64-v8a/libgadget.so' ! -path './lib/arm64-v8a/libgadget.config.so' ! -path './lib/arm64-v8a/libgadget.script.so' ! -path './lib/arm64-v8a/libcairodrive_filter.so' ! -path './META-INF/*' -print0 | xargs -0 zip -q "$WORK/unsigned.apk"
)
zipalign -f 4 "$WORK/unsigned.apk" "$WORK/aligned.apk"
KS="${CAIRODRIVE_KEYSTORE:-$WORK/intermediate.keystore}"
if [[ ! -f "$KS" ]]; then keytool -genkeypair -noprompt -keystore "$KS" -storepass changeit -keypass changeit -alias cairodrivepatch -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=CairoDrive Intermediate,O=Local,C=EG' >/dev/null 2>&1; fi
apksigner sign --ks "$KS" --ks-pass pass:changeit --key-pass pass:changeit --ks-key-alias cairodrivepatch --out "$OUTAPK" "$WORK/aligned.apk"
apksigner verify --verbose "$OUTAPK" >/dev/null
printf 'BUILD PATCH STAGE PASS\nAPK=%s\nlibapp_sha256=%s\ngem_dart_port=%s\ngem_post_cobject_slot=%s\nhelper_dex=classes%s.dex\nlibflutter_patch=none-provider-bootstrap\n' "$OUTAPK" "$(sha256sum "$WORK/root/lib/arm64-v8a/libapp.so"|awk '{print $1}')" "$DART_OFF" "$POST_OFF" "$DEXNUM"
