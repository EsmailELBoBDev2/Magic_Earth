#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ -n "${TARGET_PACKAGE:-}" ]]; then PKG="$TARGET_PACKAGE"; elif command -v adb >/dev/null 2>&1 && adb shell pm path com.cairodrive.app 2>/dev/null | grep -q '^package:'; then PKG='com.cairodrive.app'; else PKG='com.generalmagic.magicearth'; fi
command -v adb >/dev/null || { echo 'ERROR: adb not found' >&2; exit 1; }
adb get-state >/dev/null 2>&1 || { echo 'ERROR: no authorized adb device' >&2; exit 2; }
adb shell pm path "$PKG" | grep -q '^package:' || { echo "ERROR: package not installed: $PKG" >&2; exit 3; }
PLACES="${GOOGLE_PLACES_API_KEY:-}"; ROUTES="${GOOGLE_ROUTES_API_KEY:-}"; TILES="${GOOGLE_MAP_TILES_API_KEY:-}"
if [[ -z "$PLACES" ]]; then read -r -s -p 'Google Places API key: ' PLACES; echo; fi
[[ -n "$PLACES" ]] || { echo 'ERROR: Google Places key is required' >&2; exit 4; }
if [[ -z "$ROUTES" ]]; then read -r -s -p 'Google Routes API key (Enter = reuse Places key): ' ROUTES; echo; ROUTES="${ROUTES:-$PLACES}"; fi
if [[ -z "$TILES" ]]; then read -r -s -p 'Google Map Tiles API key: ' TILES; echo; fi
[[ -n "$TILES" ]] || { echo 'ERROR: Google Map Tiles key is required for Free Drive traffic' >&2; exit 5; }
TMP="$(mktemp -d)"; chmod 700 "$TMP"; trap 'unset PLACES ROUTES TILES; rm -rf "$TMP"; adb shell rm -f /data/local/tmp/gpk /data/local/tmp/grk /data/local/tmp/gtk >/dev/null 2>&1 || true' EXIT
printf '%s' "$PLACES" > "$TMP/gpk"; printf '%s' "$ROUTES" > "$TMP/grk"; printf '%s' "$TILES" > "$TMP/gtk"; chmod 600 "$TMP"/*
adb push "$TMP/gpk" /data/local/tmp/gpk >/dev/null; adb push "$TMP/grk" /data/local/tmp/grk >/dev/null; adb push "$TMP/gtk" /data/local/tmp/gtk >/dev/null
# Briefly world-readable because the non-debuggable app UID must import them; trap removes them immediately after migration.
adb shell chmod 0644 /data/local/tmp/gpk /data/local/tmp/grk /data/local/tmp/gtk
adb shell am force-stop "$PKG"; adb logcat -c; adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null
ok=0
for _ in $(seq 1 30); do if adb logcat -d -v brief -s cairodrive:I 2>/dev/null | grep -q 'GOOGLE_TILE_KEY_STATE present=yes'; then ok=1; break; fi; sleep 0.5; done
echo '=== CairoDrive credential migration ==='
adb logcat -d -v brief -s cairodrive:I 2>/dev/null | grep -E 'KEY_STATE|GOOGLE_TILE_KEY_STATE|IDENTITY_READY|CAIRODRIVE_READY' | tail -n 50 || true
[[ "$ok" -eq 1 ]] || { echo 'MAP TILES KEY MIGRATION: NO' >&2; exit 6; }
echo 'API KEY MIGRATION: YES'
