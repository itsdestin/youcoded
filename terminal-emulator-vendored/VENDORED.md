# Vendored Termux terminal-emulator

This module is a vendored copy of Termux's `terminal-emulator` Android library, patched to add a `RawByteListener` hook on `TerminalEmulator.append()`.

## Origin

- Upstream: https://github.com/termux/termux-app
- Tag: `v0.118.1`
- Path: `terminal-emulator/`
- Vendored on: 2026-04-24

## License

Apache License 2.0. See `LICENSE` and `NOTICE` in this directory for the full text and copyright notices. Termux's `LICENSE.md` at the repo root explicitly carves out the `terminal-emulator/` subdirectory as Apache 2.0 (separate from the GPLv3 used by the rest of Termux). The upstream chain is jackpal/Android-Terminal-Emulator (Apache 2.0) → Termux modifications (Apache 2.0) → YouCoded `RawByteListener` patch (this module). Preserve `LICENSE`, `NOTICE`, and `// YOUCODED PATCH` markers when re-vendoring.

## Why vendored

Termux's `TerminalEmulator` owns the ANSI parse loop but exposes no pre-parse byte listener. We need raw bytes to flow to a secondary consumer (a future xterm.js renderer over WebSocket) in parallel with the existing native `TerminalView` display.

Subclassing doesn't work: `mEmulator` is package-private on `TerminalSession`, and `processByte` / `processCodePoint` are private. The cleanest tap point is overriding `append(byte[], int)` directly — but the only way to install an override is to patch the class or replace it in a package-private field via reflection. Vendoring is less fragile than reflection drift.

## The patch

Three additions to `src/main/java/com/termux/terminal/TerminalEmulator.java`, all marked with `// YOUCODED PATCH` comments:

1. Public `RawByteListener` interface with `onBytesReceived(byte[] buffer, int length)`.
2. `addRawByteListener(...)` / `removeRawByteListener(...)` methods backed by a `CopyOnWriteArrayList`. `addRawByteListener` rejects null listeners with `IllegalArgumentException`.
3. A listener-notify loop at the very start of `append(byte[] buffer, int length)`, before the existing per-byte processing. Each listener call is wrapped in an individual try/catch so a misbehaving listener cannot abort the emulator parse.

No other Termux file is modified. No JNI changes.

## Build system note

Upstream uses `ndkBuild` with `Android.mk` (NOT cmake / CMakeLists.txt). The vendored module's `build.gradle.kts` uses `externalNativeBuild { ndkBuild { path = file("src/main/jni/Android.mk") } }` with ABI filters and cFlags copied verbatim from upstream's `build.gradle`. When re-vendoring, re-check these in case upstream changes flags.

## Re-vendor procedure

When bumping to a newer Termux version:

1. Shallow-clone at the new tag: `git clone --depth 1 --branch <tag> https://github.com/termux/termux-app.git /tmp/termux-<tag>`
2. Back up the patched `TerminalEmulator.java` (copy it somewhere).
3. Replace `src/main/java/com/termux/terminal/` and `src/main/jni/` with the new tag's contents:
   ```bash
   cp -r /tmp/termux-<tag>/terminal-emulator/src/main/java/com terminal-emulator-vendored/src/main/java/
   cp -r /tmp/termux-<tag>/terminal-emulator/src/main/jni/. terminal-emulator-vendored/src/main/jni/
   ```
4. Re-apply the three `// YOUCODED PATCH` additions to the new `TerminalEmulator.java`. Use `git grep "YOUCODED PATCH"` against the previous patched copy as the reference. Search for the `append(byte[], int)` method by signature, NOT by line number — line numbers drift across releases.
5. Re-check upstream's `terminal-emulator/build.gradle` for cFlag or ABI filter changes. Mirror any changes into the vendored `build.gradle.kts`.
6. Run `./gradlew :app:testDebugUnitTest --tests "com.youcoded.app.runtime.RawByteListenerTest"` — both tests must pass.
7. Run `./gradlew :app:assembleDebug` — the APK must build.
8. Update "Vendored on" and "Tag" fields at the top of this file.

## JitPack NDK version note

Upstream's Gradle build reads `System.getenv("JITPACK_NDK_VERSION")` to pin NDK version when built by JitPack CI. We don't replicate this — we build locally and inherit the host NDK version. If ABI-level regressions ever appear after a re-vendor, check whether JitPack's NDK version for the corresponding Termux release would produce a different `.so`.

## Invariant

This module is never edited outside the documented patch. If a future change needs more than "add one listener and call it from append()", stop and reconsider — either upstream a proper `RawByteListener` API to Termux, or split the new concern into a separate change with its own documentation.
