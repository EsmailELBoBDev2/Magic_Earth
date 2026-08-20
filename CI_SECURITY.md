# CairoDrive v22.3 private drive-test security model

- Exact target hashes and hook guards fail closed.
- Google HTTP helper is host/body/response/state bounded.
- Test signing key is intentionally committed and is not a Play/production key.
- Google API keys are intentionally tracked and embedded at the user's request. A private repo protects source access, but an APK recipient can extract them. Restrict the keys to the needed APIs, quotas, package `com.cairodrive.app`, and the documented drive-test SHA-1.
- `android:allowBackup=false` is set for CairoDrive runtime state.
- Google navigation takeover and premium/license bypass are absent.
