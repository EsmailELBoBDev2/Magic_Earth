#!/usr/bin/env bash
set -euo pipefail
PKG="${TARGET_PACKAGE:-com.cairodrive.app}"
DEST="${1:-$PWD/cairodrive-device-logs-$(date +%Y%m%d-%H%M%S)}"
REMOTE="/sdcard/Android/data/$PKG/files/cairodrive/logs"
mkdir -p "$DEST"
adb get-state >/dev/null
echo "Pulling CairoDrive 3-day rotated logs..."
if adb shell "test -d '$REMOTE'" >/dev/null 2>&1; then
  adb pull "$REMOTE/." "$DEST/"
else
  echo "Direct external-files path was not readable; trying run-as export..."
  adb shell "run-as '$PKG' sh -c 'cd files/cairodrive/logs 2>/dev/null && tar -cf /data/local/tmp/cairodrive-logs.tar .'" || {
    echo "ERROR: could not access app log directory" >&2; exit 1;
  }
  adb pull /data/local/tmp/cairodrive-logs.tar "$DEST/"
  adb shell rm -f /data/local/tmp/cairodrive-logs.tar
  tar -xf "$DEST/cairodrive-logs.tar" -C "$DEST"
  rm -f "$DEST/cairodrive-logs.tar"
fi
echo "Logs: $DEST"
find "$DEST" -maxdepth 1 -type f \
  \( -name 'cairodrive-*-3d-*.log' -o -name 'cairodrive-*-3d-*.log.gz' \) \
  -printf '%f %k KB\n' 2>/dev/null | sort || true
