# Android ↔ Desktop Parity Implementation Plan

**Branch:** `feat/android-desktop-parity`
**Worktree:** `youcoded-dev/worktrees/android-parity/`
**Date:** 2026-04-23

## Goal

Eliminate two production bugs and the architectural class they belong to:

1. **Bug 1:** Erroneous "Browser opened — waiting for code" PromptCard appears in Android chat view.
2. **Bug 2:** Tool calls don't group consistently on Android vs desktop.

Beyond the immediate fixes, drive Android's chat-state production toward a single source of truth so future Claude Code CLI changes can't silently desync the two platforms.

## Success Criteria

- "Browser opened — waiting for code" never appears unless the user is actually in OAuth flow.
- Same prompt → same tool-call grouping → same timeline structure on desktop and Android.
- A single TypeScript module is the authoritative transcript parser; both platforms run it.
- Hardcoded duplicated lists (bundled plugins, setup-prompt titles, CC built-ins) live in one place.
- A parity test in CI fails if a future change makes Android emit a different event stream than desktop.

## Phasing & Risk

| Phase | Scope | Risk | Reversible? |
|-------|-------|------|-------------|
| 1 | Bug fixes — drop `streaming-text`, replace OAuth regex with whitelist | Low | Yes (small Kotlin diffs) |
| 2 | Shared JSON for hardcoded lists + parity-test scaffolding | Low | Yes |
| 3 | Transcript watcher → Node subprocess on Android | Medium | Yes (Kotlin watcher kept as fallback for one release) |

Phase 1 alone fixes the user-visible bugs. Phases 2 and 3 are the long-term drift-proofing.

---

## Phase 1 — Stop the Bleeding

### Chunk 1.1 — Remove Android-only `streaming-text` event

**Why:** Android emits `TranscriptEvent.StreamingText` for `progress` JSONL lines. Desktop's `transcript-watcher.ts:42` skips anything that isn't `user`/`assistant`. The shared React reducer has no handler for `streaming-text`, so the events go nowhere — but they're a known divergence (the Kotlin serializer comment at `TranscriptSerializer.kt:110` flags it explicitly) and a contributor to the Bug 2 ordering theory.

**Files:**
- Modify: `app/src/main/kotlin/com/youcoded/app/parser/TranscriptWatcher.kt`
- Modify: `app/src/main/kotlin/com/youcoded/app/parser/TranscriptEvent.kt`
- Modify: `app/src/main/kotlin/com/youcoded/app/bridge/TranscriptSerializer.kt`
- Modify: `app/src/main/kotlin/com/youcoded/app/runtime/ManagedSession.kt`

**Tasks:**

- [ ] **Step 1: Remove the `progress` route in `parseLine`.** Delete the `"progress" -> parseProgressLine(...)` arm at `TranscriptWatcher.kt:222`. Add a one-line comment: `// "progress" — skipped to match desktop (transcript-watcher.ts:42)`.
- [ ] **Step 2: Delete `parseProgressLine`** at `TranscriptWatcher.kt:387-403` and the `accumulatedStreamingText` field on `WatcherState` (lines 80, 234) along with any reset sites.
- [ ] **Step 3: Remove `TranscriptEvent.StreamingText`** at `TranscriptEvent.kt:90`.
- [ ] **Step 4: Remove `TranscriptSerializer.streamingText`** at `TranscriptSerializer.kt:110-113`.
- [ ] **Step 5: Remove the StreamingText branch** in `ManagedSession.kt:306` (the event collector's `when` arm).
- [ ] **Step 6: Build Android** with `./gradlew assembleDebug` and confirm no compile errors.

### Chunk 1.2 — Replace free-text OAuth regex with structured whitelist

**Why:** `ManagedSession.kt:538-555` fires `prompt:show` with the hardcoded "Browser opened — waiting for code..." button whenever the PTY screen contains ("paste code" OR "browser") AND ("sign" OR "code" OR "authorize"). That's a substring AND — false positives on any normal output mentioning "browser" + "code". Desktop's `usePromptDetector.ts:16-23` ships a strict whitelist of 6 known Ink-menu titles; Android should mirror that approach.

**Files:**
- Modify: `app/src/main/kotlin/com/youcoded/app/runtime/ManagedSession.kt`
- Reference (desktop): `desktop/src/renderer/hooks/usePromptDetector.ts:16-23`
- Reference (Android Ink parser): `app/src/main/kotlin/com/youcoded/app/parser/InkSelectParser.kt`

**Tasks:**

- [ ] **Step 1: Delete the free-text OAuth detector block** at `ManagedSession.kt:538-555` (the `// --- Browser auth / paste code prompt ---` block).
- [ ] **Step 2: Confirm `InkSelectParser.kt` already produces a parsed menu title for the OAuth screen.** If it does, the existing menu-detection block above (lines 510-524) already handles OAuth — delete-and-rely-on-the-parser is the cleanest move.
- [ ] **Step 3: Add a Kotlin `SETUP_PROMPT_TITLES` constant** at the top of `ManagedSession.kt` (or a new `app/.../runtime/PromptWhitelist.kt`):
  ```kotlin
  private val SETUP_PROMPT_TITLES = setOf(
      "Trust This Folder?",
      "Choose a Theme",
      "Select Login Method",
      "Skip Permissions Warning",
      "Resume Session",
      "Usage Limit Reached",
  )
  ```
  Mirror desktop verbatim. (Phase 2 will lift this into shared JSON; Phase 1 keeps the duplication so the bug fix can ship independently.)
- [ ] **Step 4: Gate the parsed-Ink-menu broadcast** at `ManagedSession.kt:520-524` with `if (parsed.title !in SETUP_PROMPT_TITLES) return`. Same gate desktop uses at `usePromptDetector.ts:119`.
- [ ] **Step 5: Audit other `broadcastPrompt` call sites** (lines 455, 484, 522, 543, 569-576) for the same class of free-text triggers. The "Press Enter to continue" block (557-588) and the bypass warning (lines 470-497) need the same scrutiny — flag any whose trigger is free-text rather than parsed Ink. Resolve by either porting a desktop-style structural check or removing.
- [ ] **Step 6: Build, install on a test device, and reproduce.** Run a session that includes the words "browser" and "code" in normal output (e.g., "tell me about how a browser handles JavaScript code"). Confirm no spurious PromptCard appears.

### Chunk 1.3 — Phase 1 verification

- [ ] **Step 1: Run desktop tests** — `cd desktop && npm test`. Should all pass; nothing changed on the desktop side.
- [ ] **Step 2: Run Android tests** — `./gradlew test`.
- [ ] **Step 3: Build the React UI and Android APK** — `./scripts/build-web-ui.sh && ./gradlew assembleDebug`.
- [ ] **Step 4: Smoke test on device.** Two scenarios:
  - Run a Claude session that invokes 3+ tools in one turn (e.g., "read these three files: a, b, c"). Confirm tool calls render as a single grouped bubble matching desktop.
  - Run a session whose output mentions "browser" and "code" as plain text. Confirm no "Browser opened — waiting for code" PromptCard appears.
- [ ] **Step 5: Commit** as `fix(android): remove streaming-text + tighten OAuth prompt detection`. Include WHY comments per CLAUDE.md.
- [ ] **Step 6: Update `docs/PITFALLS.md`** — add an entry under "Cross-Platform" noting that Android's transcript watcher must mirror desktop's parsed types (no `progress`).

---

## Phase 2 — Shared Data + Parity Scaffolding

### Chunk 2.1 — Lift hardcoded lists to shared JSON

**Why:** Three lists are currently hand-synced across platforms — `BUNDLED_PLUGIN_IDS` (PITFALLS already calls this out), the setup-prompt titles whitelist (just duplicated in Phase 1), and the CC built-in commands list. Each is an independent drift surface.

**Files:**
- Create: `desktop/src/shared/setup-prompt-titles.json`
- Create: `desktop/src/shared/cc-builtin-commands.json`
- Modify: `desktop/src/shared/bundled-plugins.ts` → migrate constant body to `bundled-plugins.json`, keep `bundled-plugins.ts` as a re-export shim
- Modify: `desktop/src/renderer/hooks/usePromptDetector.ts` (import from shared)
- Modify: `desktop/src/main/cc-builtin-commands.ts` (import from shared)
- Modify: `app/src/main/kotlin/com/youcoded/app/runtime/ManagedSession.kt` (read from JSON resource)
- Modify: `app/src/main/kotlin/com/youcoded/app/skills/BundledPlugins.kt` (read from JSON resource)
- Modify: `app/src/main/kotlin/com/youcoded/app/runtime/CommandProvider.kt` (read from JSON resource)
- Modify: `scripts/build-web-ui.sh` — copy `desktop/src/shared/*.json` into `app/src/main/assets/shared/` so Android can read them at runtime

**Tasks:**

- [ ] **Step 1: Create `desktop/src/shared/setup-prompt-titles.json`** with the 6-title array. Update `usePromptDetector.ts:16-23` to import + use it.
- [ ] **Step 2: Migrate `bundled-plugins.ts`** to read from `bundled-plugins.json`. Keep `BUNDLED_PLUGIN_IDS` exported from the .ts shim so existing imports still work.
- [ ] **Step 3: Create `cc-builtin-commands.json`** from the array currently in `desktop/src/main/cc-builtin-commands.ts`. Update the .ts file to import from JSON.
- [ ] **Step 4: Extend `scripts/build-web-ui.sh`** to also copy `desktop/src/shared/*.json` into `app/src/main/assets/shared/` (separate from the React bundle copy). One-time cost: a fresh APK build is required to pick up shared-list changes — same constraint that already exists for the React UI.
- [ ] **Step 5: Add a helper** `app/src/main/kotlin/com/youcoded/app/util/SharedAssets.kt` that loads a JSON array from `assets/shared/<name>.json` into a Kotlin `List<String>` / `Set<String>`. Cache after first read.
- [ ] **Step 6: Replace the Kotlin Phase-1 `SETUP_PROMPT_TITLES` constant** with `SharedAssets.loadStringSet("setup-prompt-titles")`. Same for `BundledPlugins.kt` and `CommandProvider.kt` built-ins.
- [ ] **Step 7: Update PITFALLS.md "Plugin Installation & Claude Code Registries"** entry — the "Bundled plugin list is two-way duplicated" warning becomes "shared JSON, single source of truth."

### Chunk 2.2 — Parity test scaffolding

**Why:** Phase 3 will share the transcript-watcher code itself. Until then (and as a permanent regression net), a CI test that diffs both implementations' event output against a fixture catches drift early.

**Files:**
- Create: `desktop/tests/fixtures/transcripts/` — directory with hand-curated `.jsonl` fixtures (one file per scenario: simple-tool, multi-tool-grouped, intermediate-text, subagent, compact, oauth)
- Create: `desktop/tests/fixtures/transcripts/expected-events.json` — expected event stream per fixture, the canonical answer
- Create: `desktop/tests/transcript-events.test.ts` — runs `transcript-watcher.ts` against each fixture, asserts byte-equal match with `expected-events.json`
- Create: `app/src/test/kotlin/com/youcoded/app/parser/TranscriptWatcherParityTest.kt` — runs `TranscriptWatcher.kt` against the same fixtures (copied via Gradle task from the desktop repo), asserts the same `expected-events.json`
- Modify: `app/build.gradle.kts` — Gradle task `copyTranscriptFixtures` runs before `testDebugUnitTest`

**Tasks:**

- [ ] **Step 1: Capture 6 fixture transcripts** by running real Claude Code sessions and extracting the relevant slices from `~/.claude/projects/<slug>/<sessionId>.jsonl`. Sanitize PII.
- [ ] **Step 2: Write `expected-events.json`** by hand for each fixture — JSON array of `{type, ...payload}` in emission order. This is the canonical contract.
- [ ] **Step 3: Write the desktop Vitest** — load fixture, instantiate `TranscriptWatcher`, collect emitted events, assert deep-equal.
- [ ] **Step 4: Write the Kotlin parity test** — same shape. Use Gradle's `copy` to mirror fixtures.
- [ ] **Step 5: Wire both into CI.** Desktop test runs in `desktop-release.yml`'s test job; Android test runs in the existing Android workflow.
- [ ] **Step 6: Verify both fail** when `transcript-watcher.ts` is modified to drop a tool_use event (deliberately, then revert). Confirms the safety net works.

### Chunk 2.3 — Phase 2 verification

- [ ] **Step 1: All Phase-1 smoke tests still pass.**
- [ ] **Step 2: Desktop unit tests + parity test pass** (`cd desktop && npm test`).
- [ ] **Step 3: Android unit tests + parity test pass** (`./gradlew test`).
- [ ] **Step 4: Build APK** and confirm shared JSON is copied to `assets/shared/`.
- [ ] **Step 5: Commit** as `chore(parity): shared JSON for hardcoded lists + parity test scaffolding`.

---

## Phase 3 — Transcript Watcher as Node Subprocess

### Chunk 3.1 — Extract `transcript-watcher.ts` into a runnable CLI

**Why:** This is the single source-of-truth move. Today the parsing logic lives intertwined with Electron-specific glue (IPC, `BrowserWindow.webContents.send`). Extract the pure parsing into a module that can be both `import`ed (Electron) and run as `node transcript-watcher-cli.js <projectsDir>` (Android).

**Files:**
- Modify: `desktop/src/main/transcript-watcher.ts` — split into `transcript-parser.ts` (pure: line → event objects) and `transcript-watcher.ts` (file watching, owns the parser)
- Create: `desktop/src/cli/transcript-watcher-cli.ts` — thin wrapper that takes argv `<projectsDir>`, instantiates the watcher, writes NDJSON events to stdout
- Create: `desktop/scripts/build-transcript-watcher-cli.js` — esbuild bundler producing a single-file CommonJS bundle at `desktop/dist/cli/transcript-watcher-cli.js`
- Modify: `desktop/package.json` — add `esbuild` devDependency, add `build:cli` script, wire into `build`
- Modify: `scripts/build-web-ui.sh` (workspace) — also build the CLI and copy the bundled file into `app/src/main/assets/transcript-watcher-cli.js`

**Tasks:**

- [ ] **Step 1: Refactor `transcript-watcher.ts`** — move the pure parsing functions (`parseTranscriptLine`, helpers, `stripSystemTags`) into a new `desktop/src/shared/transcript-parser.ts`. The watcher keeps file IO + event emission. Electron behavior unchanged.
- [ ] **Step 2: Run the desktop parity test from Phase 2** — must still pass with the refactor. This proves the extraction didn't change behavior.
- [ ] **Step 3: Create `desktop/src/cli/transcript-watcher-cli.ts`** — accepts `--projects-dir` and `--mobile-session-id` + `--transcript-path` per session via stdin commands, writes one JSON object per line on stdout. Protocol:
  ```
  → stdin (line): {"command":"watch","mobileSessionId":"...","transcriptPath":"..."}
  → stdin (line): {"command":"unwatch","mobileSessionId":"..."}
  ← stdout (line): {"type":"transcript-event","payload":{...same as TranscriptEvent...}}
  ← stderr: log lines (forwarded to Android logcat)
  ```
- [ ] **Step 4: Add `desktop/scripts/build-transcript-watcher-cli.js`** — esbuild config: target `node18`, format `cjs`, platform `node`, single-file bundle, externals: none.
- [ ] **Step 5: Add `esbuild` devDep + npm scripts** — `"build:cli": "node scripts/build-transcript-watcher-cli.js"`, and chain it into `"build": "vite build && npm run build:cli"`.
- [ ] **Step 6: Extend `scripts/build-web-ui.sh`** to copy `desktop/dist/cli/transcript-watcher-cli.js` into `app/src/main/assets/transcript-watcher-cli.js`.

### Chunk 3.2 — Wire Android to spawn the Node CLI

**Why:** Replace the Kotlin `TranscriptWatcher` with a process supervisor that launches the Node helper, parses its NDJSON stdout, and forwards each event to `LocalBridgeServer`.

**Files:**
- Create: `app/src/main/kotlin/com/youcoded/app/parser/TranscriptWatcherProcess.kt` — new supervisor class. Same public interface as `TranscriptWatcher.kt` (startWatching, stopWatching, events SharedFlow).
- Modify: `app/src/main/kotlin/com/youcoded/app/runtime/Bootstrap.kt` — deploy `transcript-watcher-cli.js` from assets to `~/.claude-mobile/transcript-watcher-cli.js` at session-start (mirror `deployWrapperJs()`).
- Modify: `app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt` — instantiate `TranscriptWatcherProcess` instead of `TranscriptWatcher`. Keep `TranscriptWatcher.kt` in-tree as fallback (gated by config flag for one release).
- Modify: `app/src/main/kotlin/com/youcoded/app/runtime/ManagedSession.kt` — no API changes; `events` flow stays the same shape.

**Tasks:**

- [ ] **Step 1: Add `Bootstrap.deployTranscriptWatcherCli()`** mirroring `deployWrapperJs()`. Idempotent overwrite at every launch so APK updates pick up new CLI.
- [ ] **Step 2: Implement `TranscriptWatcherProcess.kt`:**
  - Spawns `node ~/.claude-mobile/transcript-watcher-cli.js` once per app lifecycle (not per session) using `Bootstrap.buildRuntimeEnv()` so LD_PRELOAD + linker64 routing apply.
  - Pipes stdin (commands), stdout (events), stderr (logcat).
  - Coroutine reader on stdout: `BufferedReader.lineSequence()` → `JSONObject` → emit `TranscriptEvent` into the existing SharedFlow.
  - `startWatching(sessionId, path)` writes a `{"command":"watch", ...}` line to stdin.
  - Process supervisor: detect death via `Process.waitFor()` on a background thread → log → respawn once → on second death surface a `dev:log-tail`-visible error and fall back to spinning up the legacy `TranscriptWatcher.kt`.
- [ ] **Step 3: Add a config flag** `transcriptWatcher.useNodeProcess` defaulting to `true` in `~/.claude-mobile/config.json`. SessionService picks the implementation based on this flag. Lets us roll back without an APK update.
- [ ] **Step 4: Wire `SessionService.kt`** to use `TranscriptWatcherProcess` when the flag is true.
- [ ] **Step 5: Run the parity test from Phase 2 against the Node CLI's output** — assert it matches the same `expected-events.json`. This is the key invariant: same fixture → same events whether parsed in-process by desktop or in a subprocess by Android.

### Chunk 3.3 — Phase 3 verification

- [ ] **Step 1: Bench Android startup time** — measure cold session-open before and after. Acceptance: <300 ms regression.
- [ ] **Step 2: Bench Android memory** — measure RSS before and after. Acceptance: <50 MB increase.
- [ ] **Step 3: Kill the Node helper mid-session** with `pkill node` from a Termux shell. Confirm: respawn happens, transcript events resume within 2s, the user sees no broken state.
- [ ] **Step 4: Force the Node helper to fail to spawn** (rename the asset deploy target). Confirm: error surfaces in `dev:log-tail`, fallback to legacy Kotlin watcher engages, app remains functional.
- [ ] **Step 5: Run Phase 1 + Phase 2 smoke tests on device** — all still pass.
- [ ] **Step 6: Add a `cc-dependencies.md` entry** for the Node CLI bundle (it parses CC's JSONL — qualifies as CC-coupled per the rule in PITFALLS).
- [ ] **Step 7: Commit** as `feat(android): transcript watcher runs as Node subprocess for desktop parity`.

---

## Cross-Phase Operating Rules

- All work in this worktree (`worktrees/android-parity/`). One commit per chunk.
- After each chunk: `git push -u origin feat/android-desktop-parity` so progress is durable.
- Don't merge to master until all three phases land **and** the user has used the phase-1 build for at least 2-3 days. (Per the user's stated preference for proving fixes before stacking new architecture.)
- Each Kotlin edit gets a WHY comment per CLAUDE.md.
- Update `docs/PITFALLS.md` at the end of each phase with the new invariants the phase establishes.

## Rollback Strategy

| Phase | If broken |
|-------|-----------|
| 1 | Revert the commit; Android returns to the buggy-but-known state. No data migration needed. |
| 2 | Revert the commit; Kotlin re-reads its hardcoded lists. JSON files become orphaned (harmless). |
| 3 | Flip `transcriptWatcher.useNodeProcess` to `false` in `~/.claude-mobile/config.json`; legacy Kotlin watcher takes over without an APK update. If the config plumbing itself broke, revert the commit and reissue the APK. |

## What's Explicitly Out of Scope

- Sharing the **plugin installer** logic via Node subprocess. Documented in my recommendation as a "later" candidate; not worth bundling into this branch.
- Sharing the **Ink menu parser** logic. Phase 1 fixes the OAuth bug structurally; cross-language sharing of the parser is a smaller win that can wait.
- Touching the **attention classifier** — it's already desktop-only by design (PITFALLS docs the why).
- Touching **sync** — also desktop-only by design.
- Renaming or refactoring the existing `TranscriptEvent` / `TranscriptSerializer` types beyond what Phase 1 deletions force.

## Open Questions for the User Before Phase 3

1. **Node helper lifecycle:** spawn once per app lifecycle vs. once per session? This plan assumes once per app lifecycle (cheaper, matches how `claude` itself runs). Confirm.
2. **CLI protocol bikeshed:** NDJSON over stdin/stdout vs. a Unix domain socket like the existing `hook-relay.js`? This plan picks NDJSON for simplicity. Acceptable?
3. **Config flag default:** ship Phase 3 with `useNodeProcess=true` (commit to the new path) or `false` (opt-in for one release, then flip)? This plan defaults to `true` for fastest convergence; the fallback exists for rollback. Confirm.
