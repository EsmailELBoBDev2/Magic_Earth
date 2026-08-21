# CairoDrive Google Routes traffic-advisory implementation reference

> **Status:** the core advisory architecture described here is implemented in CairoDrive v22.3 and statically verified. This document remains the design/reference for tuning it after real drive logs.

## Contract/product caveat
Current standard Google Maps Platform service terms contain a non-Google-map restriction for Routes content. v22.3 implements this as an experimental personal integration at the user's request. Do not treat this as a production/distribution compliance template.

## Goal / invariant
Magic Lane/Magic Earth remains the sole route renderer and turn-by-turn navigator. Google Routes is an **invisible congestion sensor/adviser** only.

Never:
- draw a Google route or traffic layer on Magic Earth;
- start Google navigation;
- fabricate undocumented Magic Lane edge weights.

When high-confidence heavy traffic is detected on the active Magic Lane corridor, request a temporary **Magic Lane** navigation roadblock over the jammed stretch and let Magic Lane recalculate the replacement route.

## Implemented request policy
Endpoint:
`POST https://routes.googleapis.com/directions/v2:computeRoutes`

Request:
- `travelMode=DRIVE`
- `routingPreference=TRAFFIC_AWARE`
- `extraComputations=[TRAFFIC_ON_POLYLINE]`
- high-quality encoded polyline
- origin/current location + destination
- up to eight `via:true` intermediate points sampled from the active Magic Lane route to keep Google's advisory route on approximately the same corridor

Minimal response fields:
- `routes.duration`
- `routes.distanceMeters`
- `routes.polyline.encodedPolyline`
- `routes.travelAdvisory.speedReadingIntervals`

`TRAFFIC_AWARE` is intentionally preferred over `TRAFFIC_AWARE_OPTIMAL` here because the external result is advisory and lower latency matters more than replacing Magic Lane's route search.

## Cadence / economy
Request only when:
- a destination becomes active/meaningfully changes; or
- the previous traffic sample is roughly 180 seconds old while navigation remains active.

Never request traffic on every GPS tick.
Never fan out one Routes call per Magic Lane road section.
No automatic retry loop.

Places and Routes use separate single-thread workers so traffic latency cannot stall POI search.

## Matching
Decode Google's encoded polyline and expand `SpeedReadingInterval`s into `NORMAL`, `SLOW`, and `TRAFFIC_JAM` edges.

Do **not** match by nearest XY coordinate alone. Grade-separated Cairo roads can overlap in map coordinates.

For each active Magic Lane sample require:
- nearest Google edge distance <=35 m;
- heading delta <=40°.

Compute:
- matched coverage;
- NORMAL/SLOW/JAM matched distance;
- longest contiguous JAM run.

If coverage <0.65, Google traffic is ignored and Magic Lane remains untouched.

## Action gate
A Google jam is actionable only when all guards pass:
- contiguous `TRAFFIC_JAM` run >=120 m;
- jam starts roughly 80–3500 m ahead;
- >=500 m of route remains beyond it;
- high route-match coverage;
- same section has not been avoided in last ~10 minutes;
- no traffic roadblock in last ~90 seconds.

The roadblock length is bounded (~900 m max). If the exact ahead-section roadblock overload is unavailable on-device, fail open and do nothing.

## Failure handling
- 401/403: disable Google Routes for session.
- 429: cooldown (~5 min).
- 5xx: cooldown (~1 min).
- network/parse/low-match/roadblock ABI uncertainty: keep Magic Lane route unchanged.

No Google failure is allowed to block Magic Lane navigation.

## Diagnostics
Expected markers include:
- `GOOGLE_TRAFFIC_REQUEST`
- `GOOGLE_TRAFFIC_OK`
- `GOOGLE_TRAFFIC_MATCH`
- `GOOGLE_TRAFFIC_KEEP`
- `GOOGLE_TRAFFIC_ROADBLOCK`
- `GOOGLE_TRAFFIC_FALLBACK`
- `NAV_ROADBLOCK_APPLIED reason=google-traffic`

Never log API keys.

## Real-drive tuning targets
Use Cairo drive logs to validate/tune:
- 35 m spatial tolerance;
- 40° heading tolerance;
- 65% coverage threshold;
- 120 m jam run threshold;
- roadblock look-ahead and max length;
- 180 s refresh cadence.

Do not loosen thresholds merely to make the feature fire more often. False positive reroutes are worse than missing a weak traffic match.
