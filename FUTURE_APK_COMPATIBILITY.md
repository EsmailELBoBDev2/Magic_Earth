# Future Magic Earth APK compatibility

The patch is **future-aware, not future-guaranteed**.

A new APK may be patched without rebasing when all of the runtime/API surface used by CairoDrive is still present. The preflight checks include:

- arm64 `libapp.so`, `libflutter.so`, `libGEM.so`
- SearchService / SearchRepositoryImpl / Landmark / LandmarkList
- RoutingService / NavigationService / NavigationInstruction
- `ERoutePathAlgorithm`, `MagicEarth`, `ExternalCh`
- `startNavigation`, `startNavigationWithRoute`
- `startSimulation`, `startSimulationWithRoute`, `isSimulationActive`
- libGEM exports `native_call`, `native_call_createObject`, `set_dart_port`

For an unknown/future `libapp.so` fingerprint:

- exact search-debounce byte patch is disabled
- exact libGEM global offsets are not consumed unless the full known libGEM module size + `set_dart_port` + `native_call` + `native_call_createObject` export layout matches
- Frida Gadget loads through the private ContentProvider, not an exact `libflutter.so` patch
- helper DEX uses the next available `classesN.dex` instead of assuming `classes7.dex`
- runtime hooks remain fail-open

This means a minor future release with the same callable interfaces has a good chance of working. A source-level-similar rebuild is **not enough** to guarantee compatibility because Flutter AOT/native layouts can change. If preflight fails, do not force the patch; rebase/audit the new APK.

## Updating the bundled base APK

Use:

```bash
./ci/update-base-apk.sh /path/to/new-magic-earth.apk
```

The script runs both compatibility gates **before** deleting the current known-good chunks. If the new APK fails, the current bundled target remains unchanged.
