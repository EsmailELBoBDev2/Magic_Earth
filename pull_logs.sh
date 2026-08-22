#!/usr/bin/env bash
set -euo pipefail
PKG="${TARGET_PACKAGE:-com.cairodrive.app}"
DEST="${1:-$PWD/cairodrive-device-logs-$(date +%Y%m%d-%H%M%S)}"
REMOTE="/sdcard/Android/data/$PKG/files/cairodrive/logs"
mkdir -p "$DEST"
adb get-state >/dev/null

echo "Package: $PKG"
echo "Pulling persistent CairoDrive logs..."
if adb shell "test -d '$REMOTE'" >/dev/null 2>&1; then
  adb pull "$REMOTE/." "$DEST/" >/dev/null
else
  echo "ERROR: no persistent log directory yet: $REMOTE" >&2
  echo "Launch the installed app once, then retry." >&2
  exit 1
fi
{
  echo "=== date ==="; date -Is
  echo "=== package ==="; adb shell dumpsys package "$PKG" | grep -E 'versionName=|versionCode=' | head -n 8 || true
  echo "=== meminfo ==="; adb shell dumpsys meminfo "$PKG" || true
  echo "=== cpuinfo ==="; adb shell dumpsys cpuinfo | grep -i "$PKG" || true
  echo "=== gfxinfo ==="; adb shell dumpsys gfxinfo "$PKG" || true
  echo "=== battery ==="; adb shell dumpsys battery || true
  echo "=== thermal ==="; adb shell dumpsys thermalservice 2>/dev/null || true
} > "$DEST/device-snapshot.txt" 2>&1
adb logcat -d -v time -s cairodrive:I AndroidRuntime:E ActivityManager:E > "$DEST/logcat-snapshot.txt" 2>&1 || true

ARCHIVE="$DEST.tar.gz"
tar -C "$(dirname "$DEST")" -czf "$ARCHIVE" "$(basename "$DEST")"
echo "Logs: $DEST"
echo "Archive: $ARCHIVE"
find "$DEST" -maxdepth 1 -type f -printf '%f %k KB\n' 2>/dev/null | sort
