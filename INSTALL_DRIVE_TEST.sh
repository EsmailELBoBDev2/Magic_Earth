#!/usr/bin/env bash
set -euo pipefail
APK="${1:-CairoDrive-v22.3.apk}"
command -v adb >/dev/null || { echo 'ERROR: adb missing' >&2; exit 1; }
[[ -f "$APK" ]] || { echo "ERROR: $APK missing" >&2; exit 1; }
adb get-state >/dev/null
adb install -r "$APK"
echo 'Installed com.cairodrive.app.'
read -r -s -p 'Google Places/Routes API key (input hidden): ' KEY; echo
[[ -n "$KEY" ]] || { echo 'No key entered; install complete, Google search/traffic not provisioned.'; exit 0; }
GOOGLE_PLACES_API_KEY="$KEY" GOOGLE_ROUTES_API_KEY="$KEY" ./provision_google_key.sh
unset KEY
echo 'Ready. For route-algorithm simulation benchmark: ./run_route_algo_ab_simulation.sh'
