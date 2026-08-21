#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
APK="${1:-$ROOT/input/base.apk}"
PATCH_VERSION="${CAIRODRIVE_PATCH_VERSION:-22.3}"
PATCH_VERSION_SAFE="$(printf '%s' "$PATCH_VERSION" | tr -cs '0-9A-Za-z._-' '_')"
TARGET_PACKAGE="${TARGET_PACKAGE:-com.cairodrive.app}"
APP_LABEL="${APP_LABEL:-CairoDrive}"
OUTDIR="${OUTDIR:-$ROOT/out}"
GADGET="${FRIDA_GADGET:-$HOME/.cache/frida/gadget-android-arm64.so}"
mkdir -p "$OUTDIR"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
need(){ command -v "$1" >/dev/null 2>&1 || { echo "ERROR: missing command: $1" >&2; exit 1; }; }
for c in python3 unzip zip zipalign apksigner keytool jarsigner java javac jar node npm apktool base64 sha256sum; do need "$c"; done
[[ -f "$APK" ]] || { echo "ERROR: source APK not found: $APK" >&2; exit 1; }
[[ -f "$GADGET" ]] || { echo "ERROR: Frida Gadget not found: $GADGET" >&2; exit 1; }
find_aapt2(){ if command -v aapt2 >/dev/null 2>&1; then command -v aapt2; return; fi; local base cand; for base in "${ANDROID_SDK_ROOT:-}" "${ANDROID_HOME:-}" /opt/android-sdk "$HOME/Android/Sdk"; do [[ -n "$base" && -d "$base/build-tools" ]] || continue; cand="$(find "$base/build-tools" -mindepth 2 -maxdepth 2 -type f -name aapt2 -print 2>/dev/null | sort -V | tail -1)"; [[ -n "$cand" ]] && { echo "$cand"; return; }; done; return 1; }
AAPT2="$(find_aapt2 || true)"; [[ -x "$AAPT2" ]] || { echo 'ERROR: aapt2 not found' >&2; exit 1; }

# Structural/fail-closed compatibility gate before mutation.
python3 "$ROOT/tools/preflight.py" "$APK" --aapt2 "$AAPT2" --report "$WORK/preflight.json"

prepare_keystore(){
  if [[ -n "${CAIRODRIVE_KEYSTORE:-}" && -f "${CAIRODRIVE_KEYSTORE}" ]]; then KS="$(realpath "$CAIRODRIVE_KEYSTORE")"; return; fi
  if [[ -n "${CAIRODRIVE_KEYSTORE_BASE64:-}" ]]; then printf '%s' "$CAIRODRIVE_KEYSTORE_BASE64" | tr -d '\r\n ' | base64 -d > "$WORK/upload.keystore"; KS="$WORK/upload.keystore"; return; fi
  local f="${CAIRODRIVE_KEYSTORE_B64_FILE:-}"
  [[ -n "$f" ]] || { [[ -f "$ROOT/ci/signing/drive-test.keystore.b64" ]] && f="$ROOT/ci/signing/drive-test.keystore.b64"; }
  [[ -n "$f" && -f "$f" ]] || { echo 'ERROR: signing keystore missing' >&2; exit 1; }
  tr -d '\r\n ' < "$f" | base64 -d > "$WORK/upload.keystore"; KS="$WORK/upload.keystore"
}
prepare_keystore
STOREPASS="${ANDROID_KEYSTORE_PASSWORD:-cairodrive-drive-test-2026}"; ALIAS="${ANDROID_KEY_ALIAS:-cairodrive}"; KEYPASS="${ANDROID_KEY_PASSWORD:-$STOREPASS}"
keytool -list -keystore "$KS" -storepass "$STOREPASS" -alias "$ALIAS" >/dev/null

# Build against the materialized upstream APK first; intermediate signer is irrelevant.
TMPKS="$WORK/intermediate.keystore"
( cd "$ROOT/payload" && CAIRODRIVE_KEYSTORE="$TMPKS" ./build_patch.sh "$APK" "$GADGET" "$WORK/patched-oldpkg.apk" )

# Rewrite only manifest package identity; preserve original component class namespace.
apktool d -f -s -o "$WORK/decoded" "$WORK/patched-oldpkg.apk" >/dev/null
VERSION_NAME_SUFFIX="${CAIRODRIVE_VERSION_NAME_SUFFIX:--cairodrive23}"
python3 "$ROOT/tools/rewrite_manifest.py" "$WORK/decoded/AndroidManifest.xml" --old-package com.generalmagic.magicearth --new-package "$TARGET_PACKAGE" --label "$APP_LABEL" "--version-name-suffix=$VERSION_NAME_SUFFIX"
python3 - "$WORK/decoded/apktool.yml" <<'PY'
import sys,re
p=sys.argv[1]; s=open(p,encoding='utf-8').read(); s=re.sub(r'(?m)^renameManifestPackage:.*\n','',s); open(p,'w',encoding='utf-8').write(s)
PY
apktool b -o "$WORK/repacked-unsigned.apk" "$WORK/decoded" >/dev/null
zipalign -f 4 "$WORK/repacked-unsigned.apk" "$WORK/CairoDrive-aligned.apk"
FINAL_APK="$OUTDIR/CairoDrive-v${PATCH_VERSION_SAFE}.apk"
apksigner sign --ks "$KS" --ks-pass "pass:$STOREPASS" --key-pass "pass:$KEYPASS" --ks-key-alias "$ALIAS" --out "$FINAL_APK" "$WORK/CairoDrive-aligned.apk"
apksigner verify --verbose --print-certs "$FINAL_APK" >/dev/null
PKG="$($AAPT2 dump badging "$FINAL_APK" | sed -n "s/^package: name='\([^']*\)'.*/\1/p" | head -1)"
[[ "$PKG" == "$TARGET_PACKAGE" ]] || { echo "ERROR: final package=$PKG expected=$TARGET_PACKAGE" >&2; exit 1; }
python3 "$ROOT/tools/compare_resource_ids.py" "$AAPT2" "$WORK/patched-oldpkg.apk" "$FINAL_APK" >/dev/null

CERT_SHA1="$(keytool -list -v -keystore "$KS" -storepass "$STOREPASS" -alias "$ALIAS" 2>/dev/null | sed -n 's/^[[:space:]]*SHA1:[[:space:]]*//p' | head -1)"
CERT_SHA256="$(keytool -list -v -keystore "$KS" -storepass "$STOREPASS" -alias "$ALIAS" 2>/dev/null | sed -n 's/^[[:space:]]*SHA256:[[:space:]]*//p' | head -1)"

FINAL_AAB="$OUTDIR/CairoDrive-v${PATCH_VERSION_SAFE}.aab"
BUNDLETOOL_JAR="${BUNDLETOOL_JAR:-}" "$ROOT/tools/build_aab.sh" "$WORK/CairoDrive-aligned.apk" "$FINAL_AAB" "$KS" "$ALIAS" "$STOREPASS" "$KEYPASS"
UNIVERSAL="${FINAL_AAB%.aab}-universal.apk"
UPKG="$($AAPT2 dump badging "$UNIVERSAL" | sed -n "s/^package: name='\([^']*\)'.*/\1/p" | head -1)"
[[ "$UPKG" == "$TARGET_PACKAGE" ]] || { echo "ERROR: AAB universal package=$UPKG expected=$TARGET_PACKAGE" >&2; exit 1; }

cat > "$OUTDIR/BUILD_REPORT.txt" <<EOF
CairoDrive v${PATCH_VERSION_SAFE} Places + Traffic Advisory + Drive Assist
source_sha256=$(sha256sum "$APK"|awk '{print $1}')
target_package=$TARGET_PACKAGE
apk_sha256=$(sha256sum "$FINAL_APK"|awk '{print $1}')
aab_sha256=$(sha256sum "$FINAL_AAB"|awk '{print $1}')
keystore_file_sha256=$(sha256sum "$KS"|awk '{print $1}')
signing_cert_sha1=$CERT_SHA1
signing_cert_sha256=$CERT_SHA256
google_api_keys_embedded=no
google_api_keys_runtime_provisioned=yes
compatibility_report=$(tr -d '\n' < "$WORK/preflight.json")
EOF
printf '\nBUILD SUCCESS\nAPK: %s\nAAB: %s\nPackage: %s\n' "$FINAL_APK" "$FINAL_AAB" "$TARGET_PACKAGE"
