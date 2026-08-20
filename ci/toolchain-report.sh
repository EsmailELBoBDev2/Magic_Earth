#!/usr/bin/env bash
set -u
OUT="${1:-TOOLCHAIN_PROVENANCE.txt}"
{
  echo "generated_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "runner=$(uname -a)"
  for c in node npm java javac python3 aapt2 apksigner d8 zipalign apktool keytool jarsigner; do
    if command -v "$c" >/dev/null 2>&1; then
      printf '%s=' "$c"
      case "$c" in
        java|javac|keytool|jarsigner) "$c" -version 2>&1 | head -1;;
        *) "$c" --version 2>&1 | head -1 || "$c" version 2>&1 | head -1 || true;;
      esac
    else echo "$c=MISSING"; fi
  done
  echo "frida_expected=${FRIDA_VERSION:-17.17.0}"
  if [[ -f payload/package.json ]]; then
    python3 - <<'PY'
import json
p=json.load(open('payload/package.json'))
for group in ('dependencies','devDependencies'):
 for k,v in p.get(group,{}).items(): print(f'npm_{k}={v}')
PY
  fi
} > "$OUT"
cat "$OUT"
