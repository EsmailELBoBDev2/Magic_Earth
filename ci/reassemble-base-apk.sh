#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/input/base.apk}"
PARTS=("$ROOT"/base_apk_parts/base.apk.part.*)
[[ -e "${PARTS[0]}" ]] || { echo 'ERROR: base APK chunks missing' >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"
cat "${PARTS[@]}" > "$OUT"
EXPECTED="$(awk '{print $1}' "$ROOT/base_apk_parts/SHA256.txt")"
ACTUAL="$(sha256sum "$OUT"|awk '{print $1}')"
[[ "$ACTUAL" == "$EXPECTED" ]] || { echo "ERROR: reassembled APK hash mismatch expected=$EXPECTED actual=$ACTUAL" >&2; rm -f "$OUT"; exit 1; }
echo "Base APK reassembled + SHA256 verified: $ACTUAL"
