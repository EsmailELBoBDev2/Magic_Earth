DROP EXACTLY ONE NEW MAGIC EARTH .apk HERE.

Then from the repository root run:
    ./SMART_UPDATE.sh

Do NOT `git add` the APK and do NOT manually split it.
`*.apk` is intentionally ignored because GitHub regular Git hard-blocks objects >=100 MiB.

SMART_UPDATE itself does only lightweight local intake:
  1. validates APK/AndroidManifest.xml,
  2. SHA-256 hashes it,
  3. verifies the GitHub repo is PRIVATE,
  4. uploads the WHOLE APK to the private `upstream-apks` Release,
  5. commits/pushes a tiny SHA-pinned selector,
  6. watches GitHub Actions and downloads results.

GitHub Actions does the heavy work:
  compatibility -> baseline delta -> libGEM discovery -> patch/build/sign
  -> if incompatible OR build fails -> Apktool/JADX/Blutter/native forensics
  -> `CairoDrive-FUTURE-APK-HANDOFF-*` artifact.
