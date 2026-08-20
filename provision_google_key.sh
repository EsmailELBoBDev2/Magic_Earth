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
if [[ -z "$PLACES_KEY" ]]; then
  read -r -s -p 'Google Places API key (not echoed): ' PLACES_KEY; echo
fi
[[ -n "$PLACES_KEY" ]] || { echo "ERROR: Places key is empty" >&2; exit 2; }
if [[ -z "$ROUTES_KEY" && -t 0 ]]; then
  read -r -s -p 'Google Routes key (Enter to reuse Places key): ' ROUTES_KEY; echo
fi
[[ -n "$ROUTES_KEY" ]] || ROUTES_KEY="$PLACES_KEY"
adb get-state >/dev/null 2>&1 || { echo "ERROR: no authorized adb device" >&2; exit 3; }
adb shell pm path "$PKG" | grep -q '^package:' || { echo "ERROR: package not installed: $PKG" >&2; exit 4; }

places_tmp="$(mktemp)"; routes_tmp="$(mktemp)"
chmod 600 "$places_tmp" "$routes_tmp"
printf '%s' "$PLACES_KEY" > "$places_tmp"
printf '%s' "$ROUTES_KEY" > "$routes_tmp"
cleanup(){
  rm -f "$places_tmp" "$routes_tmp"
  adb shell rm -f /data/local/tmp/gpk /data/local/tmp/grk >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Package: $PKG"
echo "Temporarily staging restricted Google keys; values are never printed..."
adb push "$places_tmp" /data/local/tmp/gpk >/dev/null
adb push "$routes_tmp" /data/local/tmp/grk >/dev/null
# /data/local/tmp is shell-owned; world-read is required only for the few milliseconds
# before the app migrates the keys into its private sandbox. The agent deletes both files
# immediately after a synchronous SharedPreferences commit; this trap deletes them too.
adb shell chmod 0644 /data/local/tmp/gpk /data/local/tmp/grk

adb shell am force-stop "$PKG"
adb logcat -c
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null

ok=0
for _ in $(seq 1 30); do
  if adb logcat -d -v brief -s cairodrive:I 2>/dev/null | grep -q 'KEY_STATE places=yes routes=yes'; then ok=1; break; fi
  sleep 0.5
done

echo "=== key migration evidence ==="
adb logcat -d -v brief -s cairodrive:I 2>/dev/null \
  | grep -E 'BOOT agent=v22.3-kiss-fast-reroute|KEY_STATE|IDENTITY_READY|CAIRODRIVE_READY' \
  | tail -n 40 || true
if [[ "$ok" -ne 1 ]]; then
  echo "GOOGLE KEY MIGRATION: NO" >&2
  exit 5
fi
adb shell test ! -e /data/local/tmp/gpk -a ! -e /data/local/tmp/grk >/dev/null 2>&1 \
  && echo 'Plaintext staging cleanup: PASS' \
  || echo 'Plaintext staging cleanup: host trap will remove remaining staging files'
echo "GOOGLE KEY MIGRATION: YES"
