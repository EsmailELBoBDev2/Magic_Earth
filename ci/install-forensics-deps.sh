#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/ci/install-deps.sh"

# Extra static-analysis tools. Keep optional tooling best-effort so one upstream outage does not erase diagnostics.
sudo apt-get install -y --no-install-recommends \
  cmake ninja-build pkg-config libicu-dev libcapstone-dev \
  python3-pyelftools python3-requests ripgrep tree || true

# JADX 1.5.6 (2026-07-10), SHA256 pinned.
JADX_VERSION=1.5.6
JADX_SHA256=545ea2be9c242511bc145755cf4bda2485ade42966e096f8b4d3da2a230e8974
JADX_ZIP="/tmp/jadx-${JADX_VERSION}.zip"
if curl -fL --retry 3 --retry-all-errors -o "$JADX_ZIP" "https://github.com/skylot/jadx/releases/download/v${JADX_VERSION}/jadx-${JADX_VERSION}.zip"; then
  if echo "$JADX_SHA256  $JADX_ZIP" | sha256sum -c -; then
    sudo rm -rf /opt/jadx
    sudo mkdir -p /opt/jadx
    sudo unzip -q "$JADX_ZIP" -d /opt/jadx
    sudo ln -sf /opt/jadx/bin/jadx /usr/local/bin/jadx
  else
    echo 'WARNING: JADX checksum mismatch; skipping JADX rather than running unverified code.' >&2
  fi
else
  echo 'WARNING: JADX download failed; continuing with Apktool/native analysis.' >&2
fi

# Blutter pinned to the newest reviewed main commit at bundle-generation time (2026-08-18).
BLUTTER_COMMIT=4a60ac648bf448c5a7596437243bcd0b9376fdf0
sudo rm -rf /opt/blutter
if git clone -q --no-checkout https://github.com/worawit/blutter.git /tmp/blutter-src; then
  if git -C /tmp/blutter-src fetch -q --depth=1 origin "$BLUTTER_COMMIT" && git -C /tmp/blutter-src checkout -q --detach "$BLUTTER_COMMIT"; then
    sudo mv /tmp/blutter-src /opt/blutter
  else
    rm -rf /tmp/blutter-src
    echo 'WARNING: pinned Blutter commit fetch failed; continuing without Blutter.' >&2
  fi
else
  echo 'WARNING: Blutter clone failed; continuing without Blutter.' >&2
fi

command -v jadx >/dev/null 2>&1 && jadx --version || true
[[ -d /opt/blutter ]] && echo "Blutter commit: $(git -C /opt/blutter rev-parse HEAD)" || true
