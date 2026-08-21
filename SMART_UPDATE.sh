#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"
INBOX="${CAIRODRIVE_APK_INBOX:-$ROOT/DROP_NEW_APK_HERE}"
mkdir -p "$INBOX"

usage(){ cat <<TXT
Usage:
  1) Copy one new Magic Earth APK into:
       $INBOX
  2) Run:
       ./SMART_UPDATE.sh

Or pass a path directly:
       ./SMART_UPDATE.sh /path/to/MagicEarth.apk
TXT
}

if (($# > 1)); then usage; exit 2; fi
if (($# == 1)); then
  APK="$1"
else
  mapfile -t APKS < <(find "$INBOX" -maxdepth 1 -type f -iname '*.apk' -printf '%T@\t%p\n' 2>/dev/null | sort -nr | cut -f2-)
  ((${#APKS[@]})) || { echo "ERROR: no .apk found in $INBOX" >&2; usage; exit 2; }
  APK="${APKS[0]}"
  if ((${#APKS[@]} > 1)); then
    echo "NOTE: multiple APKs found; selecting newest: $APK"
  fi
fi
APK="$(realpath "$APK")"
cat <<TXT
Selected upstream APK: $APK

SMART_UPDATE responsibilities:
  LOCAL  : validate APK container + manifest, hash it,
           upload the WHOLE APK to the upstream-apks GitHub Release,
           commit/push only the tiny SHA-pinned selector.
  GITHUB : materialize exact APK -> compatibility/delta/GEM checks -> patch/build/sign.
           If any safe-compatibility/build stage fails, automatic deep forensics runs
           and publishes the FUTURE-APK-HANDOFF artifact.

No heavy JADX/Apktool/Blutter reverse-engineering is performed locally by SMART_UPDATE.
TXT
exec "$ROOT/UPDATE_APK.sh" --watch "$APK"
