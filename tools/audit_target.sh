#!/usr/bin/env bash
set -euo pipefail
APK="${1:?usage: audit_target.sh source.apk}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
unzip -q "$APK" 'classes*.dex' 'lib/arm64-v8a/libGEM.so' 'lib/arm64-v8a/libapp.so' -d "$TMP"
strings "$TMP"/lib/arm64-v8a/*.so "$TMP"/classes*.dex 2>/dev/null > "$TMP/all.strings"
for n in 'RoutePreferences_avoidTraffic' 'getBetterRouteTimeDistanceToFork' 'LaneImage' 'getLaneImage' 'getSignpostInstruction' 'getJunctionImage' 'SocialOverlay_prepareReporting' 'SocialOverlay_report' 'SoundPlayingService_playText'; do
  printf '%-42s ' "$n"; if grep -Fqm1 "$n" "$TMP/all.strings"; then echo YES; else echo NO; fi
done
