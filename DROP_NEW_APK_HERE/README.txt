DROP ONE NEW MAGIC EARTH .apk HERE.

Then from the repository root run:
    ./SMART_UPDATE.sh

Do NOT git-add the APK. *.apk is intentionally ignored because GitHub regular Git rejects files >=100 MiB.
SMART_UPDATE uploads the whole APK as a private GitHub Release asset, commits only its SHA-pinned selector, pushes main, watches CI, and downloads resulting artifacts.
