# CairoDrive v22.3.3 CI hotfix

Fixes the GitHub Actions failure:

`frida-compile ... Could not resolve ./search-core.mjs / ./nav-core.mjs / ./traffic-core.mjs`

It also stops embedding Google API keys in APK/AAB. Runtime provisioning remains via `provision_google_key.sh` after install.

## Apply to the already-cloned repo

```bash
cd /path/to/Magic_Earth
unzip -o ~/Downloads/CairoDrive-v22.3.3-CI-FIX-overlay.zip -d .
./PUSH_TO_GITHUB.sh
```

`PUSH_TO_GITHUB.sh` automatically untracks an older `config/google_keys.env` and removes the obsolete `tools/embed_google_keys.py` before verifying/committing/pushing.

If a real Google key was already pushed in an earlier commit, rotate that key after this hotfix. The repository being private reduces exposure but does not make a committed credential a good long-term secret.
