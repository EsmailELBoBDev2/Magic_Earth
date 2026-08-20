#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  build-essential binutils curl file gh git jq python3 python3-pip \
  unzip xz-utils zip

APKTOOL_VERSION='3.0.3'
APKTOOL_SHA256='dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423'
APKTOOL_JAR="$HOME/.cache/cairodrive/apktool_${APKTOOL_VERSION}.jar"
mkdir -p "$(dirname "$APKTOOL_JAR")" "$HOME/.local/bin"
if [[ ! -f "$APKTOOL_JAR" ]] || [[ "$(sha256sum "$APKTOOL_JAR" | awk '{print $1}')" != "$APKTOOL_SHA256" ]]; then
  rm -f "$APKTOOL_JAR"
  curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
    "https://github.com/iBotPeaches/Apktool/releases/download/v${APKTOOL_VERSION}/apktool_${APKTOOL_VERSION}.jar" \
    -o "$APKTOOL_JAR"
fi
echo "$APKTOOL_SHA256  $APKTOOL_JAR" | sha256sum -c -
cat > "$HOME/.local/bin/apktool" <<EOF
#!/usr/bin/env bash
exec java -jar '$APKTOOL_JAR' "\$@"
EOF
chmod 0755 "$HOME/.local/bin/apktool"
export PATH="$HOME/.local/bin:$PATH"
if [[ -n "${GITHUB_PATH:-}" ]]; then printf '%s\n' "$HOME/.local/bin" >> "$GITHUB_PATH"; fi

: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
export ANDROID_HOME ANDROID_SDK_ROOT="$ANDROID_HOME"
command -v sdkmanager >/dev/null || { echo 'sdkmanager missing after Android setup action' >&2; exit 1; }
yes | sdkmanager --licenses >/dev/null || true
sdkmanager \
  'platform-tools' \
  'platforms;android-36' \
  'build-tools;36.0.0'

BT="$ANDROID_HOME/build-tools/36.0.0"
for x in aapt2 apksigner d8 zipalign; do
  [[ -x "$BT/$x" ]] || { echo "missing Android build tool: $BT/$x" >&2; exit 1; }
done
export PATH="$BT:$ANDROID_HOME/platform-tools:$PATH"
if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n%s\n' "$BT" "$ANDROID_HOME/platform-tools" >> "$GITHUB_PATH"
fi

echo "Android SDK: $ANDROID_HOME"
aapt2 version
apksigner version
zipalign -h 2>&1 | head -1 || true
apktool --version
node --version
npm --version
java -version
