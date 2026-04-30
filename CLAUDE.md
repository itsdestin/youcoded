# YouCoded

This repo contains the YouCoded app — two platforms side by side:

- `desktop/` — Electron + React desktop app. See `desktop/CLAUDE.md` for architecture.
- `app/` — Android Kotlin app. See `.claude/rules/android-runtime.md` (auto-loaded for `app/**` edits) and `docs/android-runtime.md` in the `youcoded-dev` workspace scaffold for runtime constraints.

**The React UI is shared.** Android's WebView loads the same React bundle built from `desktop/src/renderer/` via `scripts/build-web-ui.sh`. The `app/build.gradle.kts` `bundleWebUi` task auto-runs the script before every APK build with input/output tracking, so a stale or missing bundle can no longer ship a blank-WebView APK. Run the script manually only when iterating outside Gradle.

**Android's terminal is also rendered by the shared React UI.** As of Tier 2, xterm.js running in the WebView is the sole Android terminal renderer — the native Termux `TerminalView` Compose block was removed. The vendored `terminal-emulator-vendored/` module owns the PTY + emulator and exposes raw bytes via the `pty:raw-bytes` WebSocket push event (base64-encoded); the WebView's xterm is display-only on touch (typing flows through the React `InputBar`, not xterm's hidden textarea). See `docs/android-runtime.md` → "Terminal rendering (Tier 2)" and `terminal-emulator-vendored/VENDORED.md` for details.

## Cross-platform protocol parity

The app exposes a single IPC surface (`window.claude`) that both Electron and the Android WebView consume. Invariants:

- `desktop/src/main/preload.ts` and `desktop/src/renderer/remote-shim.ts` must expose the same shared shape, with intentional exceptions: `window.claude.window` (Electron-only window controls) and `window.claude.android` (Android-only APIs).
- Message type strings must be identical across `preload.ts`, `src/main/ipc-handlers.ts`, and `app/src/main/kotlin/.../runtime/SessionService.kt`.
- Desktop handlers return raw values; Android wraps in JSONObject. The shim normalizes.
- If you add CC-coupled code, add an entry to `docs/cc-dependencies.md` so the `review-cc-changes` release agent can map upstream CLI changes to the affected touchpoints.

Full context on architectural invariants lives in `docs/PITFALLS.md` in the `youcoded-dev` workspace scaffold. Read that before making non-trivial changes.

## Build and release

See `docs/build-and-release.md` in the workspace scaffold. Shortest path:
- **Desktop iteration:** `bash scripts/run-dev.sh` from the workspace root.
- **Android iteration:** `./gradlew assembleDebug` from this repo. The `bundleWebUi` Gradle task runs `scripts/build-web-ui.sh` automatically when `desktop/src/` changes; subsequent Kotlin-only iterations skip it as UP-TO-DATE.
- **Release:** Bump `app/build.gradle.kts` (`versionCode` + `versionName`) and tag `vX.Y.Z`. One tag triggers both platform workflows.

## Workspace scaffold

Day-to-day development happens in the `youcoded-dev` workspace repo, which clones this repo alongside `youcoded-core` (the toolkit), `wecoded-themes`, and `wecoded-marketplace`. The workspace root has the cross-cutting docs (`docs/PITFALLS.md`, `docs/android-runtime.md`, `docs/chat-reducer.md`, etc.) and the `/audit` command for doc/code drift detection.
