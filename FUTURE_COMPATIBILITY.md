# CairoDrive v22.3 future-version compatibility

v22.3 is **future-ready, not magically version-proof**. It removes the two largest exact-build assumptions:

1. Frida Gadget is loaded by a non-exported Android `ContentProvider`; `libflutter.so` is no longer binary-patched.
2. `libGEM`'s Dart-port and PostCObject globals are derived from the exported `set_dart_port` AArch64 code shape on every build instead of fixed offsets.

The 1000ms→400ms Dart AOT debounce change is now optional and signature-scanned. If a future compiler changes that code, CairoDrive keeps stock debounce rather than failing/corrupting the app.

`tools/preflight.py` structurally checks future APKs for the required package, arm64 libraries, `native_call`, `native_call_createObject`, `set_dart_port`, search/navigation semantic markers and routing surface. A future APK that still exposes those contracts can proceed automatically. If any critical contract changed, CI deliberately stops with `INCOMPATIBLE` instead of attempting a blind patch.

## Updating the base APK later

```bash
./tools/import_base_apk.sh ~/Downloads/new-magic-earth.apk
./VERIFY_REPO.sh
git add -- base_apk_parts
git commit -m 'Update Magic Earth base APK'
git push
```

If CI reports `PORTABLE_CANDIDATE`, the version passed the compatibility checks. If CI stops at preflight/global discovery, that release needs a new reverse-engineering compatibility profile before drive testing.
