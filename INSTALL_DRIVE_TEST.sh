#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
APK="${1:-$ROOT/CairoDrive-v22.3.apk}"
command -v adb >/dev/null || { echo 'ERROR: adb is required (Android platform-tools).' >&2; exit 1; }
[[ -f "$APK" ]] || { echo "ERROR: APK not found: $APK" >&2; exit 2; }
adb get-state >/dev/null 2>&1 || { echo 'ERROR: connect/authorize your Android device first.' >&2; exit 3; }
echo 'Installing signed CairoDrive drive-test APK...'
if ! adb install -r "$APK"; then
  cat >&2 <<'MSG'
Install failed. If an older com.cairodrive.app build was signed with a different test key,
uninstalling it will delete that app's local data:
  adb uninstall com.cairodrive.app
Then rerun this script. Stock com.generalmagic.magicearth is unaffected.
MSG
  exit 4
fi
adb shell monkey -p com.cairodrive.app -c android.intent.category.LAUNCHER 1 >/dev/null
echo 'Installed: com.cairodrive.app'
echo 'Google Places/Routes key: embedded in this private drive-test build.'
echo 'Optional key rotation override: ./provision_google_key.sh'
echo
echo 'Device setup complete.'
echo 'Optional native route-algorithm simulation benchmark:'
echo '  ./run_route_algo_ab_simulation.sh'
