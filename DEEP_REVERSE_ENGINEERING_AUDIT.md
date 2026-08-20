# CairoDrive v22.3 — exact APK deep reverse-engineering + drive-test audit

Date: 2026-08-20
Target: Magic Earth 7.1.26.26.21DB1F1B.3C81F7001 / Magic Lane Android 1.9.0 generation
Source APK SHA-256: `936cff2a8cffcfad96cc68d76a22c366d2c038e5484a2c974e0d88f36906d4de`
Exact arm64 `libapp.so` SHA-256: `558e04e9a41aca50a3409ee7640785eedfefb23ff1fe787865b7595f029e19a4`

This audit is intentionally conservative. A string or imported native function is not treated as a vulnerability by itself. Changes are shipped only when the exact target plus CairoDrive architecture gives a concrete correctness, security, performance, or API-economy reason and the fix can fail open to stock Magic Earth/Magic Lane.

## 1. APK / Android platform surface

- ZIP integrity: PASS.
- 6 DEX files, Flutter/Dart AOT, arm64 Magic Lane native engine.
- `minSdkVersion=28`, `targetSdkVersion=36`, `compileSdkVersion=36`.
- Main activity is exported because the navigation app intentionally accepts `geo:`, `google.navigation:`, KML/KMZ/ZIP/file/content and Magic Earth deep links.
- Android Auto navigation service is exported behind the Android Car App surface permission, as expected for a navigation app.
- File/image/share providers are non-exported and use URI grants.
- Profile installer receiver is exported but protected by `android.permission.DUMP`.
- Exact target declares `POST_NOTIFICATIONS` twice. CairoDrive removes only the duplicate.
- Exact target contains literal `Manifest.permission.CAPTURE_AUDIO_OUTPUT`, not `android.permission.CAPTURE_AUDIO_OUTPUT`; it is a malformed/no-op permission name. CairoDrive removes this dead declaration rather than pretending it grants privileged audio capture.
- CairoDrive final package sets `android:allowBackup=false` to reduce backup exposure of CairoDrive runtime state. The user's drive-test Google keys are intentionally baked into the APK and are therefore extractable from the APK regardless of backup settings.
- Broad stock permissions (location/background location, camera, microphone, contacts, Bluetooth, etc.) are not blindly stripped because stock navigation/voice/QR/contact/Android Auto functionality can depend on them.

## 2. Package rename / side-by-side correctness

Final manifest package is `com.cairodrive.app`, but compiled Java/Kotlin classes remain under `com.generalmagic.magicearth.*`. That is correct: class namespaces are code identities, not the Android application ID. The rewrite:

- fully qualifies relative component class names against the original package before changing the manifest package;
- rewrites manifest authorities and app-defined permission names to `com.cairodrive.app...` to avoid provider/permission collisions with stock Magic Earth;
- keeps original component implementation class names intact;
- changes the visible app label to CairoDrive.

A blind global replacement of every `com.generalmagic.magicearth` DEX string was explicitly rejected because it would break compiled Android Auto/plugin classes and internal actions. Hardcoded Play-subscription URLs remain stock and are outside the search/navigation patch scope.

## 3. Native / Flutter surface

Exact target contains the native navigation/simulation APIs required by CairoDrive, including evidence for:

- navigation start / start-with-route;
- native simulation / simulation-with-route;
- temporary navigation roadblocks;
- better-route time/distance-to-fork support;
- traffic and alarm services;
- route terrain / road-type support, including `SingleTrack` / `Path` evidence in the target generation;
- route path algorithms `MagicEarth` and `ExternalCh` in the exact DEX/native surface.

Newer `simplifiedMl` / `mlch` enum names are not present in this exact target and are not injected.

Native ELF hardening check:

- `libGEM.so`, `libflutter.so`, `libdartjni.so`, `libdatastore_shared_counter.so`: RELRO + non-executable stack + NOW binding observed.
- Dart AOT `libapp.so`: non-executable stack observed; standard RELRO/NOW layout is not visible. CairoDrive does not relink or rewrite its ELF hardening because doing so would be a high-risk binary transformation of the Dart AOT image.
- Some third-party native libraries import legacy libc string routines. This is recorded as audit evidence, not claimed as an exploitable vulnerability.

## 4. Search correctness + API economy

Kept:

- Google Places (New) Text Search primary, stock Magic Earth search fallback.
- Autocomplete with session token, stale cancellation, Egypt scope, >=3 Unicode codepoints.
- Nearby category search only for conservative Google type mappings; ambiguous native categories fall back to stock/text behavior instead of inventing a wrong type.
- Search Along Route and route-aware POI ranking only while navigating.
- one selected-place Details request rather than Details fan-out across result lists.
- navigation points / entrances / moved-place handling.

Economy controls:

- lean search field masks;
- richer lifestyle fields only for relevant selected-place types;
- routing summaries are not requested for casual Nearby browsing, only while navigating;
- no automatic result pagination, speculative prefetch, full Places response persistence, photos/review fan-out, or hidden interactive retries;
- stale requests are hard-cancelled;
- serialized Places worker prevents request storms.

Google's field-mask design means selecting unnecessary higher-tier fields raises both payload and billing tier, so v22.3 keeps field selection intentional.

## 5. Google traffic -> Magic Lane awareness

Google is **not** a navigation engine here. Google Routes supplies traffic evidence; the active route is always a Magic Lane route.

Pipeline:

1. Sample remaining Magic Lane geometry.
2. Ask Google Routes for a driving traffic-aware route constrained with up to 8 via points sampled from the Magic Lane route.
3. Request traffic speed-reading intervals on the Google polyline.
4. Spatially match those intervals back to the Magic Lane route using distance/heading/coverage gates.
5. Classify traffic:
   - Level 1: keep current route.
   - Level 2: let native Magic Lane better-route detection decide; no hard block.
   - Level 3: only strong, contiguous, confidently matched jam evidence can create a temporary native Magic Lane roadblock.
6. Magic Lane itself recalculates, renders, and navigates the replacement.

v22.3 hardens Level 3 logic: if Google unexpectedly omits usable `staticDuration`/delay evidence, a short jam can no longer fail-open into a hard reroute. Without duration evidence, at least ~300 m of contiguous strong jam evidence is required before Level 3 can authorize the native roadblock. This reduces false-positive hard reroutes while preserving the user's requirement to avoid genuine Level-3 jams.

Traffic refresh remains adaptive (~2 min heavy / ~3 min moderate / ~5 min clear) and stops near destination (<~800 m), reducing Routes API use.

## 6. Narrow-road logic

- Ordinary residential/service-road class is never treated as proof of physical narrowness.
- Only strong target-native terrain/road-type evidence such as `SingleTrack` / `Path` can authorize a bounded temporary roadblock.
- Traffic-only reroutes disable terrain-profile construction for latency.
- A reroute specifically escaping a known narrow/path segment keeps terrain metadata so the candidate replacement can be checked for another narrow/path trap.
- A better-route candidate with known strong narrow evidence is not auto-switched.
- During a narrow-road escape, a candidate whose narrow-road quality is unknown remains a stock suggestion rather than a blind auto-switch.

## 7. Recompute / latency audit

The driver-visible target is `<1000 ms` when the device/route permits it; this is instrumented, not claimed without phone data.

Safe latency reductions kept:

- roadblock start distance is relative to current navigation position, not route origin;
- active reroute requests `alternativesSchema=Never` when exposed;
- terrain profile is omitted on traffic-only reroutes;
- stale Google traffic HTTP is cancelled as soon as native recompute starts;
- better-route fallback delay is ~40 ms rather than hundreds of ms;
- default route preference fields are not repeatedly overwritten;
- invalidated better-route recommendations cancel pending switches;
- timing covers `WaitingRoute` -> updated/running route and trigger -> usable route E2E.

No fake benchmark shortcuts:

- native traffic avoidance is not disabled;
- result detail quality is not globally downgraded;
- online/local behavior is not forced on active reroutes merely to win a timing number;
- initial Magic Lane online calculation can be enabled when the exact wrapper exposes it and the network is available.

## 8. MagicEarth vs ExternalCh

Both exact-target-safe algorithms are included behind a test-only selector:

- `stock` = MagicEarth;
- `externalch-reroute` = MagicEarth initial + ExternalCh on intercepted active recalcs;
- `externalch-all` = ExternalCh for intercepted initial + active route calculations.

Native simulation is test-only. A one-command phone harness runs short/mid/long Cairo scenarios, measures p50/p90/mean/worst/%<1 s, checks route distance/ETA/narrow evidence and only promotes ExternalCh if it materially wins without quality/safety regressions. Simulation is disabled again afterward. A desktop Python imitation is deliberately not used to fabricate a winner.

## 9. CairoDrive HTTP helper hardening added in v22.3

The helper previously accepted any HTTPS URL supplied by the JS layer and read an unlimited response. v22.3 now:

- allowlists only `places.googleapis.com/v1/places...` and `routes.googleapis.com/directions/v2...`;
- rejects non-HTTPS and non-default HTTPS ports;
- caps request body to 512 KiB;
- caps response to 4 MiB;
- caps request timeouts to defensive maxima;
- prevents caller overrides of Host/Content-Length/Connection;
- bounds/reaps abandoned HTTP states;
- disconnects sockets on completion/cancellation.

This reduces SSRF-like accidental endpoint expansion, unbounded-memory failure modes, and state leaks without changing normal Google requests.

## 10. API-key policy in the final private drive-test build

At the user's explicit request, v22.3 uses **build-time embedded Google keys** from the tracked private-repository file `config/google_keys.env`. `payload/build_patch.sh` replaces fixed source markers only in a temporary agent source immediately before `frida-compile`. Runtime staging remains available solely as a key-rotation override.

This is convenient and makes GitHub Actions zero-secret/zero-setup, but it is **not credential secrecy**: anyone who obtains the APK can reverse engineer and recover an embedded API key. The meaningful controls are Google Cloud API restrictions, quotas, and the Android application restriction for `com.cairodrive.app` plus the committed drive-test certificate SHA-1.

The committed signing key is intentionally **DRIVE-TEST ONLY**. It exists so the private empty repo can build repeatable update-compatible test APK/AAB artifacts without GitHub Secrets. It is not a production/Play signing key.

## 11. Frida/injection security boundary

- Gadget is configured in script mode, not as a listening network server.
- Exact `libapp.so` SHA and target hook byte guards fail closed before binary mutation.
- native request filtering is scoped to search plus route-preference calculateRoute calls; everything else goes to stock libGEM.
- Google route geometry is never rendered or passed to navigation as the active route.

## 12. Items deliberately not changed

- No premium/license/entitlement bypass.
- No Google navigation takeover.
- No second local routing graph.
- No broad permission stripping that could silently break stock capabilities.
- No global avoid-toll/motorway/ferry policy (user preference, not objective quality).
- No fake 2.0 m truck width for a normal passenger car.
- No forced U-turn suppression.
- No stronger route snap that could mis-snap Cairo frontage/parallel roads.
- No newer Magic Lane 1.9.1+ API calls on this 1.9.0 exact target.

## 13. Runtime-unverified boundary

Static/reverse-engineering evidence can prove target identity, code paths, guards and API availability, but not device timing/ABI behavior. The first phone run must still prove:

- injected agent startup stability;
- Google Android-restricted key acceptance for `com.cairodrive.app` + drive-test cert;
- native roadblock overload behavior;
- better-route switch/rollback;
- traffic matching on real Cairo roads;
- narrow-road terrain shapes;
- Android Auto layout/voice behavior;
- p50/p90 recompute latency and ExternalCh applicability.

That is why v22.3 keeps first-test diagnostics and the native simulation harness instead of claiming runtime verification from desktop analysis.
