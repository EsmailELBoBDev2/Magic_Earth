#!/usr/bin/env bash
set -euo pipefail
EXPECTED="${EXPECTED_UPLOAD_CERT_SHA1:?EXPECTED_UPLOAD_CERT_SHA1 missing}"
B64="${CAIRODRIVE_KEYSTORE_BASE64:?CAIRODRIVE_KEYSTORE_BASE64 secret missing}"
STOREPASS="${ANDROID_KEYSTORE_PASSWORD:?ANDROID_KEYSTORE_PASSWORD secret missing}"
ALIAS="${ANDROID_KEY_ALIAS:?ANDROID_KEY_ALIAS secret missing}"
KEYPASS="${ANDROID_KEY_PASSWORD:-$STOREPASS}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
KS="$TMP/upload.keystore"
printf '%s' "$B64" | tr -d '\r\n ' | base64 -d > "$KS"
keytool -list -keystore "$KS" -storepass "$STOREPASS" -alias "$ALIAS" >/dev/null
ACTUAL="$(keytool -list -v -keystore "$KS" -storepass "$STOREPASS" -alias "$ALIAS" 2>/dev/null | sed -n 's/^[[:space:]]*SHA1:[[:space:]]*//p' | head -1)"
norm(){ printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | tr -d ':[:space:]'; }
[[ -n "$ACTUAL" && "$(norm "$ACTUAL")" == "$(norm "$EXPECTED")" ]] || {
  echo "ERROR: wrong Play upload signing key" >&2
  echo "expected=$EXPECTED" >&2
  echo "actual=${ACTUAL:-unreadable}" >&2
  exit 91
}
# Also prove the private key password is usable without printing any secret material.
keytool -importkeystore \
  -srckeystore "$KS" -srcstorepass "$STOREPASS" -srcalias "$ALIAS" -srckeypass "$KEYPASS" \
  -destkeystore "$TMP/test.p12" -deststoretype PKCS12 -deststorepass 'cairodrive-temp-verify' -destkeypass 'cairodrive-temp-verify' \
  -noprompt >/dev/null 2>&1 || { echo 'ERROR: signing private-key password is invalid' >&2; exit 92; }
echo "Play upload signing key: PASS ($ACTUAL) alias=$ALIAS"
