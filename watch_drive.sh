#!/usr/bin/env bash
set -euo pipefail
MODE="${1:-live}"
PKG="${TARGET_PACKAGE:-com.cairodrive.app}"
PATTERN='cairodrive-v24\.3|DIAG_START|DRIVE_DIAGNOSTICS_READY|CAIRODRIVE_READY|KEY_STATE|GOOGLE_TILE_KEY_STATE|SEARCH_INTERCEPT|GOOGLE_REQUEST|GOOGLE_OK|GOOGLE_EMPTY|GOOGLE_HTTP|NATIVE_SEARCH_FALLBACK|FREE_TRAFFIC_|GOOGLE_TRAFFIC_|TRAFFIC_MAP_|NARROW_|ROADBLOCK_|NAV_SESSION|NAV_CAPTURE|STALE_ROUTE|FATAL EXCEPTION|ANR in|SIGSEGV|SIGABRT'
case "$MODE" in
  clear) adb logcat -c ;;
  live) adb logcat -v time -s cairodrive:I AndroidRuntime:E ActivityManager:E | grep --line-buffered -Ei "$PATTERN" ;;
  snapshot) adb logcat -d -v time | grep -Ei "$PATTERN" | tail -n 4000 ;;
  pull) exec "$(dirname "$0")/pull_logs.sh" ;;
  files) adb shell "ls -lah /sdcard/Android/data/$PKG/files/cairodrive/logs 2>/dev/null || true" ;;
  *) echo "usage: $0 {clear|live|snapshot|pull|files}" >&2; exit 2 ;;
esac
