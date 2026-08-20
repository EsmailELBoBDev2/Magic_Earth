#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${TARGET_PACKAGE:-}" ]]; then
  PKG="$TARGET_PACKAGE"
elif command -v adb >/dev/null 2>&1 && adb shell pm path com.cairodrive.app 2>/dev/null | grep -q '^package:'; then
  PKG='com.cairodrive.app'
else
  PKG='com.generalmagic.magicearth'
fi
PLACES_KEY="${GOOGLE_PLACES_API_KEY:-}"
ROUTES_KEY="${GOOGLE_ROUTES_API_KEY:-}"
command -v adb >/dev/null || { echo "ERROR: adb not found" >&2; exit 1; }
[[ -n "$PLACES_KEY" ]] || { echo "ERROR: set GOOGLE_PLACES_API_KEY locally; the script never prints it." >&2; exit 2; }
adb get-state >/dev/null 2>&1 || { echo "ERROR: no authorized adb device" >&2; exit 3; }
adb shell pm path "$PKG" | grep -q '^package:' || { echo "ERROR: package not installed: $PKG" >&2; exit 4; }

places_tmp="$(mktemp)"; chmod 600 "$places_tmp"; printf '%s' "$PLACES_KEY" > "$places_tmp"
routes_tmp=''
if [[ -n "$ROUTES_KEY" ]]; then routes_tmp="$(mktemp)"; chmod 600 "$routes_tmp"; printf '%s' "$ROUTES_KEY" > "$routes_tmp"; fi
cleanup(){
  rm -f "$places_tmp" ${routes_tmp:+"$routes_tmp"}
  adb shell rm -f /data/local/tmp/gpk /data/local/tmp/grk >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Package: $PKG"
echo "Staging Google Places key temporarily (not echoed)..."
adb push "$places_tmp" /data/local/tmp/gpk >/dev/null
adb shell chmod 0644 /data/local/tmp/gpk
if [[ -n "$routes_tmp" ]]; then
  echo "Staging separate Google Routes key temporarily (not echoed)..."
  adb push "$routes_tmp" /data/local/tmp/grk >/dev/null
  adb shell chmod 0644 /data/local/tmp/grk
else
  echo "No GOOGLE_ROUTES_API_KEY supplied; CairoDrive will use the Places key for Routes if that key/project permits Routes API."
fi

adb shell am force-stop "$PKG"
adb logcat -c
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null

ok=0
for _ in $(seq 1 30); do
  if adb logcat -d -v brief -s cairodrive:I 2>/dev/null | grep -q 'KEY_STATE places=yes routes=yes'; then ok=1; break; fi
  sleep 0.5
done

echo "=== key migration evidence ==="
adb logcat -d -v brief -s cairodrive:I 2>/dev/null | grep -E 'BOOT agent=v22.3|KEY_STATE|IDENTITY_READY|CAIRODRIVE_READY' | tail -n 40 || true
if [[ "$ok" -ne 1 ]]; then
  echo "GOOGLE KEY MIGRATION: NO" >&2
  exit 5
fi
echo "GOOGLE KEY MIGRATION: YES"
