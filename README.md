# CairoDrive v22.3.1 — drive-test-ready GitHub CI build

Target: exact Magic Earth / Magic Lane 7.1.26.26 generation. Final Android application ID: **`com.cairodrive.app`**.

CairoDrive keeps **Magic Earth / Magic Lane as the only route renderer and navigator**. Google Places improves destination discovery. Google Routes contributes traffic evidence only; it never becomes the navigation engine or supplies the displayed route.

## Your exact GitHub flow

Repository: `https://github.com/EsmailELBoBDev2/Magic_Earth`

You already cloned the empty repository. Unzip this bundle **into that clone**, then run:

```bash
cd /path/to/Magic_Earth
./PUSH_TO_GITHUB.sh
```

If `config/google_keys.env.example` still has placeholders, the script asks once for your Google Places key and optional separate Routes key. Because you explicitly requested baked keys, it writes them into the **private repository**, then `VERIFY_REPO.sh` runs, the source is committed, and `main` is pushed. No GitHub Actions secrets, private release, local APK build, local Android SDK, or local keystore setup is required.

The push automatically starts `.github/workflows/build.yml`.

## What Actions produces

Artifact name:

`CairoDrive-v22.3.1-DRIVE-TEST-com.cairodrive.app`

Contents:

- `CairoDrive-v22.3.1.apk` — signed installable APK
- `CairoDrive-v22.3.1.aab` — signed Android App Bundle
- `CairoDrive-v22.3.1-universal.apk` — universal APK rebuilt from the AAB and verified
- `CairoDrive-v22.3.1-patcher-source.zip`
- `BUILD_REPORT.txt`
- `VERIFY_OUTPUT.txt`
- `SHA256SUMS.txt`
- `INSTALL_DRIVE_TEST.sh`
- `provision_google_key.sh` — optional emergency key rotation override; not needed normally
- `watch_drive.sh`, `pull_logs.sh`
- automatic MagicEarth/ExternalCh simulation A/B tools
- `DEEP_REVERSE_ENGINEERING_AUDIT.md`

## Exact base APK

The exact analyzed APK is stored as seven Git-safe binary chunks in `base_apk_parts/`. Actions reconstructs it and refuses to continue unless the complete APK SHA-256 is:

`936cff2a8cffcfad96cc68d76a22c366d2c038e5484a2c974e0d88f36906d4de`

and arm64 `libapp.so` SHA-256 is:

`558e04e9a41aca50a3409ee7640785eedfefb23ff1fe787865b7595f029e19a4`

Every source chunk is below GitHub's 50 MiB warning threshold and has its own recorded hash.

## Signing

For this private **drive-test** repository, a repeatable test-only keystore is intentionally included:

- alias: `cairodrive`
- store/key password: `cairodrive-drive-test-2026`
- certificate SHA-1: `DB:1B:91:7C:E5:AB:49:B4:B5:C1:DF:5D:B7:50:13:98:1F:E1:66:8B`
- certificate SHA-256: `1C:83:ED:7B:D4:99:87:52:8C:A8:36:4D:FE:68:90:74:9F:58:07:3A:72:97:CA:B6:F6:9F:FD:57:2A:72:A7:AA`

This is **not a Play/production signing key**. Anyone who can read the private repo can sign the same test identity.

## Google keys — intentionally embedded

You explicitly chose baked keys for this personal private build. `config/google_keys.env.example` is therefore intentionally tracked and `payload/build_patch.sh` injects those values into the temporary Frida agent before compilation.

The built APK/AAB consequently contains recoverable API credentials. **Private GitHub does not protect a key after someone obtains the APK.** Protect the key in Google Cloud with API restrictions, quotas, and the Android application restriction:

- package: `com.cairodrive.app`
- SHA-1: `DB:1B:91:7C:E5:AB:49:B4:B5:C1:DF:5D:B7:50:13:98:1F:E1:66:8B`

`provision_google_key.sh` remains only as a runtime override/rotation path.

## Routing/traffic policy

Magic Lane remains authoritative:

- Car + Fastest.
- native Magic Lane traffic avoidance / better-route detection retained.
- `avoidUnpavedRoads=true`.
- accurate waypoint approach and fresh departure heading when supported.
- initial online calculation may be enabled when exposed and usable.
- traffic-only active reroutes avoid alternative fan-out and terrain-profile construction for latency.
- narrow-road escape reroutes keep enough terrain data to avoid another known `SingleTrack`/`Path` trap.

Google traffic is map-matched back to the active Magic Lane route:

1. **NORMAL / level 1** → keep current route.
2. **SLOW / level 2** → no blind hard block; let Magic Lane's native better-route logic decide.
3. **TRAFFIC_JAM / level 3** → only strong contiguous, confidently matched and meaningfully delayed traffic can create a temporary **Magic Lane** roadblock. Magic Lane then recomputes and navigates the replacement.

Google route geometry is never rendered or used as the active navigation route.

## Narrow-road policy

Ordinary residential/service road class is not treated as physical-width evidence. Strong exact-target-native `SingleTrack`/`Path` evidence can authorize a bounded roadblock. CairoDrive will not auto-switch to a native better-route candidate already known to contain strong narrow evidence.

## Recompute target

The code path is optimized and instrumented for a **sub-1-second driver-visible reroute target**, but `<1000 ms` remains runtime-unproven until the phone produces p50/p90 samples.

Safe optimizations include:

- corrected roadblock distance-ahead semantics;
- alternatives `Never` on active intercepted reroutes;
- terrain profile omitted on traffic-only reroutes;
- stale Google traffic request cancelled when native recompute begins;
- ~40 ms CairoDrive better-route fallback delay;
- no repeated writes of stock/default route preferences;
- invalid better-route candidates cancel pending switches;
- `WaitingRoute` → route-updated/running + trigger→new-route E2E timing.

## MagicEarth vs ExternalCh

The exact APK exposes **only** `MagicEarth` and `ExternalCh` among the safe target route algorithms. Newer `simplifiedMl`/`mlch` names are not present and are not injected.

After installing the Action artifact, optionally run:

```bash
./run_route_algo_ab_simulation.sh
```

The phone uses Magic Lane's native simulator to compare stock, ExternalCh reroute-only, and ExternalCh-all across short/mid/long Cairo scenarios. It compares p50/p90/%<1s plus route distance/ETA/crash/narrow-road evidence and only promotes CH if it materially wins without quality regressions. Simulation is disabled again afterwards.

## Auditing and safety boundary

See `DEEP_REVERSE_ENGINEERING_AUDIT.md`. The audit covers manifest/components, DEX/package identity, Flutter/Dart target guards, native Magic Lane surface, search/API economy, Google traffic matching, narrow-road logic, recompute latency, HTTP helper containment, signing/CI, and intentionally excluded risky/duplicative behavior.

Not included: premium/license bypass, Google navigation takeover, second routing graph, fake vehicle width, forced U-turn suppression, global avoid-toll/motorway/ferry preferences, or newer incompatible Magic Lane APIs.
