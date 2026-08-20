# CairoDrive v22.3 GitHub CI status

Repository target: `EsmailELBoBDev2/Magic_Earth` (private).

- exact base APK: committed as verified chunks
- final package: `com.cairodrive.app`
- test signing: committed repeatable drive-test JKS
- Google keys: intentionally tracked in `config/google_keys.env` and embedded into the build at user request
- GitHub Secrets: none required
- private Release input: not used
- trigger: push to `main` or manual workflow dispatch
- artifact: `CairoDrive-v22.3-DRIVE-TEST-com.cairodrive.app`
- output: signed APK + signed AAB + verified universal APK + test/diagnostic tools

Use `./PUSH_TO_GITHUB.sh` from the already-cloned empty repo.
