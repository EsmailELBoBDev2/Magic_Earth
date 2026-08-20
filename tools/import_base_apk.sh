#!/usr/bin/env bash
set -euo pipefail
APK="${1:?usage: tools/import_base_apk.sh /path/to/MagicEarth.apk}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$APK" ]] || { echo "ERROR: APK not found: $APK" >&2; exit 1; }
mkdir -p "$ROOT/base_apk_parts"
rm -f "$ROOT/base_apk_parts"/base.apk.part.* "$ROOT/base_apk_parts/SHA256.txt" "$ROOT/base_apk_parts/ORIGINAL_NAME.txt"
sha256sum "$APK" | awk '{print $1"  base.apk"}' > "$ROOT/base_apk_parts/SHA256.txt"
basename "$APK" > "$ROOT/base_apk_parts/ORIGINAL_NAME.txt"
split -b 24M -d -a 3 "$APK" "$ROOT/base_apk_parts/base.apk.part."
echo "Imported $(basename "$APK") into Git-safe 24 MiB chunks:"
ls -lh "$ROOT/base_apk_parts"/base.apk.part.*
"$ROOT/ci/reassemble-base-apk.sh" "$ROOT/input/base.apk" >/dev/null
echo "Reassembly verification: PASS"
rm -f "$ROOT/input/base.apk"
