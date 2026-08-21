#!/usr/bin/env bash
set -euo pipefail

EXPECTED_SHA1='D9:19:59:58:60:C9:47:E3:FC:A6:5A:16:EF:FB:BF:9F:C3:E7:2F:9A'
REPO='EsmailELBoBDev2/Magic_Earth'
KEY_B64_FILE="${1:-}"

fail(){ echo "ERROR: $*" >&2; exit 1; }
need(){ command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"; }
for c in git gh python3 base64 keytool awk sed tr mktemp; do need "$c"; done

[[ -n "$KEY_B64_FILE" ]] || fail "usage: $0 /path/to/original-play-keystore.b64"
[[ -f "$KEY_B64_FILE" ]] || fail "keystore base64 file not found: $KEY_B64_FILE"

git rev-parse --show-toplevel >/dev/null 2>&1 || fail 'run this inside the Magic_Earth checkout'
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
REMOTE="$(git remote get-url origin 2>/dev/null || true)"
[[ "$REMOTE" == *'EsmailELBoBDev2/Magic_Earth'* ]] || fail "origin is not $REPO: $REMOTE"
[[ -z "$(git status --porcelain)" ]] || fail 'working tree is not clean; commit/stash your current changes first'

echo '==> Syncing current main'
git fetch origin main
git merge --ff-only origin/main

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
KS="$TMP/play-upload.keystore"
tr -d '\r\n ' < "$KEY_B64_FILE" | base64 -d > "$KS" || fail 'uploaded file is not valid base64 keystore data'
[[ -s "$KS" ]] || fail 'decoded keystore is empty'

printf 'Keystore/store password: '
IFS= read -r -s STOREPASS
echo
[[ -n "$STOREPASS" ]] || fail 'empty keystore password'

# Detect private-key aliases after authenticating the keystore.
LIST="$TMP/keytool-list.txt"
keytool -list -v -keystore "$KS" -storepass "$STOREPASS" > "$LIST" 2>/dev/null || fail 'keystore password is wrong or the keystore is unreadable'
mapfile -t ALIASES < <(awk '
  /^Alias name:/ { sub(/^Alias name:[[:space:]]*/, ""); alias=$0 }
  /^Entry type:[[:space:]]*PrivateKeyEntry/ { if (alias != "") print alias }
' "$LIST")
((${#ALIASES[@]} > 0)) || fail 'no PrivateKeyEntry found in keystore'
if ((${#ALIASES[@]} == 1)); then
  ALIAS="${ALIASES[0]}"
  echo "Detected key alias: $ALIAS"
else
  echo 'Private-key aliases found:'
  printf '  %s\n' "${ALIASES[@]}"
  read -r -p 'Alias to use: ' ALIAS
  [[ -n "$ALIAS" ]] || fail 'empty alias'
fi

ACTUAL_SHA1="$(keytool -list -v -keystore "$KS" -storepass "$STOREPASS" -alias "$ALIAS" 2>/dev/null \
  | sed -n 's/^[[:space:]]*SHA1:[[:space:]]*//p' | head -1)"
[[ -n "$ACTUAL_SHA1" ]] || fail 'could not read certificate SHA1'
norm(){ printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | tr -d ':[:space:]'; }
if [[ "$(norm "$ACTUAL_SHA1")" != "$(norm "$EXPECTED_SHA1")" ]]; then
  echo "Expected Play SHA1: $EXPECTED_SHA1" >&2
  echo "Uploaded key SHA1: $ACTUAL_SHA1" >&2
  fail 'THIS IS NOT THE PLAY UPLOAD KEY. Nothing was changed or pushed.'
fi
echo "Play certificate fingerprint: PASS ($ACTUAL_SHA1)"

printf 'Private-key password [press Enter if same as store password]: '
IFS= read -r -s KEYPASS
echo
[[ -n "$KEYPASS" ]] || KEYPASS="$STOREPASS"

# Prove we can actually decrypt/export the private key with the supplied key password.
TESTKS="$TMP/private-key-test.p12"
keytool -importkeystore \
  -srckeystore "$KS" -srcstorepass "$STOREPASS" -srcalias "$ALIAS" -srckeypass "$KEYPASS" \
  -destkeystore "$TESTKS" -deststoretype PKCS12 -deststorepass 'cairodrive-temp-verify' -destkeypass 'cairodrive-temp-verify' \
  -noprompt >/dev/null 2>&1 || fail 'key password is wrong; no secrets/code were changed'
echo 'Private-key decryption: PASS'

cat > ci/validate-signing-key.sh <<'VALIDATOR'
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
VALIDATOR
chmod +x ci/validate-signing-key.sh

python3 - <<'PY'
from pathlib import Path

expected = 'D9:19:59:58:60:C9:47:E3:FC:A6:5A:16:EF:FB:BF:9F:C3:E7:2F:9A'

# --- workflow ---
p = Path('.github/workflows/build.yml')
s = p.read_text()
validate_step = '''      - name: Validate Play upload signing key\n        env:\n          CAIRODRIVE_KEYSTORE_BASE64: ${{ secrets.CAIRODRIVE_KEYSTORE_BASE64 }}\n          ANDROID_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}\n          ANDROID_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}\n          ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}\n          EXPECTED_UPLOAD_CERT_SHA1: D9:19:59:58:60:C9:47:E3:FC:A6:5A:16:EF:FB:BF:9F:C3:E7:2F:9A\n        run: ./ci/validate-signing-key.sh\n\n'''
if 'name: Validate Play upload signing key' not in s:
    marker = '      - name: Fetch pinned Frida Gadget\n'
    if marker not in s:
        raise SystemExit('workflow patch failed: Fetch pinned Frida Gadget marker missing')
    s = s.replace(marker, validate_step + marker, 1)

old = '''      - name: Build signed drive-test APK + AAB\n        env:\n          CAIRODRIVE_KEYSTORE_B64_FILE: ${{ github.workspace }}/ci/signing/drive-test.keystore.b64\n          ANDROID_KEYSTORE_PASSWORD: cairodrive-drive-test-2026\n          ANDROID_KEY_PASSWORD: cairodrive-drive-test-2026\n          ANDROID_KEY_ALIAS: cairodrive\n          FRIDA_GADGET: ${{ github.workspace }}/input/frida-gadget-android-arm64.so\n          OUTDIR: ${{ github.workspace }}/out\n'''
new = '''      - name: Build Play-signed APK + AAB\n        env:\n          CAIRODRIVE_KEYSTORE_BASE64: ${{ secrets.CAIRODRIVE_KEYSTORE_BASE64 }}\n          ANDROID_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}\n          ANDROID_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}\n          ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}\n          EXPECTED_UPLOAD_CERT_SHA1: D9:19:59:58:60:C9:47:E3:FC:A6:5A:16:EF:FB:BF:9F:C3:E7:2F:9A\n          FRIDA_GADGET: ${{ github.workspace }}/input/frida-gadget-android-arm64.so\n          OUTDIR: ${{ github.workspace }}/out\n'''
if old in s:
    s = s.replace(old, new, 1)
elif 'CAIRODRIVE_KEYSTORE_BASE64: ${{ secrets.CAIRODRIVE_KEYSTORE_BASE64 }}' not in s:
    raise SystemExit('workflow patch failed: old hardcoded signing block not found')
s = s.replace('-DRIVE-TEST-${{ github.sha }}', '-PLAY-SIGNED-${{ github.sha }}')
p.write_text(s)

# --- build_cairodrive.sh: remove wrong-key fallback and enforce expected SHA1 ---
p = Path('build_cairodrive.sh')
s = p.read_text()
s = s.replace('  [[ -n "$f" ]] || { [[ -f "$ROOT/ci/signing/drive-test.keystore.b64" ]] && f="$ROOT/ci/signing/drive-test.keystore.b64"; }\n', '')
s = s.replace("  [[ -n \"$f\" && -f \"$f\" ]] || { echo 'ERROR: signing keystore missing' >&2; exit 1; }\n",
              "  [[ -n \"$f\" && -f \"$f\" ]] || { echo 'ERROR: signing keystore missing; provide CAIRODRIVE_KEYSTORE, CAIRODRIVE_KEYSTORE_BASE64, or CAIRODRIVE_KEYSTORE_B64_FILE' >&2; exit 1; }\n")
needle = 'keytool -list -keystore "$KS" -storepass "$STOREPASS" -alias "$ALIAS" >/dev/null\n'
insert = needle + '''CERT_SHA1="$(keytool -list -v -keystore "$KS" -storepass "$STOREPASS" -alias "$ALIAS" 2>/dev/null | sed -n 's/^[[:space:]]*SHA1:[[:space:]]*//p' | head -1)"\nif [[ -n "${EXPECTED_UPLOAD_CERT_SHA1:-}" ]]; then\n  norm_sha1(){ printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | tr -d ':[:space:]'; }\n  [[ -n "$CERT_SHA1" && "$(norm_sha1 "$CERT_SHA1")" == "$(norm_sha1 "$EXPECTED_UPLOAD_CERT_SHA1")" ]] || {\n    echo "ERROR: wrong signing key: expected Play SHA1=$EXPECTED_UPLOAD_CERT_SHA1 actual=${CERT_SHA1:-unreadable}" >&2\n    exit 91\n  }\n  echo "Play signing fingerprint guard: PASS ($CERT_SHA1)"\nfi\n'''
if 'Play signing fingerprint guard: PASS' not in s:
    if needle not in s:
        raise SystemExit('build_cairodrive patch failed: keytool marker missing')
    s = s.replace(needle, insert, 1)
p.write_text(s)

# --- verifier ---
p = Path('VERIFY_REPO.sh')
s = p.read_text()
s = s.replace('[[ -f ci/signing/drive-test.keystore.b64 ]]\n', '')
s = s.replace("! grep -q 'secrets\\.' .github/workflows/build.yml\n",
'''[[ -x ci/validate-signing-key.sh ]]\ngrep -Fq 'secrets.CAIRODRIVE_KEYSTORE_BASE64' .github/workflows/build.yml\ngrep -Fq 'secrets.ANDROID_KEYSTORE_PASSWORD' .github/workflows/build.yml\ngrep -Fq 'secrets.ANDROID_KEY_PASSWORD' .github/workflows/build.yml\ngrep -Fq 'secrets.ANDROID_KEY_ALIAS' .github/workflows/build.yml\ngrep -Fq 'EXPECTED_UPLOAD_CERT_SHA1: D9:19:59:58:60:C9:47:E3:FC:A6:5A:16:EF:FB:BF:9F:C3:E7:2F:9A' .github/workflows/build.yml\n! grep -Fq 'CAIRODRIVE_KEYSTORE_B64_FILE: ${{ github.workspace }}/ci/signing/drive-test.keystore.b64' .github/workflows/build.yml\n! grep -Fq 'ANDROID_KEYSTORE_PASSWORD: cairodrive-drive-test-2026' .github/workflows/build.yml\ngrep -Fq 'Play signing fingerprint guard: PASS' build_cairodrive.sh\n''')
s = s.replace('zero-secret CI checks pass.', 'Play-key secret signing and fail-closed fingerprint checks pass.')
p.write_text(s)
PY

bash -n ci/validate-signing-key.sh
bash -n build_cairodrive.sh
bash -n VERIFY_REPO.sh
python3 - <<'PY'
import yaml
with open('.github/workflows/build.yml') as f:
    yaml.safe_load(f)
print('workflow YAML parse: PASS')
PY

# Repo verifier may reconstruct the large baseline; run it so a bad patch never gets pushed.
./VERIFY_REPO.sh

echo '==> Installing GitHub Actions signing secrets (contents will not be printed)'
printf '%s' "$(tr -d '\r\n ' < "$KEY_B64_FILE")" | gh secret set CAIRODRIVE_KEYSTORE_BASE64 --repo "$REPO"
printf '%s' "$STOREPASS" | gh secret set ANDROID_KEYSTORE_PASSWORD --repo "$REPO"
printf '%s' "$KEYPASS" | gh secret set ANDROID_KEY_PASSWORD --repo "$REPO"
printf '%s' "$ALIAS" | gh secret set ANDROID_KEY_ALIAS --repo "$REPO"

echo '==> Committing the signing fix'
git add .github/workflows/build.yml build_cairodrive.sh VERIFY_REPO.sh ci/validate-signing-key.sh
git diff --cached --check
git commit -m 'Use Play upload key and enforce expected signing certificate'
git push origin main

echo
echo 'FIX APPLIED AND PUSHED.'
echo "Required Play SHA1: $EXPECTED_SHA1"
echo "Validated uploaded SHA1: $ACTUAL_SHA1"
echo 'The workflow no longer uses the bundled EA:B8:... drive-test key.'

echo '==> Waiting for the new CI run to appear'
sleep 4
RUN_ID="$(gh run list --repo "$REPO" --workflow build.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
[[ -n "$RUN_ID" ]] || fail 'push succeeded but could not locate the new workflow run'
echo "CI run: $RUN_ID"
gh run watch "$RUN_ID" --repo "$REPO" --exit-status || {
  echo "CI run $RUN_ID failed. The signing key itself was already validated as the exact Play key, so inspect only the new CI error." >&2
  exit 1
}

echo
echo 'CI SUCCESS. Download the PLAY-SIGNED artifact and upload its .aab to Google Play Console.'
