#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="${1:-$ROOT/out}"
DIST="${2:-$ROOT/dist}"
rm -rf "$DIST"; mkdir -p "$DIST"
for f in CairoDrive-v22.3.apk CairoDrive-v22.3.aab CairoDrive-v22.3-universal.apk BUILD_REPORT.txt; do
  [[ -f "$OUTDIR/$f" ]] || { echo "artifact missing: $OUTDIR/$f" >&2; exit 1; }
  cp "$OUTDIR/$f" "$DIST/"
done
cp "$ROOT/VERIFY_OUTPUT.txt" "$DIST/" 2>/dev/null || true
cp "$ROOT/INSTALL_DRIVE_TEST.sh" "$DIST/"
cp "$ROOT/provision_google_key.sh" "$DIST/"
cp "$ROOT/watch_drive.sh" "$DIST/"
cp "$ROOT/pull_logs.sh" "$DIST/"
cp "$ROOT/experiments/run_route_algo_ab_simulation.py" "$DIST/"
cp "$ROOT/experiments/run_route_algo_ab_simulation.sh" "$DIST/"
cp "$ROOT/experiments/AUTO_SIM_AB.md" "$DIST/"
cp "$ROOT/DEEP_REVERSE_ENGINEERING_AUDIT.md" "$DIST/" 2>/dev/null || true

(
  cd "$ROOT"
  zip -qr "$DIST/CairoDrive-v22.3-patcher-source.zip" . \
    -x '.git/*' 'node_modules/*' 'payload/node_modules/*' 'input/*' 'out/*' 'dist/*' \
       'base_apk_parts/*' '*.apk' '*.aab' '*.apks' '*.keystore' '*.jks' '*.p12' 'keystore.b64'
)
(
  cd "$DIST"
  sha256sum CairoDrive-v22.3.apk CairoDrive-v22.3.aab CairoDrive-v22.3-universal.apk \
    CairoDrive-v22.3-patcher-source.zip BUILD_REPORT.txt INSTALL_DRIVE_TEST.sh provision_google_key.sh \
    run_route_algo_ab_simulation.py run_route_algo_ab_simulation.sh AUTO_SIM_AB.md > SHA256SUMS.txt
)
cat "$DIST/SHA256SUMS.txt"
