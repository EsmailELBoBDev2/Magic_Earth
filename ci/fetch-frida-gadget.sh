#!/usr/bin/env bash
set -euo pipefail
VERSION="${FRIDA_VERSION:-17.17.0}"
OUT="${1:-$PWD/input/frida-gadget-android-arm64.so}"
ASSET="frida-gadget-${VERSION}-android-arm64.so.xz"
URL="https://github.com/frida/frida/releases/download/${VERSION}/${ASSET}"
mkdir -p "$(dirname "$OUT")"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

curl -fL --retry 3 --retry-all-errors "$URL" -o "$tmp/$ASSET"
# GitHub release assets expose a sha256 digest. Verify it when gh/API access is available.
if command -v gh >/dev/null 2>&1; then
  digest="$(GH_TOKEN="${GH_TOKEN:-}" gh api "repos/frida/frida/releases/tags/$VERSION" --jq ".assets[] | select(.name==\"$ASSET\") | .digest" 2>/dev/null | head -1 || true)"
  if [[ "$digest" == sha256:* ]]; then
    expected="${digest#sha256:}"
    echo "$expected  $tmp/$ASSET" | sha256sum -c -
  else
    echo 'Warning: GitHub asset digest unavailable; continuing with pinned release/version.' >&2
  fi
fi
xz -dc "$tmp/$ASSET" > "$OUT"
file "$OUT" | grep -qiE 'ELF 64-bit.*ARM aarch64|ELF 64-bit.*ARM64' || { file "$OUT"; echo 'unexpected Frida Gadget architecture' >&2; exit 1; }
echo "Frida Gadget $VERSION ready: $OUT"
