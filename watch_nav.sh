#!/usr/bin/env bash
set -euo pipefail
MODE="${1:-live}"
PATTERN='BOOT agent=|MAGICLANE_TRAFFIC|NAV_ENUMS|NAV_ROUTE_PREFS|DRIVE_ASSIST_SHOW|ROUTE_RECOMPUTE_|ROUTE_UPDATED|BETTER_ROUTE_|GOOGLE_TRAFFIC_PAUSED|NARROW_EVIDENCE|NARROW_ROADBLOCK|ARRIVAL_OPEN_CHECK|CAIRODRIVE_READY|GOOGLE_|AUTOCOMPLETE_|GOOGLE_TRAFFIC_|SEARCH_INTERCEPT|NATIVE_SEARCH_FALLBACK|NATIVE_INJECT|FATAL EXCEPTION|ANR in|SIGSEGV|SIGABRT'
case "$MODE" in
  clear)
    adb logcat -c
    echo "logcat cleared"
    ;;
  live)
    adb logcat -v time | grep --line-buffered -E "$PATTERN"
    ;;
  snapshot)
    tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
    adb logcat -d -b all -v time > "$tmp"
    echo '=== v22.3 KISS + FAST-REROUTE SNAPSHOT ==='
    grep -E "$PATTERN" "$tmp" | tail -n 400 || true
    echo
    echo '=== COUNTS ==='
    for m in \
      'BOOT agent=' \
      'MAGICLANE_TRAFFIC_ENABLED mode=online' \
      'MAGICLANE_TRAFFIC_ENABLE_FAILED' \
      'NAV_ENUMS' \
      'NAV_ROUTE_PREFS_PATCHED' \
      'NAV_ROUTE_PREFS_UNCHANGED reason=non-car' \
      'NAV_ROUTE_PREFS_UNCHANGED reason=no-known-fields' \
      'DRIVE_ASSIST_SHOW' \
      'ROUTE_RECOMPUTE_STARTED' \
      'ROUTE_RECOMPUTE_DONE' \
      'ROUTE_RECOMPUTE_E2E' \
      'BETTER_ROUTE_INVALIDATED' \
      'NARROW_EVIDENCE' \
      'NARROW_ROADBLOCK_APPLIED' \
      'GOOGLE_TRAFFIC_REQUEST' \
      'GOOGLE_TRAFFIC_OK' \
      'GOOGLE_TRAFFIC_MATCH' \
      'GOOGLE_TRAFFIC_ROADBLOCK' \
      'GOOGLE_TRAFFIC_FALLBACK' \
      'NAV_ROADBLOCK_APPLIED reason=google-traffic' \
      'ARRIVAL_OPEN_CHECK' \
      'SEARCH_INTERCEPT' \
      'GOOGLE_OK' \
      'NATIVE_SEARCH_FALLBACK' \
      'FATAL EXCEPTION' \
      'ANR in' \
      'SIGSEGV' \
      'SIGABRT'; do
      printf '%-52s %s\n' "$m" "$(grep -F -c "$m" "$tmp" || true)"
    done
    echo
    echo '=== ROUTE PATCH DETAILS ==='
    grep -E 'NAV_ENUMS|NAV_ROUTE_PREFS_PATCHED|NAV_ROUTE_PREFS_UNCHANGED' "$tmp" | tail -n 60 || true
    echo
    echo '=== DRIVE / RECOMPUTE DETAILS ==='
    grep -E 'DRIVE_ASSIST_SHOW|ROUTE_RECOMPUTE_|ROUTE_UPDATED|BETTER_ROUTE_|NARROW_EVIDENCE|NARROW_ROADBLOCK|GOOGLE_TRAFFIC_|NAV_ROADBLOCK_APPLIED|ARRIVAL_OPEN_CHECK' "$tmp" | tail -n 120 || true
    echo
    echo '=== RECOMPUTE LATENCY ==='
    "$(dirname "$0")/tools/summarize_recompute.py" < "$tmp"
    ;;
  recompute) adb logcat -d -b all -v time | "$(dirname "$0")/tools/summarize_recompute.py" ;;
  *) echo "Usage: $0 {clear|live|snapshot|recompute}" >&2; exit 2 ;;
esac
