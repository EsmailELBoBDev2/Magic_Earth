#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v python3 >/dev/null || { echo 'ERROR: python3 missing' >&2; exit 1; }
command -v adb >/dev/null || { echo 'ERROR: adb missing (Android platform-tools)' >&2; exit 1; }
exec python3 "$ROOT/experiments/run_route_algo_ab_simulation.py" "$@"
