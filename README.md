Run from and data stored in andyhine@gmail.com Google Sheets and Cloud Console Google Sheets API access

Runs from https://twiz911.github.io/when_to_quit_chernovs_marginal_value_theorem/index.html


# Activity Tracker - Marginal Value Theorem

A mobile web app for tracking activities based on **Chernov's Marginal Value Theorem**. This app helps you decide when to quit an activity by comparing your last session's reward rate against your historical average.

## 🌟 Features

- **Google Sheets Integration**: All data stored in your own Google Sheets
- **Quick Activity Management**: Easily add new activities
- **Timer Functionality**: Start/stop timer to track sessions
- **Manual Entry**: Enter time manually (rounded to nearest 15 minutes)
- **Reward Rating**: Rate each session from 0-10
- **Smart Analytics**: Calculates average reward per hour and warns you when to switch activities
- **Mobile-Optimized**: Designed for use on smartphones

## 🚀 Quick Start

```bash
# Start a local server
python3 -m http.server 8000

# Open in browser
http://localhost:8000
```

The app will guide you through setup on first launch.









# Android App Capacitor Setup

## Prerequisites
- Node.js ≥ 18
- Java 17
- Internet access (first run downloads the Android SDK command-line tools automatically — no Android Studio required)

---

## Quick Build (no Android Studio needed)

`build-android.sh` handles everything: SDK download, dependency install, source copy,
manifest patching, and Gradle build.

```bash
# Debug APK (default)
./build-android.sh

# Release APK (unsigned)
./build-android.sh --release

# Debug APK + install directly (requires USB debugging enabled)
./build-android.sh --install

# Debug APK + copy to device Downloads/ via adb and trigger media scan
# (file appears in Files app immediately — no SFTP indexing lag)
./build-android.sh --push
```

The finished APK is written to:
- **Debug**: `android/app/build/outputs/apk/debug/app-debug.apk`
- **Release**: `android/app/build/outputs/apk/release/app-release-unsigned.apk`

### What the script does

| Step | Action |
|---|---|
| 1 | Checks Java 17 and Node.js 18 are available |
| 2 | Locates or downloads the Android SDK command-line tools into `.android-sdk/` |
| 3 | Installs `platform-tools`, `platforms;android-34`, and `build-tools;34.0.0` via `sdkmanager` |
| 4 | Runs `npm install` |
| 5 | Runs `npx cap add android` if `android/` doesn't exist, then `npx cap sync android` |
| 6 | Copies all `.java` files from `android-src/` into the package directory |
| 7 | Patches `AndroidManifest.xml` with the required permissions, service, and receiver |
| 8 | Runs `./gradlew assembleDebug` (or `assembleRelease`) |
| 9 | Optionally installs the APK via `adb` (`--install` flag) |

### Signing a release APK

The `--release` build produces an **unsigned** APK. To sign it for distribution:

```bash
# 1. Generate a keystore (once)
keytool -genkey -v -keystore my-release-key.jks \
  -alias alias_name -keyalg RSA -keysize 2048 -validity 10000

# 2. Sign
jarsigner -verbose -sigalg SHA256withRSA -digestalg SHA-256 \
  -keystore my-release-key.jks \
  android/app/build/outputs/apk/release/app-release-unsigned.apk alias_name

# 3. Align
zipalign -v 4 \
  android/app/build/outputs/apk/release/app-release-unsigned.apk \
  android/app-release-signed.apk
```

---

## Manual Steps (if you prefer Android Studio)

<details>
<summary>Expand manual setup instructions</summary>

### 1 — Install dependencies

```bash
npm install
```

### 2 — Add the Android platform

```bash
npx cap add android
```

### 3 — Sync web assets

```bash
npx cap sync android
```

### 4 — Copy source files

Copy all `.java` files from `android-src/` into the generated package directory:

```
android/app/src/main/java/com/whentoquit/app/
```

Replace the generated `MainActivity.java` with the one from `android-src/`.

### 5 — Update AndroidManifest.xml

Open `android/app/src/main/AndroidManifest.xml` and apply the additions from
`android-src/manifest_additions.xml`:

- Add the three `<uses-permission>` lines inside `<manifest>`
- Add the `<service>` and `<receiver>` blocks inside `<application>`

### 6 — Open in Android Studio and run

```bash
npx cap open android
```

Then Build → Run on your device or emulator.

</details>

---

## How Android App works

| Component | Role |
|---|---|
| `TimerPlugin.java` | Capacitor bridge — JS calls `startService`, `stopService`, `syncActivities`, `getIntentAction` |
| `TimerService.java` | Android foreground service — shows persistent notification with live timer and **Stop & Rate** action button |
| `StopRateReceiver.java` | Receives the notification button tap, stops the service, reopens the app with `STOP_AND_RATE` intent |
| `MainActivity.java` | Registers the plugin; forwards `onNewIntent` so resumed-app flows work too |

## User flow

1. User starts timer in app → `TimerPlugin.startService()` called → persistent notification appears
2. User taps **Stop & Rate** in notification → `StopRateReceiver` fires → app opens to **quick-rate modal**
3. Modal shows elapsed time + 1-10 rating slider + list of other activities to start next
4. User rates and optionally starts the next activity → session saved to Google Sheets, new timer starts














## 🔧 Configuration

### Using the Same Spreadsheet Across Domains

By default, each domain (localhost, GitHub Pages, etc.) creates its own spreadsheet. To use the **same spreadsheet** across all domains:

1. Run the app once to create a spreadsheet
2. Open the spreadsheet in Google Sheets
3. Copy the spreadsheet ID from the URL:
   ```
   https://docs.google.com/spreadsheets/d/YOUR_SPREADSHEET_ID_HERE/edit
   ```
4. Edit `app.js` and set:
   ```javascript
   const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID_HERE';
   ```
5. Save and reload the app

Now localhost and GitHub Pages will share the same data!

## 📖 About the Marginal Value Theorem

The **Marginal Value Theorem** (Charnov, 1976) suggests that an organism should leave a patch when the rate of energy intake drops below the average rate for the habitat. 

Applied to activities: when your reward rate drops below your historical average, it's time to switch to something else to maximize overall productivity and satisfaction.

---

**Track your activities and optimize your time! 🚀**
