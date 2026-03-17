#!/usr/bin/env bash
# build-android.sh — Build the Android APK without Android Studio.
# Requires: Node.js ≥ 18, Java 17, internet access (first run only).
# Usage:
#   ./build-android.sh            # debug APK
#   ./build-android.sh --release  # release APK (unsigned)
#   ./build-android.sh --install  # debug APK + adb install to connected device

set -euo pipefail

# ─── Colour helpers ───────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ─── Args ─────────────────────────────────────────────────────────────────────
BUILD_TYPE="debug"
INSTALL=false
PUSH=false
for arg in "$@"; do
  case "$arg" in
    --release) BUILD_TYPE="release" ;;
    --install) INSTALL=true ;;
    --push)    PUSH=true ;;
    --help|-h)
      echo "Usage: $0 [--release] [--install] [--push]"
      echo "  --release   Build an unsigned release APK"
      echo "  --install   Install APK directly via adb (requires USB debugging)"
      echo "  --push      Copy APK to device Downloads/ via adb + trigger media scan"
      echo "              (makes it visible in Files app without USB debugging)"
      exit 0 ;;
    *) die "Unknown argument: $arg" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ─── Constants ────────────────────────────────────────────────────────────────
ANDROID_SDK_DIR="$SCRIPT_DIR/.android-sdk"
CMDLINE_TOOLS_VERSION="11076708"   # commandlinetools-mac-11076708_latest.zip
CMDLINE_TOOLS_MAC_URL="https://dl.google.com/android/repository/commandlinetools-mac-${CMDLINE_TOOLS_VERSION}_latest.zip"
CMDLINE_TOOLS_LINUX_URL="https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip"
BUILD_TOOLS_VERSION="34.0.0"
PLATFORM_VERSION="android-34"
JAVA_PKG_DIR="android/app/src/main/java/com/whentoquit/app"
MANIFEST_FILE="android/app/src/main/AndroidManifest.xml"

# ═══════════════════════════════════════════════════════════════════════════════
# 1 — Check Java 17
# ═══════════════════════════════════════════════════════════════════════════════
info "Checking Java..."
if ! command -v java &>/dev/null; then
  die "Java not found. Install Java 17:\n  macOS:   brew install openjdk@17\n  Ubuntu:  sudo apt install openjdk-17-jdk"
fi
JAVA_VERSION_STR=$(java -version 2>&1) \
  || die "Java found but failed to execute.\n  macOS: ensure a real JDK is installed: brew install openjdk@17\n  Then add it to PATH: export PATH=\"$(brew --prefix openjdk@17)/bin:\$PATH\""
JAVA_VER=$(echo "$JAVA_VERSION_STR" | awk -F '"' '/version/ {print $2}' | cut -d. -f1)
if [[ -z "$JAVA_VER" ]]; then
  die "Could not parse Java version from:\n  $JAVA_VERSION_STR"
fi
if [[ "$JAVA_VER" -lt 17 ]]; then
  die "Java 17+ required (found Java $JAVA_VER).\n  macOS:   brew install openjdk@17\n  Ubuntu:  sudo apt install openjdk-17-jdk"
fi
success "Java $JAVA_VER found"

# ═══════════════════════════════════════════════════════════════════════════════
# 2 — Check Node.js
# ═══════════════════════════════════════════════════════════════════════════════
info "Checking Node.js..."
if ! command -v node &>/dev/null; then
  die "Node.js not found. Install from https://nodejs.org/ (≥ 18 required)"
fi
NODE_VER=$(node -e "process.stdout.write(process.versions.node.split('.')[0])") \
  || die "Node.js found but failed to execute. Try reinstalling from https://nodejs.org/"
if [[ -z "$NODE_VER" || "$NODE_VER" -lt 18 ]]; then
  die "Node.js 18+ required (found ${NODE_VER:-unknown})"
fi
success "Node.js $NODE_VER found"

# ═══════════════════════════════════════════════════════════════════════════════
# 3 — Set up Android SDK (command-line tools only)
# ═══════════════════════════════════════════════════════════════════════════════
setup_android_sdk() {
  info "Setting up Android command-line tools in $ANDROID_SDK_DIR ..."
  mkdir -p "$ANDROID_SDK_DIR"

  local OS
  case "$(uname -s)" in
    Darwin) OS="mac" ;;
    Linux)  OS="linux" ;;
    *)      die "Unsupported OS. Set ANDROID_HOME manually and re-run." ;;
  esac

  local URL
  [[ "$OS" == "mac" ]] && URL="$CMDLINE_TOOLS_MAC_URL" || URL="$CMDLINE_TOOLS_LINUX_URL"
  local ZIP="$ANDROID_SDK_DIR/cmdline-tools.zip"

  info "Downloading Android command-line tools (~150 MB)..."
  if command -v curl &>/dev/null; then
    curl -L --progress-bar -o "$ZIP" "$URL"
  elif command -v wget &>/dev/null; then
    wget -q --show-progress -O "$ZIP" "$URL"
  else
    die "curl or wget required to download SDK tools"
  fi

  info "Extracting..."
  unzip -q "$ZIP" -d "$ANDROID_SDK_DIR/cmdline-tools-tmp"
  rm -f "$ZIP"
  # Google zips unpack to "cmdline-tools/"; rename to "latest" as sdkmanager expects
  mkdir -p "$ANDROID_SDK_DIR/cmdline-tools"
  mv "$ANDROID_SDK_DIR/cmdline-tools-tmp/cmdline-tools" "$ANDROID_SDK_DIR/cmdline-tools/latest"
  rm -rf "$ANDROID_SDK_DIR/cmdline-tools-tmp"
  success "Command-line tools installed"
}

# Locate or set ANDROID_HOME
if [[ -z "${ANDROID_HOME:-}" ]]; then
  # Common install locations
  for candidate in \
      "$HOME/Library/Android/sdk" \
      "$HOME/Android/Sdk" \
      "/usr/local/lib/android/sdk" \
      "$ANDROID_SDK_DIR"; do
    if [[ -d "$candidate/cmdline-tools" || -d "$candidate/build-tools" ]]; then
      export ANDROID_HOME="$candidate"
      break
    fi
  done
fi

if [[ -z "${ANDROID_HOME:-}" ]]; then
  warn "ANDROID_HOME not set and no existing SDK found."
  echo -n "Download Android SDK command-line tools now? (~150 MB) [Y/n]: "
  read -r REPLY
  REPLY="${REPLY:-Y}"
  if [[ "$REPLY" =~ ^[Yy] ]]; then
    setup_android_sdk
    export ANDROID_HOME="$ANDROID_SDK_DIR"
  else
    die "Set ANDROID_HOME to your Android SDK root and re-run."
  fi
fi

export ANDROID_SDK_ROOT="$ANDROID_HOME"
info "ANDROID_HOME = $ANDROID_HOME"

# Locate sdkmanager
SDKMANAGER=""
for loc in \
    "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
    "$ANDROID_HOME/cmdline-tools/bin/sdkmanager" \
    "$ANDROID_HOME/tools/bin/sdkmanager"; do
  if [[ -x "$loc" ]]; then
    SDKMANAGER="$loc"
    break
  fi
done

if [[ -z "$SDKMANAGER" ]]; then
  warn "sdkmanager not found in existing SDK. Downloading command-line tools..."
  setup_android_sdk
  SDKMANAGER="$ANDROID_SDK_DIR/cmdline-tools/latest/bin/sdkmanager"
fi

# Add platform-tools to PATH
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

# ═══════════════════════════════════════════════════════════════════════════════
# 4 — Install required SDK packages
# ═══════════════════════════════════════════════════════════════════════════════
accept_licenses() {
  yes | "$SDKMANAGER" --licenses &>/dev/null || true
}

install_if_missing() {
  local pkg="$1"
  local check_path="$2"
  if [[ ! -d "$ANDROID_HOME/$check_path" ]]; then
    info "Installing SDK package: $pkg"
    accept_licenses
    "$SDKMANAGER" "$pkg"
    success "Installed $pkg"
  else
    success "SDK package present: $pkg"
  fi
}

install_if_missing "platform-tools"                            "platform-tools"
install_if_missing "platforms;$PLATFORM_VERSION"               "platforms/$PLATFORM_VERSION"
install_if_missing "build-tools;$BUILD_TOOLS_VERSION"          "build-tools/$BUILD_TOOLS_VERSION"

# ═══════════════════════════════════════════════════════════════════════════════
# 5 — npm install
# ═══════════════════════════════════════════════════════════════════════════════
info "Installing npm dependencies..."
npm install --silent
success "npm dependencies installed"

# ═══════════════════════════════════════════════════════════════════════════════
# 6 — Stage web assets into www/ (Capacitor webDir)
# ═══════════════════════════════════════════════════════════════════════════════
info "Staging web assets into www/ ..."
mkdir -p www
cp index.html app.js styles.css www/
success "Web assets staged"

# ═══════════════════════════════════════════════════════════════════════════════
# 7 — Capacitor: add android platform if missing, then sync
# ═══════════════════════════════════════════════════════════════════════════════
if [[ ! -d "android" ]]; then
  info "android/ not found — running npx cap add android ..."
  npx cap add android
  success "Android platform added"
fi
info "Syncing Capacitor web assets..."
npx cap sync android
success "Capacitor synced"

# ═══════════════════════════════════════════════════════════════════════════════
# 7 — Copy Java source files
# ═══════════════════════════════════════════════════════════════════════════════
info "Copying Java source files from android-src/ ..."
mkdir -p "$JAVA_PKG_DIR"
for f in android-src/*.java; do
  cp "$f" "$JAVA_PKG_DIR/"
  success "Copied $(basename "$f")"
done

# ═══════════════════════════════════════════════════════════════════════════════
# 8 — Patch AndroidManifest.xml
# ═══════════════════════════════════════════════════════════════════════════════
patch_manifest() {
  local manifest="$MANIFEST_FILE"
  info "Patching AndroidManifest.xml..."

  # ── permissions ──────────────────────────────────────────────────────────────
  local PERMS=(
    'android.permission.FOREGROUND_SERVICE'
    'android.permission.FOREGROUND_SERVICE_DATA_SYNC'
    'android.permission.POST_NOTIFICATIONS'
  )
  for perm in "${PERMS[@]}"; do
    if ! grep -q "$perm" "$manifest"; then
      # Insert before the closing </manifest> tag
      sed -i.bak "s|</manifest>|    <uses-permission android:name=\"$perm\" />\n</manifest>|" "$manifest"
      info "  Added permission: $perm"
    else
      info "  Permission already present: $perm"
    fi
  done

  # ── service ──────────────────────────────────────────────────────────────────
  if ! grep -q "TimerService" "$manifest"; then
    local SERVICE_BLOCK='        <service\n            android:name=".TimerService"\n            android:foregroundServiceType="dataSync"\n            android:exported="false" />'
    sed -i.bak "s|</application>|${SERVICE_BLOCK}\n    </application>|" "$manifest"
    info "  Added TimerService"
  else
    info "  TimerService already present"
  fi

  # ── receiver ─────────────────────────────────────────────────────────────────
  if ! grep -q "StopRateReceiver" "$manifest"; then
    local RECEIVER_BLOCK='        <receiver\n            android:name=".StopRateReceiver"\n            android:exported="false" />'
    sed -i.bak "s|</application>|${RECEIVER_BLOCK}\n    </application>|" "$manifest"
    info "  Added StopRateReceiver"
  else
    info "  StopRateReceiver already present"
  fi

  # clean up sed backups
  rm -f "${manifest}.bak"
  success "AndroidManifest.xml patched"
}

patch_manifest

# ═══════════════════════════════════════════════════════════════════════════════
# 9 — Gradle build
# ═══════════════════════════════════════════════════════════════════════════════
info "Building Android $BUILD_TYPE APK..."
cd android

if [[ "$BUILD_TYPE" == "release" ]]; then
  GRADLE_TASK="assembleRelease"
  APK_PATH="app/build/outputs/apk/release/app-release-unsigned.apk"
else
  GRADLE_TASK="assembleDebug"
  APK_PATH="app/build/outputs/apk/debug/app-debug.apk"
fi

chmod +x ./gradlew
./gradlew "$GRADLE_TASK" --no-daemon

cd "$SCRIPT_DIR"

if [[ -f "android/$APK_PATH" ]]; then
  success "APK built: android/$APK_PATH"
else
  die "Build task finished but APK not found at android/$APK_PATH"
fi

# Helper: locate adb
find_adb() {
  local adb="${ANDROID_HOME}/platform-tools/adb"
  if [[ ! -x "$adb" ]]; then
    command -v adb &>/dev/null && adb="adb" \
      || die "adb not found. Ensure platform-tools are installed."
  fi
  echo "$adb"
}

# Helper: check a device is connected
require_device() {
  local adb="$1"
  local count
  count=$("$adb" devices | grep -v "List of" | grep -c "device$" || true)
  if [[ "$count" -eq 0 ]]; then
    die "No Android device connected. Enable USB debugging and connect via USB."
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# 10 — Optional: adb install / push
# ═══════════════════════════════════════════════════════════════════════════════
if $INSTALL; then
  info "Installing APK on connected device via adb..."
  ADB=$(find_adb)
  require_device "$ADB"
  "$ADB" install -r "android/$APK_PATH"
  success "APK installed on device"
fi

if $PUSH; then
  # Copies the APK to the device's Downloads folder and triggers a MediaStore
  # rescan so it appears in the Files app immediately (no SFTP indexing lag).
  info "Pushing APK to device Downloads/ via adb..."
  ADB=$(find_adb)
  require_device "$ADB"
  APK_FILENAME=$(basename "$APK_PATH")
  DEVICE_PATH="/sdcard/Download/$APK_FILENAME"
  "$ADB" push "android/$APK_PATH" "$DEVICE_PATH"
  # Trigger MediaStore rescan.
  # Android 10+ ignores MEDIA_SCANNER_SCAN_FILE broadcasts; use content provider call instead.
  # Fall back to the old broadcast for older devices.
  ANDROID_VER=$("$ADB" shell getprop ro.build.version.sdk 2>/dev/null | tr -d '[:space:]') || ANDROID_VER=0
  if [[ "${ANDROID_VER:-0}" -ge 29 ]]; then
    "$ADB" shell content call \
      --uri content://media/external/file \
      --method scan_file \
      --arg "$DEVICE_PATH" &>/dev/null || true
  else
    "$ADB" shell am broadcast \
      -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
      -d "file://${DEVICE_PATH}" &>/dev/null || true
  fi
  success "APK pushed to $DEVICE_PATH — open your Files app → Downloads to install"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Build complete!${NC}"
echo -e "${GREEN}  APK: android/$APK_PATH${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if [[ "$BUILD_TYPE" == "release" ]]; then
  echo ""
  warn "Release APK is unsigned. To install on a device, sign it first:"
  echo "  keytool -genkey -v -keystore my-release-key.jks -alias alias_name -keyalg RSA -keysize 2048 -validity 10000"
  echo "  jarsigner -verbose -sigalg SHA256withRSA -digestalg SHA-256 -keystore my-release-key.jks android/$APK_PATH alias_name"
  echo "  zipalign -v 4 android/$APK_PATH android/app-release-signed.apk"
fi
