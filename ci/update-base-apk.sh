#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APK="${1:-}"
[[ -n "$APK" && -f "$APK" ]] || { echo "usage: $0 /path/to/magic-earth.apk" >&2; exit 2; }
APK="$(realpath "$APK")"
PARTS="$ROOT/base_apk_parts"
mkdir -p "$PARTS"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "==> Compatibility preflight before replacing bundled base APK"
python3 "$ROOT/tools/preflight.py" "$APK" --report "$TMP/preflight.json"
python3 "$ROOT/ci/verify-target-routing-surface.py" "$APK"
echo "==> New APK passed structural compatibility gates; updating chunks"
rm -f "$PARTS"/magic-earth-base.apk.part-* "$PARTS/PARTS_SHA256SUMS.txt" "$PARTS/BASE_APK_SHA256.txt"
# Stay comfortably below GitHub's 50 MiB per-file limit used by this repo.
split -b 45M -d -a 3 "$APK" "$PARTS/magic-earth-base.apk.part-"
(
  cd "$PARTS"
  sha256sum magic-earth-base.apk.part-* > PARTS_SHA256SUMS.txt
  sha256sum "$APK" | awk '{print $1}' > BASE_APK_SHA256.txt
)
echo "Updated bundled base APK parts from: $APK"
echo "APK SHA256: $(cat "$PARTS/BASE_APK_SHA256.txt")"
echo "Now run: ./VERIFY_REPO.sh"
