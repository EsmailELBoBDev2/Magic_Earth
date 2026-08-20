# Future APK update automation

## Normal workflow (recommended)

Do **not** copy the new APK into the Git repository and do not split it manually.
Keep the whole `.apk` anywhere on your machine (for example `~/Downloads`) and run:

```bash
./UPDATE_APK.sh ~/Downloads/new-magic-earth.apk
```

The helper:

1. validates that the file is an APK/ZIP with `AndroidManifest.xml`;
2. hashes it with SHA-256;
3. requires `EsmailELBoBDev2/Magic_Earth` to remain private;
4. uploads the whole APK to the private `upstream-apks` GitHub Release under a SHA-derived immutable asset name;
5. writes/commits `base_apk_release.json` containing the exact asset + SHA-256;
6. pushes `main`, which starts GitHub Actions.

Use `--watch` if you want the local command to follow the Actions run to completion:

```bash
./UPDATE_APK.sh --watch ~/Downloads/new-magic-earth.apk
```

The old 24 MiB chunk input remains supported with `--legacy-chunks`.

## What CI does

1. Materializes the exact APK selected by `base_apk_release.json` (or legacy chunks) and verifies SHA-256.
2. Runs fail-closed structural compatibility checks.
3. If compatible, runs the normal patch/build/sign/package pipeline.
4. If compatibility fails **or** the build fails, starts the `Automatic future-APK forensics` job.
5. Forensics runs Apktool, JADX, ELF/binutils analysis, existing CairoDrive preflight/routing checks, and best-effort Blutter AOT analysis.
6. It uploads `CairoDrive-FUTURE-APK-FORENSICS-<commit>`.

The diagnostic job intentionally does **not** silently invent new binary offsets/patches. If required surfaces changed, it refuses the unsafe patch and produces evidence for review. This prevents a future Magic Earth update from generating an APK that builds but has subtly broken navigation/search behavior.

## What to send back when a future version fails

Download the latest run artifacts:

```bash
./GET_LATEST_RESULT.sh
```

Send `FUTURE_APK_REPORT.txt` first. If more evidence is needed, the artifact also contains:

- `preflight.json`
- `logs/preflight.log`
- `logs/routing-surface.log`
- `JADX_SEMANTIC_MATCHES.txt`
- `JADX_URLS.txt`
- `BLUTTER_SEMANTIC_MATCHES.txt` when Blutter succeeds
- decoded manifest
- per-library ELF headers, symbols, dynamic sections and strings
- tool logs and exit-status JSON

Full Apktool/JADX decompile trees are intentionally transient and are summarized rather than uploaded: full trees can be enormous and are much less useful than focused reports.

## Frida limitation

CI can fetch/use Frida Gadget for the build and Blutter can generate a Frida script template. A real runtime Frida trace still requires a booted Android target on which the application actually launches. Static CI forensics must not be presented as a substitute for the later physical-device drive test.
