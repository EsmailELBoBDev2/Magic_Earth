#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/input/base.apk}"
PARTS="$ROOT/base_apk_parts"
EXPECTED='936cff2a8cffcfad96cc68d76a22c366d2c038e5484a2c974e0d88f36906d4de'
mkdir -p "$(dirname "$OUT")"
(cd "$PARTS" && sha256sum -c PARTS_SHA256SUMS.txt)
cat "$PARTS"/magic-earth-base.apk.part-* > "$OUT.tmp"
ACTUAL="$(sha256sum "$OUT.tmp" | awk '{print $1}')"
[[ "$ACTUAL" == "$EXPECTED" ]] || { echo "ERROR: reassembled APK SHA256 $ACTUAL != $EXPECTED" >&2; rm -f "$OUT.tmp"; exit 2; }
mv "$OUT.tmp" "$OUT"
echo "Base APK reassembled and verified: $OUT"
echo "SHA256: $ACTUAL"
