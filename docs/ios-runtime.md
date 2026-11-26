# iPhone runtime

How the iPhone app runs YouCoded. It is the Android app's design carried to a second phone system: the phone
runs **the desktop's own backend**, headless, and shows **the desktop's own page**; the Swift code is a thin
shell. Read [Android runtime](android-runtime.md) first — this page is mostly the differences.

Status: built on `session/89-iphone-app` (card #89). Started for real in an iPhone simulator by CI
(`.github/workflows/ios-ci.yml`); not yet run on a physical iPhone.

## Shape

```
iPhone app (one .app)
├─ Swift shell  ios/YouCoded/
│   AppDelegate / RootViewController  the one screen: "starting…", then the page; or "couldn't start"
│   BackendRunner       starts Node IN THIS PROCESS (nodejs-mobile), hands it its keys, watches for "ready"
│   AppWebView          WKWebView on youcoded-app://app/index.html?bridgeToken=…&bridgePort=… (files served by a
│                       WKURLSchemeHandler from the app bundle; theme-asset:// served the same way)
│   HostJsBridge        window.YouCodedHost: the page's phone-only calls (voice, saved computers, QR, attach, version)
│   HostSocketServer    the backend's calls to the phone (open a link, keep awake, notify, status)
│   UrlPolicy           which links load / download / leave the app; the Tailscale-only rule for plain http
│   VoiceRecognizer, QrScannerViewController, Notifier, AttachmentStore, SecretKeyStore, SignInLinks
├─ WKWebView: the shared React page, remote-shim in "android-local" mode → ws://localhost:<port>, token sign-in
└─ Node 18 (nodejs-mobile, a library): backend/dist/main/headless/ios-main.js — the desktop backend as ONE bundle
```

## What iOS forbids, and the answer to each

| iOS rule | Answer |
|---|---|
| An app may not start any other program (no fork/exec at all) | Node runs as a library inside the app (`node_start` on its own thread, `BackendRunner.swift`). Everything that IS "start a program" does not exist on an iPhone: Claude Code, the terminal, git, shell commands, ripgrep, local models. One question answers it everywhere: `canRunPrograms()` (backend, `headless/host-bridge.ts`) and `capabilities.programs` (page, `shared/capabilities.ts`). |
| No runtime code generation (no JIT) | nodejs-mobile is built with V8's JIT off. A JIT-less V8 has **no WebAssembly**, so Node 18's built-in `fetch` cannot work (its HTTP parser is WebAssembly): `headless/ios-fetch.ts` is `fetch` rebuilt on `http`/`https`. |
| The only Node for iOS is nodejs-mobile's Node 18, built without ICU | `headless/ios-compat.ts` fills what the backend uses and Node 18 lacks (`globalThis.crypto`, `File`, `AbortSignal.any`, `toSorted`, `Object.groupBy`, …). No ICU means V8 rejects `\p{…}` in regular expressions, so the build bakes the needed Unicode tables in (below). |
| Node 18 cannot `require()` an ES module; an app is a signed, read-only bundle | The backend ships as one esbuild bundle per entry (`ios/runtime/build-backend.mjs`), not Android's tree of ~17,000 files. |
| Node can be started once per process, and `exit()` ends the whole app | No "restart the backend": a stopped backend shows "close and reopen YouCoded". `process.exit` is replaced inside the app (`installInProcessGuards`): it prints `YOUCODED_HEADLESS_EXIT`, which the shell shows as that screen, and holds the thread. |
| An app may only write inside Documents, Library and tmp | `HOME` is the app's Documents folder (also what the Files app shows as "On My iPhone › YouCoded"); `userData` is under Application Support. `AppPaths.swift`. |
| No abstract sockets; a socket file's path must fit 104 bytes | The backend calls the app over a loopback TCP port (`YOUCODED_HOST_SOCKET=tcp:<port>`), opening with a per-run token (`YOUCODED_HOST_TOKEN`), because other apps can reach loopback ports. |
| A page can only be served from the app through a private scheme | `youcoded-app://app/…` (`IOS_PAGE_ORIGIN` in `shared/android-page-origin.ts`; must match `AppWebView.swift`). The backend's origin check allows it (`remote-origin.ts`). |
| Background apps are suspended within seconds | The big one, and only partly answered — see "Background" below. |
| Unsigned apps cannot use the Keychain | Even simulator builds are signed "to run locally" (identity `-`); see the workflow. |

## The page thinks it is "the phone app"

`renderer/android-page.ts` → `isAndroidAppPage()` answers true on the iPhone page too, so `__PLATFORM__` is
`'android'` there and every look-and-feel rule written for the Android app applies. That name means "the phone
app's own page"; it was kept because renaming ~40 call sites would collide with every branch in flight. The few
real differences ask `phoneOs()` (same file) or `capabilities.programs`.

The page's phone-only calls keep their `android:*` message names for the same reason; the iPhone shell answers
the same list (`HostJsBridge.types`), pinned against the page and against Android's by `desktop/tests/ios-shell.test.ts`.

## What an iPhone cannot do (and what shows instead)

- **Claude Code sessions, and so a Claude plan.** `claude-code:status` answers `not-possible`; the model menu
  greys Claude models with "Needs a computer", the Claude card says where it does work, and setup leaves out
  "Log in with Claude". A Claude plan is used from the phone by connecting to a computer (remote access today,
  the Mesh later).
- **The shell tools** (`Bash`, `BashOutput`, `KillShell`) are not offered to a model (`deviceTools()`), and the
  prompt's environment block says the device cannot run commands.
- **Grep** works: where ripgrep cannot be started the same search runs in-process and prints ripgrep's own
  output format (`harness/tools/in-process-search.ts`), so there is one Grep tool.
- **Marketplace installs** work without git: `plugin-installer.ts` → `runGit` is answered from GitHub's commit
  archives (`main/git-snapshot.ts`) where no program can run. It trusts GitHub over TLS to serve the commit asked
  for (and checks the commit id written in the archive) where git verifies every object itself.
- **Git, the terminal view, the Files-tab content search, local models, the built-in Browser, Office, the buddy.**
  Off through `IOS_LOCAL_CAPABILITIES`. GitHub-based sync does not run (no git); the Mesh is the phone's sync.
- **App updates.** Only Apple updates an iPhone app; `getUpdateStatus()` never reports one there.

## Background

iOS suspends an app shortly after it leaves the screen: the Node thread stops, sockets die, a reply in progress
is cut off. What the shell does today:

- While the assistant is working (the backend's `keepAwake`), the screen does not dim and lock.
- If the person leaves the app anyway, the shell asks iOS for its short grace period (about 30 seconds).
- "Needs you" alerts and the icon badge are shown from the backend's `status` call, but only while the app is
  still running; nothing can wake a suspended app without a push service, which YouCoded does not have.

- **Coming back.** iOS can take a suspended app's listening sockets away, so on return the shell reopens its own
  listener on the same port (`HostSocketServer.reopenIfNeeded`), tells the backend the app is visible, and the
  backend knocks on its own door and reopens it if nobody answers (`RemoteServer.reviveLocalListener`); the page
  reconnects by itself. If the backend still cannot be reached after a few tries the shell says so ("iOS paused
  YouCoded for too long…"). None of this can be reproduced in a simulator: it is the first thing to try on a phone.

So an iPhone is a device you use, not one that works on its own: scheduled automations run only while the app
is open (missed runs are handled by each job's own setting when it next opens), and a phone hosting a Mesh chat
can only do so in the foreground. Running on a computer that is on — reached through the Mesh — is the answer
for anything long.

## The backend bundle (`ios/runtime/build-backend.mjs`)

- The app starts `dist/main/headless/ios-boot.js`, a few lines the build writes that load the real bundle inside a
  `try`. If the phone's V8 could not even parse the bundle, nothing in it would run — including the exit guard — and
  Node's own reaction (exit) would close the app without a word; the loader turns that into the failed screen.
- `undici` is aliased to `headless/ios-undici.ts` (the `Agent` + `fetch` pair `net-guard` uses, on `ios-fetch`).
- One bundle per entry: the backend (`headless/ios-main.ts`) and each worker thread (`WORKER_ENTRIES`), laid out
  where Android's compiled tree would have them, so path lookups agree. Each source file's `__dirname` /
  `__filename` is rewritten to its compiled-tree path.
- `electron` is aliased to `headless/electron-headless.ts` at build time (Android does it with a runtime hook).
- `headless/ios-prelude.ts` is injected into every bundle so the fills run before any module.
- **Unicode tables.** The build finds every `\p{Name}` the bundle mentions, computes each property's code-point
  ranges on the build machine (whose Node has ICU), and bakes them in as `__YC_UNICODE_TABLES__`;
  `installRegExpPropertyFallback` rewrites patterns as they reach `new RegExp`. Regex LITERALS that name a
  property are turned into `new RegExp(…)` calls by the build (found with the TypeScript parser), because on the
  phone such a literal is a syntax error for the whole file.
- `node-pty`, `koffi`, `playwright-core` and `*.node` files are left out; they are reached only on paths a phone
  never runs.

## Building

A Mac is required for the app itself (Xcode). Everything else builds anywhere:

- `bash ios/build-resources.sh` — the page (`npm run build:web`), the backend bundle, Node for iOS
  (`runtime/fetch-node.sh`, checksum-pinned in `runtime/pins.env`), then `xcodegen generate` from
  `ios/project.yml` (the `.xcodeproj` is never committed).
- CI: `.github/workflows/ios-ci.yml` builds, runs the Swift unit tests (`ios/YouCodedTests`) and starts the whole
  app in a simulator (`ios/YouCodedUITests`), uploading screenshots, `backend.log` and `page.log`.
- The Dev copy is `com.youcoded.app.dev` ("YouCoded Dev"), installed beside the real app like Android's.
- Logs on a device: `Library/Application Support/userdata/backend.log` (the backend's console) and `page.log`
  (the page's errors and warnings).

### Testing the backend without a Mac

The bundle runs on any Node 18. To imitate the phone on Linux:

```
node ios/runtime/build-backend.mjs /tmp/ios-backend
cd /tmp/ios-backend && HOME=/tmp/h YOUCODED_USER_DATA=/tmp/u YOUCODED_HOST_OS=ios \
  YOUCODED_HEADLESS_PORT=9977 YOUCODED_HEADLESS_TOKEN=<32+ chars> YOUCODED_SECRET_KEY=<64 hex> \
  node18 --jitless dist/main/headless/ios-main.js
```

`--jitless` removes WebAssembly, as on the phone. A Node 18 built `--with-intl=none` also removes ICU.

## With the branches in flight (checked 2026-11-25)

- **Mesh (`session/64-mesh-sync-build`)** merges with this branch without conflicts; the bundle builds (the Unicode
  pass picks up its extra properties by itself) and the Mesh starts on Node 18 `--jitless` in its test mode. Two
  lines there still say Android: `headless-boot.ts` passes `platform: 'android'` to `startMeshIfEnabled` (should be
  `hostOs()`), and the Mesh accepts only `android_keystore` as a phone's secret store (the shell sends `ios_keychain`).
- **Automations (`session/90-pages-finish`)** overlaps this branch in three files (`shared/capabilities.ts` — it adds
  `pageFiles`, which `IOS_LOCAL_CAPABILITIES` then needs; `harness/tools/index.ts`; the generated `preload.ts`).
  Its `net-guard.ts` imports `undici`, which the alias above covers. Its Claude engine (`claude -p`) cannot exist on
  an iPhone; `canRunPrograms()` is the question to ask where it offers Claude models.

## Not done yet

- A run on a physical iPhone, and signing/TestFlight (needs the Apple account; the app's bundle id is not
  registered yet).
- The counting service does not accept an `ios` platform, so iPhones send no daily heartbeat
  (`headless-boot.ts`).
- YouCoded Mesh accepts only `android_keystore` as a phone's secret store; the shell sends `ios_keychain`.
- `shared/device-table.ts` has no iPhone column; iPhone differences live in `IOS_LOCAL_CAPABILITIES`.
- Node 18 is past its end of life upstream; a newer nodejs-mobile is the fix when one is released.
