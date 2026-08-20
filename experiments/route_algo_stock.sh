#!/usr/bin/env bash
set -euo pipefail
PKG="${TARGET_PACKAGE:-com.cairodrive.app}"
adb get-state >/dev/null
adb shell rm -f /data/local/tmp/cairodrive_route_algo
adb shell am force-stop "$PKG" || true
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null
echo "CairoDrive route algorithm experiment: STOCK MagicEarth/default"
echo "Confirm with: adb logcat -d -s cairodrive:I | grep ROUTE_ALGO_ENUMS | tail -1"
