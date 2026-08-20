#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; OUTDIR="${1:-$ROOT/out}"; DIST="${2:-$ROOT/dist}"
mkdir -p "$DIST"
for f in CairoDrive-v22.3.apk CairoDrive-v22.3.aab CairoDrive-v22.3-universal.apk BUILD_REPORT.txt; do [[ -f "$OUTDIR/$f" ]] || { echo "ERROR: missing $OUTDIR/$f" >&2; exit 1; }; cp "$OUTDIR/$f" "$DIST/"; done
for f in VERIFY_OUTPUT.txt preflight.json DEEP_REVERSE_ENGINEERING_AUDIT.md FUTURE_COMPATIBILITY.md; do [[ -f "$ROOT/$f" ]] && cp "$ROOT/$f" "$DIST/"; done
cp "$ROOT/INSTALL_DRIVE_TEST.sh" "$ROOT/provision_google_key.sh" "$ROOT/watch_drive.sh" "$ROOT/pull_logs.sh" "$DIST/"
cp "$ROOT/experiments/run_route_algo_ab_simulation.py" "$DIST/"
cp "$ROOT/experiments/run_route_algo_ab_simulation.sh" "$DIST/"
cp "$ROOT/experiments/AUTO_SIM_AB.md" "$DIST/"
(
 cd "$ROOT"
 zip -qr "$DIST/CairoDrive-v22.3-patcher-source.zip" . \
   -x '.git/*' 'node_modules/*' 'payload/node_modules/*' 'input/*' 'out/*' 'dist/*' \
      'base_apk_parts/*' '*.apk' '*.aab' '*.apks' '*.keystore' '*.jks' '*.p12'
)
(
 cd "$DIST"
 sha256sum CairoDrive-v22.3.apk CairoDrive-v22.3.aab CairoDrive-v22.3-universal.apk CairoDrive-v22.3-patcher-source.zip BUILD_REPORT.txt > SHA256SUMS.txt
)
