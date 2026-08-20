# CairoDrive v22.3 — GitHub CI + routing-policy sweep

Date: 2026-08-20. Exact binary target: Magic Earth / Magic Lane 1.9.0, build 7.1.26.26 family.
Final package identity: `com.cairodrive.app`.

v22.3 keeps the v21.2 KISS/fast-reroute cleanup and adds the GitHub CI packaging plus an explicit three-level traffic / better-route policy. It does not introduce a second navigation engine.

## Search / destination

- Google Places Autocomplete, Text Search and Nearby Search remain primary where they have a precise mapping.
- Stock Magic Earth search is the immediate failure/offline/unmapped-category fallback.
- Selected Place Details remain adaptive by place type instead of requesting every expensive field for every POI.
- Search Along Route uses the remaining Magic Lane route and traffic-aware detour ranking while navigating.
- Google navigation points / preferred entrances / moved-place chains / open-at-arrival remain enabled.

## Native routing authority

- Magic Earth / Magic Lane remains the sole route calculator used for displayed/navigated routes.
- Google Routes geometry is never displayed or started as navigation; it is advisory traffic evidence only.
- Normal passenger-car baseline: `Fastest`, `avoidTraffic=All`, `avoidUnpavedRoads=true`, accurate waypoint approach and a fresh moving departure heading when the target exposes those request fields.
- Magic Lane online traffic remains enabled.
- `allowOnlineCalculation=true` is requested **only for the initial route, only when the exact wrapper exposes that field, and only while Android reports network availability**. Active reroutes preserve the target request value rather than forcing network use, because the <1 s goal benefits from letting Magic Lane choose the quickest viable onboard/offboard path.
- Initial route can request terrain profile for strong `SingleTrack`/`Path` evidence. Active-navigation recalculations disable terrain-profile construction and request `alternatives=Never` where exposed.

## Google traffic — three levels

1. **Level 1 / NORMAL or minor** — keep the current Magic Lane route. No artificial roadblock.
2. **Level 2 / SLOW** — do not blindly avoid. Keep the route while Magic Lane's own online-traffic/better-route machinery evaluates alternatives. A useful alternative can remain a stock suggestion; CairoDrive auto-switches only when the time saving and route-quality context justify it.
3. **Level 3 / TRAFFIC_JAM** — only after geometry/heading/coverage validation, a contiguous strong jam and meaningful delay can create a temporary **Magic Lane** roadblock. Magic Lane then computes the replacement route.

Level classification is deliberately conservative: Google traffic on a nearby parallel road cannot trigger a block unless the route map-match gates pass.

## Narrow roads + alternatives

- `SingleTrack`/`Path` is treated as strong narrow/path-like evidence; normal residential road class is never treated as physical width evidence.
- Strong upcoming narrow evidence can create a temporary native Magic Lane roadblock using the corrected distance-ahead semantics.
- A proposed native better route is scanned for terrain metadata when available. CairoDrive will **not auto-switch** to a candidate with strong `SingleTrack`/`Path` evidence.
- If the current route is being escaped because of narrow-road evidence but the proposed candidate has no terrain metadata, CairoDrive leaves it as a stock/user suggestion instead of blind auto-switching.

## Better-route behavior

The original Magic Earth callback always executes first.

- quiet/normal route: suggestion threshold 2 min; CairoDrive auto-switch threshold 5 min saved.
- level-2 traffic: suggestion threshold 1 min; auto-switch threshold 3 min saved.
- narrow-road context: suggestion threshold 1 min; auto-switch threshold 2 min saved.
- level-2 traffic + narrow context: auto-switch threshold 90 s saved.
- level-3 traffic is primarily handled by the native roadblock/recompute path.
- invalidated better-route suggestions cancel pending switches; failed switches roll back.

## Fast reroute target

- Correct roadblock `startDistance` is distance ahead of current navigation position.
- Terrain profile disabled on active reroute.
- Alternative fan-out disabled on active reroute (`Never`) when the field is exposed.
- Stale Google traffic HTTP work is cancelled when native recompute starts.
- CairoDrive fallback switch delay is 40 ms after the stock callback.
- `WaitingRoute` / route-update state plus E2E trigger timing measures the real recompute path.
- `./watch_drive.sh recompute` reports p50, p90, worst and percent under 1,000 ms.

`<1 s` remains a measured target, not a promised SDK SLA.

## `ExternalCh` / the “HH/CH” idea

The target exposes `MagicEarth` and `ExternalCh` path algorithms. Production remains `MagicEarth`: public Magic Lane documentation exposes the alternative but does not guarantee that `ExternalCh` is faster or traffic/quality-equivalent on this exact binary. `experiments/EXTERNAL_CH.md` documents how to benchmark it before ever promoting it.

## GitHub CI

The private-repo workflow:

- installs Linux + Android SDK build dependencies;
- fetches a SHA-256-pinned private source APK input;
- downloads pinned Frida Gadget 17.17.0 and verifies GitHub's release digest when available;
- runs all static/self-tests;
- patches the exact target;
- rewrites final package identity to `com.cairodrive.app` while preserving original component class namespaces;
- signs the APK and AAB using GitHub Actions secrets;
- validates the AAB with bundletool and builds a universal APK smoke test;
- verifies package IDs/signatures/zip alignment and emits SHA-256 sums;
- uploads one Actions artifact containing the signed APK, signed AAB, universal APK, build report, verifier output and source-only patcher archive.

The original third-party APK is intentionally excluded from Git history. The helper can store a user-supplied copy as a private Release asset for CI input.

## Still deliberately excluded

- Google route takeover/rendering.
- A second local routing graph.
- Blind `ExternalCh` promotion without device evidence.
- Fake truck width as a normal-car narrow-road proxy.
- Global avoid-motorway/toll/ferry overrides.
- Google narrow-road signals without Egypt coverage.
- Persistent full Places cache/speculative query prefetch.
- Premium/license/entitlement bypass.


## Final v22.3 decision

The online/API sweep plus exact-binary reverse-engineering found no further target-compatible must-add feature for the defined Cairo passenger-car scope. ExternalCh remains an empirical native A/B decision, not an untested production assumption. Google traffic stays advisory; Magic Lane remains the sole navigation engine.
