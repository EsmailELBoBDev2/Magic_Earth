#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$ROOT/ci/reassemble-base-apk.sh" "${1:-$ROOT/input/base.apk}"
