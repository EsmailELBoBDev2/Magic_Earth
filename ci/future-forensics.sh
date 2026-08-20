#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APK="${1:?usage: ci/future-forensics.sh /path/base.apk [outdir]}"
OUT="${2:-$ROOT/forensics}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT/logs" "$OUT/native" "$OUT/prior-build"
FULL_NATIVE="${FULL_NATIVE_FORENSICS:-0}"
REPORT="$OUT/FUTURE_APK_REPORT.txt"
: > "$REPORT"

section(){ printf '\n===== %s =====\n' "$1" | tee -a "$REPORT"; }
runlog(){
  local name="$1"; shift
  printf '\n$ %q' "$1" >> "$OUT/logs/$name.log"; for a in "${@:2}"; do printf ' %q' "$a" >> "$OUT/logs/$name.log"; done; printf '\n' >> "$OUT/logs/$name.log"
  "$@" >> "$OUT/logs/$name.log" 2>&1
  local rc=$?
  echo "[$name] exit=$rc" | tee -a "$REPORT"
  return 0
}

section 'PRIOR CI / BUILD FAILURE CONTEXT'
if [[ -d "$OUT/prior-build" ]]; then
  python3 "$ROOT/tools/classify_build_failure.py" "$OUT/prior-build" --out "$OUT/BUILD_FAILURE_CLASSIFICATION.json" > "$OUT/logs/build-failure-classification.log" 2>&1 || true
  if [[ -f "$OUT/BUILD_FAILURE_CLASSIFICATION.json" ]]; then
    python3 - "$OUT/BUILD_FAILURE_CLASSIFICATION.json" <<'PYCLASS' | tee -a "$REPORT"
import json,sys
d=json.load(open(sys.argv[1])); print('build_failure_primary='+str(d.get('primary'))); print('build_failure_categories='+','.join(d.get('categories',[])))
PYCLASS
  fi
  BUILD_LOG="$(find "$OUT/prior-build" -type f -name 'BUILD_STAGE.log' -print -quit 2>/dev/null || true)"
  if [[ -n "$BUILD_LOG" ]]; then
    echo '-- tail BUILD_STAGE.log --' | tee -a "$REPORT"
    tail -n 180 "$BUILD_LOG" | tee -a "$REPORT"
  fi
else
  echo 'prior_build_evidence=not_available' | tee -a "$REPORT"
fi

section 'IDENTITY / INPUT'
echo "generated_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$REPORT"
echo "apk=$(basename "$APK")" | tee -a "$REPORT"
echo "size_bytes=$(stat -c '%s' "$APK")" | tee -a "$REPORT"
echo "sha256=$(sha256sum "$APK" | awk '{print $1}')" | tee -a "$REPORT"
echo "runner=$(uname -a)" | tee -a "$REPORT"
[[ -f "$ROOT/input/SOURCE_INFO.txt" ]] && { echo '-- source --' | tee -a "$REPORT"; cat "$ROOT/input/SOURCE_INFO.txt" | tee -a "$REPORT"; }
runlog unzip_test unzip -tq "$APK"
runlog aapt_badging aapt2 dump badging "$APK"
runlog manifest_tree aapt2 dump xmltree "$APK" AndroidManifest.xml
runlog signature apksigner verify --verbose --print-certs "$APK"

section 'PATCH COMPATIBILITY GATES'
python3 "$ROOT/tools/preflight.py" "$APK" --report "$OUT/preflight.json" > "$OUT/logs/preflight.log" 2>&1
PRE=$?
python3 "$ROOT/ci/verify-target-routing-surface.py" "$APK" > "$OUT/logs/routing-surface.log" 2>&1
ROUTE=$?
echo "preflight_exit=$PRE" | tee -a "$REPORT"
echo "routing_surface_exit=$ROUTE" | tee -a "$REPORT"
DELTA=127
if [[ -f "$OUT/preflight.json" && -f "$ROOT/baseline/known-good.json" ]]; then
  python3 "$ROOT/tools/compatibility_delta.py" "$OUT/preflight.json" --baseline "$ROOT/baseline/known-good.json" --out "$OUT/compatibility-delta.json" > "$OUT/logs/compatibility-delta.log" 2>&1
  DELTA=$?
fi
echo "compatibility_delta_exit=$DELTA" | tee -a "$REPORT"
[[ -f "$OUT/preflight.json" ]] && cat "$OUT/preflight.json" >> "$REPORT"
[[ -f "$OUT/compatibility-delta.json" ]] && { echo '-- baseline delta --' >> "$REPORT"; cat "$OUT/compatibility-delta.json" >> "$REPORT"; }

section 'KNOWN-GOOD APK DELTA'
BASELINE_APK="$WORK/known-good-base.apk"
if [[ -f "$ROOT/base_apk_parts/SHA256.txt" ]]; then
  if "$ROOT/ci/reassemble-base-apk.sh" "$BASELINE_APK" > "$OUT/logs/baseline-reassemble.log" 2>&1; then
    python3 "$ROOT/tools/apk_inventory_delta.py" "$BASELINE_APK" "$APK" --out "$OUT/APK_INVENTORY_DELTA.json" > "$OUT/logs/apk-inventory-delta.log" 2>&1 || true
    if [[ -f "$OUT/APK_INVENTORY_DELTA.json" ]]; then
      python3 - "$OUT/APK_INVENTORY_DELTA.json" <<'PY' | tee -a "$REPORT"
import json,sys
d=json.load(open(sys.argv[1])); print('apk_inventory_delta_counts='+json.dumps(d.get('counts',{}),sort_keys=True)); print('key_sha256='+json.dumps(d.get('key_sha256',{}),sort_keys=True))
PY
    fi
  fi
fi

section 'APK INVENTORY'
python3 - "$APK" "$OUT" <<'PY' >> "$REPORT" 2>"$OUT/logs/zip-inventory.err"
import sys,zipfile
apk,out=sys.argv[1:]
with zipfile.ZipFile(apk) as z:
    infos=z.infolist()
    print('zip_entries=',len(infos),sep='')
    print('largest_entries:')
    for i in sorted(infos,key=lambda x:x.file_size,reverse=True)[:40]:
        print(f'{i.file_size:12d} {i.compress_size:12d} {i.filename}')
    libs=[i.filename for i in infos if i.filename.startswith('lib/') and i.filename.endswith('.so')]
    print('native_lib_count=',len(libs),sep='')
    for n in libs[:300]: print('LIB',n)
PY

# Extract ARM64 libraries for native inspection.
mkdir -p "$WORK/native-root"
unzip -q -o "$APK" 'lib/arm64-v8a/*.so' -d "$WORK/native-root" 2>"$OUT/logs/native-extract.log" || true
section 'NATIVE ELF SUMMARY'
INV="$OUT/native/NATIVE_INVENTORY.tsv"
printf 'name\tsize_bytes\tsha256\tdetailed\n' > "$INV"
if [[ -d "$WORK/native-root/lib/arm64-v8a" ]]; then
  while IFS= read -r -d '' so; do
    n="$(basename "$so")"; stem="${n%.so}"
    size="$(stat -c '%s' "$so")"; hash="$(sha256sum "$so" | awk '{print $1}')"
    detailed=0
    case "$n" in libapp.so|libGEM.so|libflutter.so) detailed=1;; esac
    [[ "$FULL_NATIVE" == 1 ]] && detailed=1
    printf '%s\t%s\t%s\t%s\n' "$n" "$size" "$hash" "$detailed" >> "$INV"
    echo "--- $n size=$size sha256=$hash detailed=$detailed ---" | tee -a "$REPORT"
    file "$so" | tee -a "$REPORT"
    readelf -h "$so" > "$OUT/native/${stem}.elf-header.txt" 2>&1 || true
    readelf -lW "$so" > "$OUT/native/${stem}.program-headers.txt" 2>&1 || true
    readelf -dW "$so" > "$OUT/native/${stem}.dynamic.txt" 2>&1 || true
    if (( detailed )); then
      readelf -Ws "$so" > "$OUT/native/${stem}.symbols.txt" 2>&1 || true
      nm -D "$so" > "$OUT/native/${stem}.nm.txt" 2>&1 || true
      strings -a -n 6 "$so" > "$OUT/native/${stem}.strings.txt" 2>&1 || true
    fi
    printf 'RELRO=' | tee -a "$REPORT"; (grep -q 'GNU_RELRO' "$OUT/native/${stem}.program-headers.txt" && echo yes || echo no) | tee -a "$REPORT"
    printf 'GNU_STACK=' | tee -a "$REPORT"; (grep 'GNU_STACK' "$OUT/native/${stem}.program-headers.txt" | head -1 || echo unknown) | tee -a "$REPORT"
  done < <(find "$WORK/native-root/lib/arm64-v8a" -maxdepth 1 -type f -name '*.so' -print0 | sort -z)
fi

if [[ -f "$WORK/native-root/lib/arm64-v8a/libGEM.so" ]]; then
  runlog gem_discovery python3 "$ROOT/tools/discover_gem_globals.py" "$WORK/native-root/lib/arm64-v8a/libGEM.so"
fi

section 'APKTOOL FULL DECODE'
timeout 15m apktool d -f -o "$WORK/apktool" "$APK" > "$OUT/logs/apktool.log" 2>&1
APKTOOL_RC=$?
echo "apktool_exit=$APKTOOL_RC" | tee -a "$REPORT"
if [[ -d "$WORK/apktool" ]]; then
  echo "apktool_files=$(find "$WORK/apktool" -type f | wc -l)" | tee -a "$REPORT"
  if [[ -f "$WORK/apktool/AndroidManifest.xml" ]]; then cp "$WORK/apktool/AndroidManifest.xml" "$OUT/AndroidManifest.decoded.xml"; fi
fi

section 'JADX FULL DEX DECOMPILE'
JADX_RC=127
if command -v jadx >/dev/null 2>&1; then
  timeout 20m jadx --show-bad-code -d "$WORK/jadx" "$APK" > "$OUT/logs/jadx.log" 2>&1
  JADX_RC=$?
fi
echo "jadx_exit=$JADX_RC" | tee -a "$REPORT"
if [[ -d "$WORK/jadx" ]]; then
  echo "jadx_files=$(find "$WORK/jadx" -type f | wc -l)" | tee -a "$REPORT"
  {
    echo '=== HIGH-VALUE SEMANTIC MATCHES (capped) ==='
    rg -n -i --no-heading -m 3 \
      'SearchService|SearchRepositoryImpl|NavigationService|RoutingService|startNavigation|startSimulation|ExternalCh|MagicEarth|native_call|set_dart_port|Google Places|traffic|roadblock|singletrack|narrow' \
      "$WORK/jadx" 2>/dev/null | head -n 800 || true
  } > "$OUT/JADX_SEMANTIC_MATCHES.txt"
  {
    echo '=== URL / ENDPOINT CANDIDATES (capped) ==='
    rg -o --no-filename 'https?://[^"'"'"' <>)]+' "$WORK/jadx" 2>/dev/null | sort -u | head -n 500 || true
  } > "$OUT/JADX_URLS.txt"
fi

section 'BLUTTER / FLUTTER AOT ANALYSIS'
BLUTTER_RC=127
if [[ -d /opt/blutter && -f "$WORK/native-root/lib/arm64-v8a/libapp.so" && -f "$WORK/native-root/lib/arm64-v8a/libflutter.so" ]]; then
  timeout 35m python3 /opt/blutter/blutter.py "$APK" "$WORK/blutter" > "$OUT/logs/blutter.log" 2>&1
  BLUTTER_RC=$?
fi
echo "blutter_exit=$BLUTTER_RC" | tee -a "$REPORT"
if [[ -d "$WORK/blutter" ]]; then
  [[ -f "$WORK/blutter/blutter_frida.js" ]] && cp "$WORK/blutter/blutter_frida.js" "$OUT/blutter_frida.js"
  for f in objs.txt pp.txt; do
    if [[ -f "$WORK/blutter/$f" ]]; then
      head -c $((5*1024*1024)) "$WORK/blutter/$f" > "$OUT/blutter_${f%.txt}_first5MiB.txt"
    fi
  done
  rg -n -i --no-heading \
    'SearchService|SearchRepositoryImpl|NavigationService|RoutingService|startNavigation|startSimulation|ExternalCh|MagicEarth|traffic|roadblock|singletrack|narrow' \
    "$WORK/blutter" 2>/dev/null | head -n 1200 > "$OUT/BLUTTER_SEMANTIC_MATCHES.txt" || true
fi

section 'TOOLCHAIN PROVENANCE'
"$ROOT/ci/toolchain-report.sh" "$OUT/TOOLCHAIN_PROVENANCE.txt" >> "$REPORT" 2>&1 || true

section 'PATCHER REPOSITORY SELFTEST'
"$ROOT/verify_patcher.sh" > "$OUT/logs/verify-patcher.log" 2>&1
VERIFY_RC=$?
echo "verify_patcher_exit=$VERIFY_RC" | tee -a "$REPORT"

section 'DIAGNOSIS POINTERS'
if (( PRE != 0 || ROUTE != 0 || DELTA == 42 )); then
  echo 'classification=UPSTREAM_STRUCTURAL_CHANGE' | tee -a "$REPORT"
  echo 'action=Patch was correctly refused. Inspect preflight.json, routing-surface.log, JADX_SEMANTIC_MATCHES.txt, BLUTTER_SEMANTIC_MATCHES.txt, and native/*.strings.txt.' | tee -a "$REPORT"
else
  echo 'classification=PATCH_OR_BUILD_STAGE_FAILURE' | tee -a "$REPORT"
  echo 'action=Target surface still looks compatible. Inspect verify-patcher.log plus the original failed build log; likely packaging/signing/resource rewrite/toolchain rather than target incompatibility.' | tee -a "$REPORT"
fi
cat >> "$REPORT" <<'TXT'
frida_dynamic_ci_note=Static CI can generate/inspect Frida/Blutter instrumentation material, but a true runtime Frida trace requires a booted Android target where the app can launch. Do not treat absence of a dynamic trace as proof that runtime behavior is correct.
artifact_hint=Send FUTURE_APK_REPORT.txt first. If needed, also send preflight.json, logs/preflight.log, logs/routing-surface.log, JADX_SEMANTIC_MATCHES.txt, BLUTTER_SEMANTIC_MATCHES.txt, and the specific native string/symbol report requested.
TXT

# Compact machine-readable index; do not upload the enormous full decompile trees.
CAIRODRIVE_DELTA_RC="$DELTA" python3 - "$OUT" "$PRE" "$ROUTE" "$APKTOOL_RC" "$JADX_RC" "$BLUTTER_RC" "$VERIFY_RC" <<'PY'
import json,os,sys
out=sys.argv[1]
vals=list(map(int,sys.argv[2:]))
keys=['preflight','routing_surface','apktool','jadx','blutter','verify_patcher']
d={k:v for k,v in zip(keys,vals)}
d['compatibility_delta']=int(os.environ.get('CAIRODRIVE_DELTA_RC','127'))
json.dump(d,open(os.path.join(out,'FORENSICS_STATUS.json'),'w'),indent=2)
PY

echo | tee -a "$REPORT"
echo "FORENSICS COMPLETE: $OUT" | tee -a "$REPORT"
exit 0
