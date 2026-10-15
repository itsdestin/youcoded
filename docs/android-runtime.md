# Android runtime

How the Android app runs YouCoded. Since the 2026-10-14 clean rebuild the phone runs **the desktop's own
backend**, headless, in a Node process inside the app; the Kotlin code is a thin shell. Plan and the
on-phone proof: `youcoded-dev/docs/active/plans/2026-10-14-android-clean-rebuild-plan.md`.

## Shape

```
Android app (one APK)
├─ Kotlin shell  app/src/main/kotlin/com/youcoded/app/
│   MainActivity        the one screen: "starting…", then the WebView; QR scanner, mic prompt, file picker, back
│   ui/AppWebView        WebView on file:///android_asset/web/index.html?bridgeToken=…&bridgePort=…
│   bridge/HostJsBridge  window.YouCodedHost: the page's phone-only calls (voice, saved computers, QR, back, version)
│   runtime/BackendService  foreground service: lays out programs, starts/restarts node, resolv.conf, wake lock
│   runtime/RuntimeInstaller files/usr symlinks into the native-lib folder; unpacks backend.tgz
│   runtime/HostSocketServer the backend's calls to the phone (open a link, keep awake, notify)
├─ WebView: the shared React page, remote-shim in "android-local" mode → ws://localhost:<port>, token sign-in
└─ node desktop/dist/main/headless/headless-main.js  (the desktop backend, Electron replaced by a stand-in)
    └─ node-pty → Claude Code 2.1.x (official musl build), bash, git, rg — all bundled
```

- **The backend** is `desktop/src/main/headless/`: `headless-main.ts` points `require('electron')` at
  `electron-headless.ts` (paths from the environment, links/keep-awake over the host socket, secrets sealed
  with a key the app keeps in the Android Keystore, "no windows" for window APIs), then `headless-boot.ts`
  builds main.ts's backend half. Keep it in step with `main.ts` when a service a phone should have is added there.
- **The socket door** runs in local mode (`remote-local.ts`): loopback only, no Tailscale or password, one
  per-run token. That client is the backend's **owner**: the channel table treats it like a window
  (`serveRemoteChannel(..., { owner: true })` — `desktopOnly`, `remoteAllowed:false` and folder gates do not
  refuse it). Capability gating of desktop-only features on the phone is P4 of the plan.
- **Phone-only calls** never go over the socket: `invokeAndroidHost` (`desktop/src/renderer/android-local-bridge.ts`)
  ↔ `HostJsBridge.kt`. The two lists are pinned equal by `desktop/tests/android-host-channels.test.ts`.

## Bundled programs (`app/runtime/`)

`build-runtime.sh <applicationId> <out>` (Gradle `buildRuntime<Variant>`) assembles them from pinned
sources (`pins.env`): Alpine Linux **musl** packages (Node, bash, git, ripgrep), musl built from source with
`patch-musl.py`, `ycshim.c`, `yc-open.c`, node-pty cross-built, and Claude Code's official
`linux-arm64-musl` package. `build-backend.sh` (Gradle `buildBackend`) packs the desktop backend
(`backend.tgz`, production dependencies, other platforms' native builds removed).

**What Android forbids, and the answer to each** (all seen on a Galaxy Z Flip7, Android 17):

| Android rule | Answer |
|---|---|
| An app may only execute files Android unpacked into its native-library folder | Every program ships as `jniLibs/arm64-v8a/lib<name>.so` (`useLegacyPackaging`); `files/usr/bin/<name>` are symlinks to them |
| No `/lib/ld-musl-aarch64.so.1` | Each program's interpreter is rewritten (patchelf) to `/data/data/<appId>/files/usr/lib/ld-musl-aarch64.so.1`, a symlink to the bundled musl; RUNPATH `files/usr/lib`. The path names the package, so each variant (`.dev`, `.releasetest`) has its own build |
| App seccomp kills `io_uring_setup` (libuv probes it; `UV_USE_IO_URING=0` does not help) | `ycshim.c` (linked first into every program) answers ENOSYS |
| No exec of files in the app's data folder (`#!` scripts) | The shim runs the script's interpreter instead (execve/execv/execvp/execvpe) |
| No `/bin/sh`, `/usr/bin/env`, `/etc/resolv.conf`, `/etc/ssl` | Shim maps missing `/bin/*`, `/usr/bin/*` to PATH and `/etc/x` to `$YOUCODED_ETC/x`; musl reads `$YOUCODED_ETC/resolv.conf` (patch-musl.py); `BackendService` writes it from the active network; `SSL_CERT_FILE`/`GIT_SSL_CAINFO` name the bundled CA file |
| No `xdg-open` | `yc-open.c` is `usr/bin/xdg-open` and `BROWSER`: asks the app to open the link (a notification when the app is off screen — Android blocks background activity starts) |
| Background apps are frozen | `BackendService` is a `specialUse` foreground service; keep-awake requests take a capped partial wake lock |

Claude Code ships **unmodified** — Anthropic's terms for offering it in a product say "the Claude Code binary must
not be modified" (code.claude.com/docs/en/legal-and-compliance). `claude-launch.c` (usr/bin/claude) runs it
through the bundled loader instead of rewriting its header, and it gets no shim; its hooks and tools ran without one.
Users sign in through Claude Code's own flow with their own account (the terms forbid paying for or intermediating
their usage). Its self-updater is off (`DISABLE_AUTOUPDATER=1`): a new Claude
Code reaches the phone with an app release (bump `CLAUDE_CODE_VERSION` in `pins.env`).

## On-device layout (`files/` = the app's files folder)

`usr/{bin,lib,libexec/git-core,share,etc}` · `backend/` (unpacked backend.tgz; `node_modules/node-pty/build/Release/pty.node`
is copied from the native-lib folder) · `home/` (HOME: `~/.claude`, conversations) · `userdata/` (the
backend's userData; `backend.log` is the backend's console) · `tmp/` (TMPDIR). `RuntimeInstaller` rebuilds the
links whenever the app version or the native-lib folder changes.

## Developing

- Build: `JAVA_HOME=<JDK 21> ANDROID_HOME=$HOME/.android-sdk ./gradlew :app:assembleDebug` (needs clang + lld,
  python3, curl; downloads are cached in `app/build/runtime-cache`). Debug installs as **YouCoded Dev**
  (`com.youcoded.app.dev`, port 9951) beside the real app.
- Backend logs: `adb shell run-as com.youcoded.app.dev cat files/userdata/backend.log`.
- Fast backend iteration without a rebuild: compile the desktop (`npx tsc`), push `dist/` into
  `files/backend` with `run-as`, and kill the `node` process (the service restarts it).
- The page can be driven from a laptop browser: `adb forward tcp:9951 tcp:9951`, read the token from the
  node process's environment (`run-as … /proc/<pid>/environ`), open `app/src/main/assets/web/index.html?bridgeToken=…&bridgePort=9951`
  from file://.
