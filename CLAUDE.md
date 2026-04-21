# YouCoded

This repo contains the YouCoded app — two platforms side by side:

- `desktop/` — Electron + React desktop app. See `desktop/CLAUDE.md` for architecture.
- `app/` — Android Kotlin app. See `.claude/rules/android-runtime.md` (auto-loaded for `app/**` edits) and `docs/android-runtime.md` in the `youcoded-dev` workspace scaffold for runtime constraints.

**The React UI is shared.** Android's WebView loads the same React bundle built from `desktop/src/renderer/` via `scripts/build-web-ui.sh`. Run that script before every Android APK build or the app launches with a blank WebView.

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
- **Android iteration:** `./scripts/build-web-ui.sh && ./gradlew assembleDebug` from this repo.
- **Release:** Bump `app/build.gradle.kts` (`versionCode` + `versionName`) and tag `vX.Y.Z`. One tag triggers both platform workflows.

## Workspace scaffold

Day-to-day development happens in the `youcoded-dev` workspace repo, which clones this repo alongside `youcoded-core` (the toolkit), `wecoded-themes`, and `wecoded-marketplace`. The workspace root has the cross-cutting docs (`docs/PITFALLS.md`, `docs/android-runtime.md`, `docs/chat-reducer.md`, etc.) and the `/audit` command for doc/code drift detection.
