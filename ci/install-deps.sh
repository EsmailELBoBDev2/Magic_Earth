#!/usr/bin/env bash
set -euo pipefail
sudo apt-get update
sudo apt-get install -y --no-install-recommends build-essential binutils curl file git jq python3 unzip xz-utils zip
: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"; export ANDROID_HOME ANDROID_SDK_ROOT="$ANDROID_HOME"
command -v sdkmanager >/dev/null || { echo 'ERROR: sdkmanager missing' >&2; exit 1; }
yes | sdkmanager --licenses >/dev/null || true
sdkmanager 'platform-tools' 'platforms;android-36' 'build-tools;36.0.0'
BT="$ANDROID_HOME/build-tools/36.0.0"
printf '%s\n%s\n' "$BT" "$ANDROID_HOME/platform-tools" >> "${GITHUB_PATH:-/dev/null}" 2>/dev/null || true
export PATH="$BT:$ANDROID_HOME/platform-tools:$PATH"
# Pin Apktool instead of trusting distro version.
APKTOOL_VERSION=3.0.3
APKTOOL_SHA256=dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423
sudo curl -fL --retry 3 --retry-all-errors -o /usr/local/lib/apktool.jar "https://github.com/iBotPeaches/Apktool/releases/download/v${APKTOOL_VERSION}/apktool_${APKTOOL_VERSION}.jar"
echo "$APKTOOL_SHA256  /usr/local/lib/apktool.jar" | sha256sum -c -
sudo tee /usr/local/bin/apktool >/dev/null <<'EOF'
#!/usr/bin/env bash
exec java -jar /usr/local/lib/apktool.jar "$@"
EOF
sudo chmod 0755 /usr/local/bin/apktool
for x in aapt2 apksigner d8 zipalign; do [[ -x "$BT/$x" ]] || { echo "ERROR: missing $BT/$x" >&2; exit 1; }; done
apktool --version
aapt2 version
apksigner version
