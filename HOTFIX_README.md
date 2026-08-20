# CairoDrive v22.3.1 CI + future-target hotfix

This overlay fixes the GitHub Actions failure:

`Entrypoint must be inside the project root`

It also makes future Magic Earth APK updates safer to attempt:

- Frida temporary entrypoint is created under `payload/`, the compiler project root.
- Gadget bootstrap uses a private Android ContentProvider instead of fixed `libflutter.so` byte patches.
- Helper DEX chooses the next free `classesN.dex` slot automatically.
- `extractNativeLibs=true` is applied during decoded manifest rewrite, not a binary-manifest byte edit.
- Exact target keeps the known 400 ms libapp debounce tweak.
- Future compatible targets skip exact-offset debounce changes.
- Required `libGEM.so` exports and navigation/search API markers are preflight-checked.
- Dart PostCObject is discovered from exported `set_dart_port`; exact offsets are fallback only for the analyzed target.
- Base APK chunk hash is data-driven; `ci/update-base-apk.sh` prepares a future APK for CI in one command.

## Apply

From the root of your cloned `Magic_Earth` repo:

```bash
unzip -o ~/Downloads/CairoDrive-v22.3.1-HOTFIX-overlay.zip -d .
./verify_patcher.sh
./VERIFY_REPO.sh
git status --short
git add -- .gitignore payload/build_patch.sh payload/cairodrive-google-search-only.js \
  payload/helper/com/cairodrive/bootstrap/GadgetBootstrapProvider.java \
  tools/rewrite_manifest.py tools/preflight.py ci/verify-target-routing-surface.py \
  ci/reassemble-base-apk.sh ci/update-base-apk.sh VERIFY_REPO.sh verify_patcher.sh HOTFIX_README.md
git commit -m 'Fix Frida CI build and add future-target compatibility mode'
git push origin main
```

## Future Magic Earth APK

Put the new APK anywhere locally, then from this repo:

```bash
./ci/update-base-apk.sh /path/to/new-magic-earth.apk
./VERIFY_REPO.sh
git add -- base_apk_parts ci/reassemble-base-apk.sh ci/update-base-apk.sh
git commit -m 'Update Magic Earth base APK'
git push origin main
```

The patcher will use full exact-target optimizations when the analyzed fingerprint matches. For a future fingerprint it only proceeds when the required Magic Lane exported/API surface is still present. Exact binary-offset tweaks are skipped. If the required surface changed, it refuses and emits a preflight report instead of blindly corrupting the APK.
