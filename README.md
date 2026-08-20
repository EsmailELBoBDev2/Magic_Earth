# CairoDrive v22.3 — private drive-test CI

Target application ID: `com.cairodrive.app`.

Magic Earth / Magic Lane remains the sole route renderer and navigator. Google Places improves destination search; Google Routes supplies traffic evidence only. Level 1 traffic keeps the route, Level 2 lets native Magic Lane better-route logic decide, and strong Level 3 congestion can create a temporary native Magic Lane roadblock so Magic Lane recomputes its own route. Strong native `SingleTrack`/`Path` evidence is also handled conservatively.

## Future-version behavior

v22.3 is future-ready rather than tied to one SHA:

- no `libflutter.so` binary patch;
- Frida Gadget loads through a non-exported bootstrap provider;
- `libGEM` Dart/PostCObject globals are discovered from `set_dart_port` every build;
- next free `classesN.dex` is chosen automatically;
- search debounce optimization is signature-scanned and optional;
- structural preflight accepts compatible future APKs and refuses unsafe ones.

See `FUTURE_COMPATIBILITY.md`.

## One-time private repo requirement

This bundle contains the user-supplied base APK as 24 MiB chunks and a reproducible **drive-test-only** signing key. The GitHub repo must be private before pushing.

## CI output

GitHub Actions uploads `CairoDrive-v22.3-DRIVE-TEST-com.cairodrive.app` containing:

- `CairoDrive-v22.3.apk`
- `CairoDrive-v22.3.aab`
- `CairoDrive-v22.3-universal.apk`
- build/verification/checksum reports
- install + Google key provisioning scripts
- native MagicEarth/ExternalCh simulation A/B benchmark
- deep reverse-engineering audit

Google API credentials are **not embedded** in Git or build artifacts. They are provisioned after installation into app-private storage.

## Updating to a future Magic Earth APK

Keep the new APK whole outside Git and run `./UPDATE_APK.sh /path/to/new.apk`. Future APKs are SHA-pinned as private GitHub Release assets, avoiding Git's 100 MiB object limit and binary-history growth. CI tries the portable fail-closed patch automatically; incompatibility or build failure triggers a deep diagnostic artifact. See `FUTURE_APK_AUTOMATION.md`.
