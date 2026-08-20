# Future APK smart-update automation

## The only normal update flow

1. Put **one whole Magic Earth `.apk`** in `DROP_NEW_APK_HERE/`.
2. From the repo root run:

```bash
./SMART_UPDATE.sh
```

That is the recommended path. Do not zip it, do not split it, and do not `git add` the APK itself.

Why: GitHub regular Git hard-blocks individual files at 100 MiB. `SMART_UPDATE.sh` keeps the large APK out of Git, uploads it as a private GitHub Release asset, commits only a tiny SHA-256-pinned selector, pushes `main`, watches CI, and downloads available artifacts.

You may also pass a file directly:

```bash
./SMART_UPDATE.sh ~/Downloads/new-magic-earth.apk
```

The lower-level equivalent is:

```bash
./UPDATE_APK.sh --watch ~/Downloads/new-magic-earth.apk
```

The original 24 MiB Git chunk input remains supported as a legacy/offline fallback with `UPDATE_APK.sh --legacy-chunks`.

## Smart CI state machine

```text
selected upstream APK
        |
        v
SHA/provenance verification
        |
        v
fast compatibility fingerprint
        |
        +---- required anchor moved/missing ----> FAIL CLOSED
        |                                           |
        |                                           v
        |                                  automatic deep forensics
        |
        +---- compatible ----> patch/build/sign/package
                                  |
                                  +---- success ---> drive-test artifacts
                                  |
                                  +---- any failure -> automatic deep forensics
```

The pipeline never invents binary offsets after an upstream change. It discovers safe `libGEM` globals from code shape, uses structural/semantic anchors, and treats optional search debounce patching as optional. Required search/navigation/native surfaces are fail-closed.

## What is checked before patching

- exact input SHA-256 and provenance;
- package/version when Android build tools are available;
- APK/native/Dex inventory;
- `libapp.so` / `libGEM.so` hashes;
- required Flutter search/navigation semantic markers;
- required `libGEM` exports and successful machine-code-shape discovery of its Dart/PostCObject globals;
- native navigation/simulation routing markers;
- delta against `baseline/known-good.json`.

The known-good delta distinguishes a harmless binary/version change from a missing required anchor. A new version with different hashes but intact required surfaces may be attempted. Missing required surfaces are refused.

## Automatic failure handoff

Any compatibility refusal or later build failure starts the forensics job. It performs full Apktool/JADX passes, focused native ELF analysis, Blutter AOT analysis when supported, and saves the failed build-stage evidence in the same final handoff.

The final artifact is named roughly:

```text
CairoDrive-FUTURE-APK-HANDOFF-<commit>
```

Send `FUTURE_APK_REPORT.txt` first. It includes the prior build-log tail and an automatic failure-subsystem classification. It is accompanied by machine-readable `BUILD_FAILURE_CLASSIFICATION.json`, `preflight.json`, `compatibility-delta.json`, `FORENSICS_STATUS.json`, prior build logs, toolchain provenance, semantic JADX/Blutter matches, decoded manifest, and focused native reports.

Full native string/symbol reports are generated for `libapp.so`, `libGEM.so`, and `libflutter.so` by default. A manual workflow dispatch can enable `full_native_forensics` for every arm64 `.so`; this is intentionally optional because the artifact can become very large.

## Runtime limitation

GitHub static CI can decompile, inspect, build Frida Gadget payloads, analyze Flutter AOT with Blutter, and generate Frida material. A true runtime Frida trace still requires Android where the app actually launches. CI does not pretend a static Ubuntu runner proves on-device navigation behavior.

## Baseline policy

`baseline/known-good.json` is deliberately not auto-promoted merely because an APK compiled. A build can be structurally valid yet still behave incorrectly on a real phone. Promote/update the known-good baseline only after a real device smoke/drive test confirms the new upstream version.
