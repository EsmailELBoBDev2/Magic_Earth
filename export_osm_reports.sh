#!/usr/bin/env bash
set -euo pipefail
PKG="${TARGET_PACKAGE:-com.cairodrive.app}"
OUT="${1:-cairodrive-osm-traffic-calming.geojson}"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
adb get-state >/dev/null
# run-as is unavailable for release packages on many devices, so use the app's
# external-files path created by CairoDrive. Android shell can normally read it.
REMOTE="/sdcard/Android/data/$PKG/files/cairodrive/osm_traffic_calming.geojsonl"
adb pull "$REMOTE" "$TMP" >/dev/null || { echo "No local speed-calming reports found at $REMOTE" >&2; exit 1; }
python3 "$(cd "$(dirname "$0")" && pwd)/tools/osm_reports_to_geojson.py" "$TMP" > "$OUT"
echo "Wrote $OUT"
python3 - "$OUT" <<'PY'
import json,sys
x=json.load(open(sys.argv[1],encoding='utf-8')); print('features=',len(x.get('features',[])))
PY
