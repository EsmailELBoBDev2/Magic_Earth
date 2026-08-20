#!/usr/bin/env bash
set -euo pipefail
APK="${1:?usage: build_aab.sh RENAMED.apk OUT.aab KEYSTORE ALIAS STOREPASS KEYPASS}"
OUT="${2:?}"
KS="${3:?}"
ALIAS="${4:?}"
STOREPASS="${5:?}"
KEYPASS="${6:?}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
need(){ command -v "$1" >/dev/null || { echo "Missing command: $1" >&2; exit 1; }; }
for c in java jarsigner keytool unzip zip curl python3 sha256sum; do need "$c"; done
find_sdk_tool(){
  local n="$1" p base cand
  if command -v "$n" >/dev/null 2>&1; then command -v "$n"; return; fi
  for base in "${ANDROID_SDK_ROOT:-}" "${ANDROID_HOME:-}" /opt/android-sdk "$HOME/Android/Sdk"; do
    [[ -n "$base" && -d "$base/build-tools" ]] || continue
    cand="$(find "$base/build-tools" -mindepth 2 -maxdepth 2 -type f -name "$n" -print 2>/dev/null | sort -V | tail -1)"
    [[ -n "$cand" ]] && { echo "$cand"; return; }
  done
  return 1
}
AAPT2="$(find_sdk_tool aapt2 || true)"
[[ -x "$AAPT2" ]] || { echo "aapt2 not found; install Android SDK build-tools." >&2; exit 1; }

BUNDLETOOL_CMD=()
if command -v bundletool >/dev/null 2>&1; then
  BUNDLETOOL_CMD=(bundletool)
elif [[ -n "${BUNDLETOOL_JAR:-}" && -f "${BUNDLETOOL_JAR}" ]]; then
  BUNDLETOOL_CMD=(java -jar "$BUNDLETOOL_JAR")
else
  JAR="$ROOT/tools/cache/bundletool-all-1.18.3.jar"
  mkdir -p "$(dirname "$JAR")"
  if [[ ! -s "$JAR" ]]; then
    echo "==> bundletool 1.18.3 not found; downloading pinned official release"
    curl -fL --retry 3 --retry-all-errors -o "$JAR.tmp" \
      'https://github.com/google/bundletool/releases/download/1.18.3/bundletool-all-1.18.3.jar'
    echo 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29  '"$JAR.tmp" | sha256sum -c -
    mv "$JAR.tmp" "$JAR"
  fi
  BUNDLETOOL_CMD=(java -jar "$JAR")
fi
bt(){ "${BUNDLETOOL_CMD[@]}" "$@"; }

echo "==> Converting rebuilt APK resources to protobuf format for AAB"
"$AAPT2" convert -o "$WORK/proto.apk" --output-format proto "$APK"
mkdir -p "$WORK/proto" "$WORK/base/manifest" "$WORK/base/dex"
unzip -q "$WORK/proto.apk" -d "$WORK/proto"
[[ -f "$WORK/proto/AndroidManifest.xml" ]] || { echo "proto APK has no AndroidManifest.xml" >&2; exit 1; }
cp "$WORK/proto/AndroidManifest.xml" "$WORK/base/manifest/AndroidManifest.xml"
if [[ -f "$WORK/proto/resources.pb" ]]; then cp "$WORK/proto/resources.pb" "$WORK/base/resources.pb";
elif [[ -f "$WORK/proto/resources.arsc" ]]; then
  echo "ERROR: aapt2 convert did not emit resources.pb; refusing to invent an AAB resource table." >&2; exit 1
else echo "ERROR: proto resource table missing" >&2; exit 1; fi

for d in res assets lib; do [[ -d "$WORK/proto/$d" ]] && cp -a "$WORK/proto/$d" "$WORK/base/$d"; done
find "$WORK/proto" -maxdepth 1 -type f -name 'classes*.dex' -print0 | while IFS= read -r -d '' f; do cp "$f" "$WORK/base/dex/$(basename "$f")"; done
# Preserve other root payload files, but never copy old APK signatures.
mkdir -p "$WORK/base/root"
python3 - "$WORK/proto" "$WORK/base/root" <<'PY'
import os, shutil, sys
from pathlib import Path
src,dst=map(Path,sys.argv[1:])
skip={'AndroidManifest.xml','resources.pb','resources.arsc'}
for p in src.iterdir():
    if p.name in skip or p.name in {'res','assets','lib','META-INF'} or (p.is_file() and p.name.startswith('classes') and p.suffix=='.dex'): continue
    q=dst/p.name
    if p.is_dir(): shutil.copytree(p,q,dirs_exist_ok=True)
    else: shutil.copy2(p,q)
PY
rmdir "$WORK/base/root" 2>/dev/null || true
(
  cd "$WORK/base"
  find . -type f -print0 | sort -z | xargs -0 zip -q "$WORK/base.zip"
)

echo "==> Building Android App Bundle"
rm -f "$OUT"
bt build-bundle --modules="$WORK/base.zip" --output="$OUT"
bt validate --bundle="$OUT"

echo "==> Signing AAB with upload key"
jarsigner -keystore "$KS" -storepass "$STOREPASS" -keypass "$KEYPASS" \
  -digestalg SHA-256 "$OUT" "$ALIAS" >/dev/null

# Android app/upload signing certificates are normally self-signed. `jarsigner
# -verify -strict` returns warning code 4 even when the ZIP signature is valid.
# Verify integrity non-strictly, then bind the signer fingerprint to the key.
jarsigner -verify "$OUT" >/dev/null
EXPECTED_CERT_SHA256="$(keytool -list -v -keystore "$KS" -storepass "$STOREPASS" -alias "$ALIAS" 2>/dev/null \
  | sed -n 's/^[[:space:]]*SHA256:[[:space:]]*//p' | head -1 | tr -d '[:space:]:')"
ACTUAL_CERT_SHA256="$(keytool -printcert -jarfile "$OUT" 2>/dev/null \
  | sed -n 's/^[[:space:]]*SHA256:[[:space:]]*//p' | head -1 | tr -d '[:space:]:')"
[[ -n "$EXPECTED_CERT_SHA256" && "$ACTUAL_CERT_SHA256" == "$EXPECTED_CERT_SHA256" ]] || {
  echo "ERROR: AAB signer certificate does not match selected keystore" >&2
  echo "expected=$EXPECTED_CERT_SHA256" >&2
  echo "actual=$ACTUAL_CERT_SHA256" >&2
  exit 1
}
unzip -Z1 "$OUT" | grep -Eq '^META-INF/[^/]+\.(SF|RSA|DSA|EC)$' || {
  echo 'ERROR: AAB has no JAR signature metadata' >&2
  exit 1
}
echo "AAB signature: PASS (integrity + expected signer fingerprint)"

echo "==> Building universal APK from AAB as a structural smoke test"
APKS="$WORK/universal.apks"
bt build-apks --bundle="$OUT" --output="$APKS" --mode=universal --overwrite \
  --ks="$KS" --ks-pass="pass:$STOREPASS" --ks-key-alias="$ALIAS" --key-pass="pass:$KEYPASS" >/dev/null
unzip -q "$APKS" universal.apk -d "$WORK/universal"
cp "$WORK/universal/universal.apk" "${OUT%.aab}-universal.apk"

echo "AAB: $(realpath "$OUT")"
echo "AAB SHA256: $(sha256sum "$OUT" | awk '{print $1}')"
echo "Universal APK: $(realpath "${OUT%.aab}-universal.apk")"
