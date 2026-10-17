# YouCoded

This repo contains the YouCoded app — two platforms side by side:

- `desktop/` — Electron + React desktop app. See `desktop/CLAUDE.md` for architecture.
- `app/` — Android app: a thin Kotlin shell around the desktop backend, plus `app/runtime/` (the bundled programs). See `docs/android-runtime.md` (in this repo); the `youcoded-dev` workspace's path-scoped rules auto-load for `app/**` edits when working from the workspace.

## Workspace conventions (read this if you opened this repo standalone)

This repo is one component of the YouCoded product. Development is coordinated from the **youcoded-dev workspace repo**: https://github.com/itsdestin/youcoded-dev — if it isn't on this machine, clone it and run `bash setup.sh` (it clones every sub-repo and carries the working rules, path-scoped rules, and cross-repo docs).

- **Lifecycle documents** (specs, plans, handoffs, investigations) do NOT live in this repo — they go to the workspace: `youcoded-dev/docs/active/` (in flight) → `youcoded-dev/docs/archive/` (done). Don't create `docs/plans/`, `docs/specs/`, or `docs/superpowers/` trees here.
- **Planning** happens in the workspace's work items — one file per piece of work in `youcoded-dev/cards/` (`node scripts/cards.mjs index` lists them; the idea-intake skill files new ones; the roadmap was retired 2026-10-15). Capture future work there, not in per-repo TODO files.
- This repo's `docs/` holds **living reference only** (subsystem depth docs, `cc-dependencies.md`, etc.).

**The React UI is shared.** Android's WebView loads the same React bundle built from `desktop/src/renderer/` via `scripts/build-web-ui.sh`. The `app/build.gradle.kts` `bundleWebUi` task auto-runs the script before every APK build with input/output tracking, so a stale or missing bundle can no longer ship a blank-WebView APK. Run the script manually only when iterating outside Gradle.

**Android runs the desktop backend.** Since the 2026-10-14 clean rebuild the Android app starts `desktop/src/main/headless/headless-main.ts` in a bundled Node and its WebView talks to it like a remote browser (local mode, owner rules); the Kotlin in `app/` is a thin shell. Features are built once, in the desktop. See `docs/android-runtime.md`.

## Cross-platform protocol parity

The app exposes a single IPC surface (`window.claude`) that both Electron and the Android WebView consume. Invariants:

- `desktop/src/main/preload.ts` and `desktop/src/renderer/remote-shim.ts` must expose the same shared shape, with intentional exceptions: `window.claude.window` (Electron-only window controls) and `window.claude.android` (Android-only APIs).
- Message type strings must be identical across `backend-contract.ts`, `preload.ts` and `remote-shim.ts`. The phone's only own list is `HostJsBridge.TYPES` (guard `desktop/tests/android-host-channels.test.ts`).
- If you add CC-coupled code, add an entry to `docs/cc-dependencies.md` so the `review-cc-changes` release agent can map upstream CLI changes to the affected touchpoints.

Full context on architectural invariants lives in `docs/PITFALLS.md` in the `youcoded-dev` workspace scaffold. Read that before making non-trivial changes.

## Build and release

See `docs/build-and-release.md` in the workspace scaffold. Shortest path:
- **Desktop iteration:** `bash scripts/run-dev.sh` from the workspace root.
- **Android iteration:** `./gradlew assembleDebug` from this repo (needs clang + lld). `bundleWebUi`, `buildBackend` and `buildRuntimeDebug` run automatically and are skipped as UP-TO-DATE when their inputs did not change.
- **Release:** tag `vX.Y.Z`. One tag triggers both platform workflows; `android-release.yml` stamps `versionName` from the tag and `versionCode` from its run number (since 2026-09-10), so the hand-set values in `app/build.gradle.kts` only matter for local builds.

## Workspace scaffold

Day-to-day development happens in the `youcoded-dev` workspace repo, which clones this repo alongside `youcoded-core` (the toolkit), `wecoded-themes`, and `wecoded-marketplace`. The workspace root has the cross-cutting docs (`docs/PITFALLS.md`, `docs/android-runtime.md`, `docs/chat-reducer.md`, etc.) and the `/audit` command for doc/code drift detection.
