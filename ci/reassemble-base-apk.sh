#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/input/base.apk}"
PARTS="$ROOT/base_apk_parts"
EXPECTED_FILE="$PARTS/BASE_APK_SHA256.txt"
[[ -s "$EXPECTED_FILE" ]] || { echo "ERROR: missing $EXPECTED_FILE" >&2; exit 2; }
EXPECTED="$(tr -d '[:space:]' < "$EXPECTED_FILE")"
[[ "$EXPECTED" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "ERROR: invalid base APK SHA256 file" >&2; exit 2; }
mkdir -p "$(dirname "$OUT")"
(cd "$PARTS" && sha256sum -c PARTS_SHA256SUMS.txt)
cat "$PARTS"/magic-earth-base.apk.part-* > "$OUT.tmp"
ACTUAL="$(sha256sum "$OUT.tmp" | awk '{print $1}')"
[[ "$ACTUAL" == "$EXPECTED" ]] || { echo "ERROR: reassembled APK SHA256 $ACTUAL != $EXPECTED" >&2; rm -f "$OUT.tmp"; exit 2; }
mv "$OUT.tmp" "$OUT"
echo "Base APK reassembled and verified: $OUT"
echo "SHA256: $ACTUAL"
