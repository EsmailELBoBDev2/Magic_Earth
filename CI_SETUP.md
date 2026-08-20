# CairoDrive v22.3 CI setup

There is no GitHub Actions secret setup for the private drive-test build.

1. Clone `https://github.com/EsmailELBoBDev2/Magic_Earth`.
2. Unzip the GitHub-ready bundle into that clone.
3. Run `./PUSH_TO_GITHUB.sh`.
4. If the bundled key config still has placeholders, enter the Google Places key and optional Routes key once. They are intentionally committed to this private repo and embedded in the APK.
5. The push to `main` starts the workflow automatically.

The exact base APK is reconstructed from `base_apk_parts/`; the committed test JKS signs APK/AAB; no private Release or GitHub Secret is required.
