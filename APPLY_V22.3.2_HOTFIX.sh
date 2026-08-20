#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
[[ -f payload/build_patch.sh && -f VERIFY_REPO.sh ]] || { echo 'ERROR: run/extract this hotfix at the Magic_Earth repository root.' >&2; exit 2; }
# These exact-target legacy patchers are no longer called by v22.3.2. Remove
# them so future upgrades cannot accidentally use stale binary offsets.
rm -f tools/patch_libflutter.py payload/patch_manifest_extract.py
chmod +x ci/reassemble-base-apk.sh ci/update-base-apk.sh VERIFY_REPO.sh verify_patcher.sh payload/build_patch.sh
./verify_patcher.sh
./VERIFY_REPO.sh
printf '%s\n' 'v22.3.2 hotfix applied + verified.'
