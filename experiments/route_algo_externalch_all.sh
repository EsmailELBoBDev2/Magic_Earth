#!/usr/bin/env bash
set -euo pipefail
PKG="${TARGET_PACKAGE:-com.cairodrive.app}"
adb get-state >/dev/null
adb shell "printf '%s\\n' externalch-all > /data/local/tmp/cairodrive_route_algo && chmod 644 /data/local/tmp/cairodrive_route_algo"
adb shell am force-stop "$PKG" || true
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null
echo "CairoDrive route algorithm experiment: ExternalCh for ALL intercepted car route calculations"
echo "This is benchmark-only, not the production default."
