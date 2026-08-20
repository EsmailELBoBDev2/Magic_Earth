# PRIVATE REPOSITORY REQUIRED

This repository bundle contains:
- chunks of the user-supplied Magic Earth APK for reproducible private CI builds;
- a drive-test signing key whose password is intentionally included for reproducibility.

Do **not** publish this repository. Before pushing, make `EsmailELBoBDev2/Magic_Earth` private.

```bash
gh repo edit EsmailELBoBDev2/Magic_Earth --visibility private --accept-visibility-change-consequences
```

The included signing key is for private drive testing only, not Google Play/production distribution.
