#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
APK="${1:-$HOME/Downloads/magic-earth-7-1-26-26-21db1f1b-3c81f7001.apk}"
GADGET="${2:-$HOME/.cache/frida/gadget-android-arm64.so}"
OUT="${3:-$HOME/Downloads/MagicEarth-CairoDrive-v22.3-complete-drive-assist.apk}"
PKG="com.generalmagic.magicearth"

"$ROOT/verify_patcher.sh"
"$ROOT/payload/build_patch.sh" "$APK" "$GADGET" "$OUT"

new_sha="$(apksigner verify --print-certs "$OUT" 2>/dev/null | awk -F': ' '/certificate SHA-1 digest:/{print toupper($2); exit}')"
installed="$(adb shell pm path "$PKG" 2>/dev/null | head -1 | sed 's/^package://' | tr -d '\r')"
if [[ -n "$installed" ]]; then
  tmp="$(mktemp --suffix=.apk)"; trap 'rm -f "$tmp"' EXIT
  adb pull "$installed" "$tmp" >/dev/null
  old_sha="$(apksigner verify --print-certs "$tmp" 2>/dev/null | awk -F': ' '/certificate SHA-1 digest:/{print toupper($2); exit}')"
  echo "Installed signer SHA-1: $old_sha"
  echo "New APK signer SHA-1:   $new_sha"
  if [[ -n "$old_sha" && "$old_sha" != "$new_sha" ]]; then
    echo "REFUSING INSTALL: signer mismatch. Rebuild with CAIRODRIVE_KEYSTORE pointing to the matching prior key." >&2
    exit 20
  fi
  adb install -r "$OUT"
else
  adb install "$OUT"
fi

adb shell am force-stop "$PKG"
adb logcat -c
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null
sleep 3

echo '=== startup evidence ==='
adb logcat -d -v brief -s cairodrive:I | grep -E 'BOOT agent=v22.3-kiss-fast-reroute|KEY_STATE|IDENTITY_READY|GEM_FILTER|MAGICLANE_TRAFFIC|NAV_ENUMS|LANE_ASSIST_READY|CAIRODRIVE_READY' | tail -n 60 || true

echo
if [[ -n "${GOOGLE_PLACES_API_KEY:-}" ]]; then
  TARGET_PACKAGE="$PKG" GOOGLE_PLACES_API_KEY="$GOOGLE_PLACES_API_KEY" "$ROOT/provision_google_key.sh"
else
  echo "Google key was not passed to this shell. Provision it with:"
  echo "  export GOOGLE_PLACES_API_KEY='YOUR_NEW_KEY'"
  echo "  $ROOT/provision_google_key.sh"
fi
