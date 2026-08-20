# CairoDrive v22.3 — security, API economy and performance

## Places economy

- Google starts at 3 Unicode codepoints; stock search debounce is 400 ms.
- One Autocomplete session token; max five predictions; stale work is cancelled/discarded.
- Search rows use lean field masks. Rich selected Details are adaptive by place type.
- No result-wide Details fan-out, photos/review-body prefetch, speculative query prefetch, automatic pagination or persistent Places response database.
- Casual Nearby stays distance-ranked. Traffic-aware `routingSummaries` are requested only during active navigation, where ETA/detour ordering materially helps.
- Definite offline state hands control directly to onboard Magic Earth.

## Routes traffic economy

- Traffic advisory runs only during active navigation with meaningful route remaining.
- New destination: `TRAFFIC_AWARE_OPTIMAL`; refresh: `TRAFFIC_AWARE`.
- Adaptive refresh is roughly 2/3/5 minutes depending on congestion confidence.
- One request for the route corridor, <=8 via points, minimal route traffic field mask.
- Separate serialized Places and traffic workers; keep-alive + gzip + URLConnection cache disabled.
- **If Magic Lane begins route recomputation, any in-flight Google traffic request is cancelled.** The response would describe the stale route and should not compete with rerouting.

## Recompute performance target

Target: **<1000 ms driver-visible recompute**, measured rather than assumed.

Latency-safe changes:

- active reroute: terrain profile off;
- active reroute: alternatives `Never` if exposed;
- initial route: stock alternative schema retained;
- redundant route-preference writes removed;
- fake 200 cm truck width and forced U-turn avoidance removed;
- CairoDrive better-route fallback delay reduced to 40 ms;
- traffic worker cancelled during native reroute;
- route timing captured from exact-target `WaitingRoute` status and route update/running, plus optional callbacks when present;
- CairoDrive-triggered roadblocks get a separate trigger-to-updated `ROUTE_RECOMPUTE_E2E` measurement.

A sub-second guarantee is intentionally **not** claimed. Do not lower route result details, disable traffic quality, or force local-only routing without runtime evidence.

## Correctness

- Roadblock `startDistance` is distance **ahead of the current navigation position**, not distance from route origin.
- Better-route invalidation cancels a pending fallback switch.
- Google geometry is advisory only and never rendered/navigated.
- Traffic match remains <=35 m, <=40° heading difference, >=65% coverage with exact geometry checks after spatial-grid pruning.
- Narrow-road actions require strong native `SingleTrack`/`Path` evidence.

## Android/runtime security

- No API keys, keystore passwords or signing passwords are shipped in source/logs.
- Exact target is gated by `libapp.so` SHA-256 and exact debounce instruction bytes.
- No entitlement/premium bypass, broad exception interception, telemetry upload, GL/thread-priority hacks or unrelated Android-Auto interception.
- Client-side API keys remain extractable on a sufficiently privileged device; use API/application restrictions, quotas and billing alerts.

## Diagnostics

Persistent logs remain local, rotated/bounded and asynchronously written. First-test verbosity is deliberate; after runtime proof, reduce diagnostic volume rather than adding more instrumentation.
