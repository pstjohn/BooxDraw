# BooxDraw

![BooxDraw logo](public/booxdraw.png)

BooxDraw is a fork of AndroidDraw/Excalidraw optimized for Boox and other e-ink Android tablets. It keeps Excalidraw's collaborative whiteboard model, but changes the Android wrapper and mobile UI so stylus drawing feels usable on low-refresh e-ink screens.

The main goal is simple: draw with the Boox stylus using the device's native low-latency ink path, then convert those strokes into real Excalidraw elements that sync to a desktop browser through Excalidraw's live collaboration rooms.

## What This App Does

- Runs Excalidraw inside a Capacitor Android app.
- Uses the Boox/Onyx native handwriting layer for immediate stylus feedback.
- Converts native stylus strokes into Excalidraw freedraw elements after a short idle delay.
- Keeps Excalidraw live collaboration active, so tablet strokes appear in a desktop browser.
- Supports finger gestures for normal Excalidraw interactions while keeping finger touches from drawing stray lines.
- Provides a short room-code flow for joining tablet-created rooms from desktop without typing long `#room=...` URLs.

## Main Changes In This Fork

- Added an Onyx pen bridge in Android using `TouchHelper`, a transparent WebView, and a native drawing `SurfaceView`.
- Added a TypeScript bridge that converts native pen payloads into Excalidraw freedraw elements.
- Tuned pen behavior for e-ink: thinner strokes, less pressure variability for thin lines, delayed conversion while writing, and native eraser support.
- Changed mobile tool popovers so stylus taps can open settings, dismiss them by tapping the canvas, and interact with toolbar controls.
- Prevented finger touches from drawing while preserving finger gestures for selecting, panning, and zooming.
- Added regional e-ink repaint calls after native ink is replaced by Excalidraw-rendered strokes.
- Added deterministic 10-character room codes:
  - Tablet creates a new room from a generated code and today's date.
  - Desktop opens `https://pcstj.com/BooxDraw/`, enters the code, and is redirected to the matching Excalidraw live room.
  - No backend stores room URLs; both sides derive the same room id/key locally.
- Added a tablet workflow to reset the canvas and generate a fresh coded room.

## Room Code Workflow

1. Open the collaboration/share dialog on the tablet.
2. Tap `Start with desktop code` to create a live room with a short code.
3. On desktop, open `https://pcstj.com/BooxDraw/`.
4. Enter the code shown on the tablet.
5. The desktop browser joins the same Excalidraw live room.

To start over on the tablet, open the active collaboration dialog and tap `Reset canvas + new code`.

Room codes are convenient, not high-security. The code and current date determine the Excalidraw room key, so anyone with the code on the same day can derive the room URL.

## Building For Android

Install dependencies:

```bash
npm install
```

Build the web app:

```bash
npm run build
```

Sync Capacitor:

```bash
npx cap sync android
```

Build the debug APK:

```bash
cd android
./gradlew assembleDebug
```

Install on a connected device:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## GitHub Pages Resolver

The static room-code resolver lives in `docs/` and is intended to be served by GitHub Pages from the `boox` branch:

```text
Settings -> Pages -> Deploy from branch -> boox -> /docs
```

## Credits

BooxDraw is built on:

- [Excalidraw](https://github.com/excalidraw/excalidraw)
- [AndroidDraw](https://github.com/NicolasPauferro/AndroidDraw)
- Capacitor for the Android wrapper
- Boox/Onyx handwriting APIs for low-latency stylus preview

Excalidraw is released under the MIT license.
