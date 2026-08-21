# CairoDrive v22.3 — drive-test CI

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

## Repository visibility

CI supports either public or private repositories. GitHub Actions artifacts upload in both modes.
If this repository is public, the committed base-APK chunks, workflow files, and bundled drive-test signing material are also public; future APKs uploaded to the `upstream-apks` Release are public release assets too.

## CI output

GitHub Actions uploads a versioned `CairoDrive-v22.3-<upstream>-DRIVE-TEST-<commit>` artifact containing:

- `CairoDrive-v22.3.apk`
- `CairoDrive-v22.3.aab`
- `CairoDrive-v22.3-universal.apk`
- build/verification/checksum reports
- install + Google key provisioning scripts
- native MagicEarth/ExternalCh simulation A/B benchmark
- deep reverse-engineering audit

Google API credentials are **not embedded** in Git or build artifacts. They are provisioned after installation into app-private storage.

## Updating to a future Magic Earth APK

Drop one whole new APK into `DROP_NEW_APK_HERE/` and run `./SMART_UPDATE.sh`. The helper uploads the large APK as a SHA-pinned GitHub Release asset, commits only its tiny selector, pushes `main`, watches CI, and downloads results. CI compares the new version against `baseline/known-good.json`, attempts the portable patch only when required anchors remain valid, and automatically creates a deep reverse-engineering handoff artifact after any compatibility or build failure. See `FUTURE_APK_AUTOMATION.md`.


## CI hardening added after run #10

- Frida 19.x entrypoint is generated inside the `payload/` project root (fixes `Entrypoint must be inside the project root`).
- compatibility/build setup is one job instead of duplicating the entire toolchain twice;
- build-stage logs are automatically carried into the forensic handoff;
- forensic dependency installation is best-effort, so one upstream tool outage does not suppress the basic diagnostic artifact;
- APK hashing is streaming and DEX marker scanning is per-file to reduce RAM;
- a known-good compatibility delta separates expected version drift from required-anchor loss;
- CI no longer enforces repository visibility; public and private repositories are both supported;
- npm explicitly records the reviewed Frida install script version, caches only the npm download store, and automatically switches to `npm ci` if a lockfile is later committed;
- the local log mirror uses a bounded queue so a log storm cannot grow an unbounded in-memory backlog.

## v22.3 smart-update clarification (2026-08-21)

For future upstream APKs, do **not** commit the APK to Git. Put one whole `.apk` in
`DROP_NEW_APK_HERE/` and run `./SMART_UPDATE.sh`, or pass its path directly.
The script only performs lightweight local intake/upload/orchestration; all heavy compatibility,
patching, signing, and automatic Apktool/JADX/Blutter/native forensics run in GitHub Actions.

Repository visibility is not a build gate. `SMART_UPDATE.sh` and CI work in public or private repositories.
When public, remember that Release APK inputs and bundled drive-test signing material are publicly readable.
