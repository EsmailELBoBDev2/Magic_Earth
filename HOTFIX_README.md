# CairoDrive v22.3.2 verifier + future-APK hotfix

Apply on top of commit `4e09e56` / the v22.3.1 future-target hotfix.

## Fixes

- Accepts both bare SHA-256 and standard `sha256sum` `HASH  filename` metadata.
- Local `verify_patcher.sh` no longer crashes when `javac` is absent; only the helper Java compile check is skipped locally. GitHub Actions Java 17 still executes it.
- Future APKs must retain the full search/routing/navigation/simulation surface before patching.
- Direct `payload/build_patch.sh` now runs the future compatibility preflight too.
- `ci/update-base-apk.sh` validates a new APK before deleting the current known-good base parts.
- Exact search debounce stays exact-fingerprint-only.
- Historical hard-coded libGEM globals are now gated by the full exact module/export layout (size + set_dart_port + native_call + native_call_createObject), not one offset alone.
- Next free `classesN.dex` remains selected dynamically.
- Generic private ContentProvider remains the Frida Gadget bootstrap.
- Obsolete exact-target `patch_libflutter.py` and `patch_manifest_extract.py` are removed.

## Apply

```bash
cd /path/to/Magic_Earth
unzip -o ~/Downloads/CairoDrive-v22.3.2-FUTURE-COMPAT-HOTFIX.zip -d .
./APPLY_V22.3.2_HOTFIX.sh

git diff --check
git status --short

git add -- \
  ci/reassemble-base-apk.sh \
  ci/update-base-apk.sh \
  tools/preflight.py \
  payload/build_patch.sh \
  payload/cairodrive-google-search-only.js \
  verify_patcher.sh \
  VERIFY_REPO.sh \
  FUTURE_APK_COMPATIBILITY.md \
  HOTFIX_README.md \
  APPLY_V22.3.2_HOTFIX.sh

git add -u -- tools/patch_libflutter.py payload/patch_manifest_extract.py

git commit -m "Fix verifier and harden future APK compatibility"
git push origin main
```

For a future Magic Earth APK:

```bash
./ci/update-base-apk.sh /path/to/new-magic-earth.apk
```

If it passes compatibility checks, the base chunks are updated. If it fails, the currently working chunks remain untouched.
