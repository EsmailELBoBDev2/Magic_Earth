# CairoDrive v22.3 implementation status

## Implemented

### Search / Places
- Places Autocomplete/Text/Nearby + native fallback.
- 3-codepoint gate, 400 ms stock debounce, max 5 predictions, session token and stale cancellation.
- Search Along Route and active-navigation traffic-aware routing summaries.
- Adaptive selected Details masks.
- navigation point / preferred entrance arrival selection.
- moved-place chains, business status, open-at-arrival, Egypt/Arabic handling.

### Routing / traffic
- Magic Lane sole route renderer/navigator.
- Minimal owned prefs: Fastest, avoidTraffic All, avoid unpaved, accurate waypoint approach, motion heading.
- Initial terrain profile for strong narrow-road evidence; active reroute terrain disabled.
- Active reroute alternatives `Never`; initial alternatives remain stock.
- Correct current-position-relative roadblocks for Google jams and narrow/path evidence.
- Google traffic advisory map-match and spatial edge index.
- Better-route invalidation, 40 ms fallback switch, cooldown and rollback.

### Recompute instrumentation
- Target: 1000 ms.
- `WaitingRoute` target-compatible start signal.
- `onRouteUpdated`/Running completion fallback.
- Optional route-calculation callbacks when exposed.
- CairoDrive roadblock trigger-to-route-update E2E measurement.
- Traffic advisory cancellation when native recompute begins.
- Percentile summary tool via `watch_drive.sh recompute` / `watch_nav.sh recompute`.

### QoL / KISS
- Supplemental-only CairoDrive overlay.
- Compact `⋯ CairoDrive` action menu.
- Dynamic current-country social categories; stock safety/social enablement untouched.
- Speed/restriction/status/traffic/waypoint/arrival assists retained.

## Deliberately not shipped
- Fake 200 cm truck width.
- Forced avoid-turnaround.
- Forced online/timestamp/result-details/path/default route fields.
- Full duplicate maneuver/lane/ETA overlay by default.
- Google route rendering/navigation takeover.
- Second routing engine.
- Local-only reroute forcing without runtime evidence/maps guarantee.
- Route-detail degradation for benchmark purposes.
- Premium/license/entitlement bypass.
