#!/usr/bin/env bash
set -euo pipefail
PATCH_VERSION="${CAIRODRIVE_PATCH_VERSION:-24.3}"
PATCH_VERSION_SAFE="$(printf '%s' "$PATCH_VERSION" | tr -cs '0-9A-Za-z._-' '_')"
APK="${1:-CairoDrive-v${PATCH_VERSION_SAFE}.apk}"
command -v adb >/dev/null || { echo 'ERROR: adb missing' >&2; exit 1; }
[[ -f "$APK" ]] || { echo "ERROR: $APK missing" >&2; exit 1; }
adb get-state >/dev/null
adb install -r "$APK"
echo 'Installed com.cairodrive.app.'
echo 'Installed. Provision credentials without embedding them in the APK:'
echo '  ./provision_api_keys.sh   # hidden prompts; env vars also supported'
echo 'Use a separate Map Tiles key restricted to the Map Tiles API and set a quota cap.'
