#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="${1:-$ROOT/out}"
DIST="${2:-$ROOT/dist}"
PATCH_VERSION="${CAIRODRIVE_PATCH_VERSION:-24.3}"
PATCH_VERSION_SAFE="$(printf '%s' "$PATCH_VERSION" | tr -cs '0-9A-Za-z._-' '_')"
PREFIX="CairoDrive-v${PATCH_VERSION_SAFE}"

mkdir -p "$DIST"

# Build outputs are mandatory.
for f in "${PREFIX}.apk" "${PREFIX}.aab" "${PREFIX}-universal.apk" BUILD_REPORT.txt; do
  [[ -f "$OUTDIR/$f" ]] || { echo "ERROR: missing $OUTDIR/$f" >&2; exit 1; }
  cp "$OUTDIR/$f" "$DIST/"
done

# Optional build/audit evidence. These moved under docs/ in v24.x.
for f in \
  VERIFY_OUTPUT.txt \
  preflight.json \
  docs/DEEP_REVERSE_ENGINEERING_AUDIT.md \
  docs/FUTURE_COMPATIBILITY.md \
  docs/AUDIT_2026-08-22_V24.3.md; do
  [[ -f "$ROOT/$f" ]] && cp "$ROOT/$f" "$DIST/"
done

# Drive-test support files shipped beside the APK.
for f in \
  INSTALL_DRIVE_TEST.sh \
  provision_api_keys.sh \
  watch_drive.sh \
  pull_logs.sh; do
  [[ -f "$ROOT/$f" ]] || { echo "ERROR: missing support file: $ROOT/$f" >&2; exit 1; }
  cp "$ROOT/$f" "$DIST/"
done

# Full patcher/source snapshot without generated/local-heavy data.
(
  cd "$ROOT"
  zip -qr "$DIST/${PREFIX}-patcher-source.zip" . \
    -x '.git/*' 'node_modules/*' 'payload/node_modules/*' 'input/*' 'out/*' 'dist/*' \
       'archives/*' '.cairodrive-*-backup/*' 'cairodrive-real-drive-*/*' 'cairodrive-device-logs-*/*' \
       'base_apk_parts/*' '*.apk' '*.aab' '*.apks' '*.keystore' '*.jks' '*.p12' '*.tar.gz'
)

(
  cd "$DIST"
  sha256sum \
    "${PREFIX}.apk" \
    "${PREFIX}.aab" \
    "${PREFIX}-universal.apk" \
    "${PREFIX}-patcher-source.zip" \
    BUILD_REPORT.txt > SHA256SUMS.txt
)

echo "PACKAGE ARTIFACTS: PASS — ${PREFIX}"
