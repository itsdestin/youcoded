# Claude Code Dependencies

This doc tracks every place YouCoded couples to Claude Code's behavior — every silent point of failure when CC changes. It's both a navigational hub for humans and the input to the `review-cc-changes` release agent that maps CC CHANGELOG entries to code that might break.

## When to update

When you add code that parses CC output, consumes a CC file, depends on CLI behavior, or matches a CC text pattern, add an entry below. An omitted touchpoint silently downgrades the release agent to free-reasoning-only mode for that area — don't rely on the agent to notice a coupling that isn't documented here.

Each entry has three fields:

- **Files:** one or more code paths
- **Depends on:** plain-English description of the CC aspect this code relies on
- **Break symptom:** observable user-facing failure if CC changes this

## Verification tooling

Drift detection beats discovering breakage from a user bug report. Several tools exist; use them on every CC version bump and as part of `/audit`.

**Methodology guide:** `desktop/test-conpty/README.md` documents how to write new probes against the live `claude` binary — pre-trusting cwds, detecting "ready" / "submitted" / "stuck" from stdout, ANSI-stripping conventions, cost control, and the pitfalls that consumed the most time the first time around. Read it before adding a new probe. Reusable for any future PTY/Ink/Claude-input/output question, not just chat-submit.

| Tool | What it captures | When to run |
|------|------------------|-------------|
| `desktop/test-conpty/cc-snapshot.mjs` | CC version, paste-classification length threshold (bisected), input-bar echo behavior. Writes JSON to `test-conpty/snapshots/cc-<version>.json` for diffing across releases. | Each CC version bump. Compare new snapshot to prior. |
| `desktop/test-conpty/test-multiline-submit.mjs` | End-to-end submit scenarios against the real `claude` binary — paste threshold, multi-line submit, bug-state recovery. | When changing the worker write protocol (`pty-worker.js`, `PtyBridge.kt`, `useSubmitConfirmation.ts`). |
| `desktop/test-conpty/harness.mjs` | Bracketed-paste viability on Windows ConPTY. Empirical disproof of the marker-based-submit path. | Only re-run if someone proposes resurrecting bracketed paste. |
| `desktop/test-conpty/test-attention-states.mjs` | End-to-end attention classifier behavior against real CC — drives idle/quick/long thinking scenarios and verifies no false-stuck dispatches. Captures observed glyph + gerund sets per scenario. | When changing `attention-classifier.ts` SPINNER_RE, the staleness threshold, or the hook driver. |
| `desktop/test-conpty/test-spinner-fullcapture.mjs` | Captures the full raw byte stream from welcome through response and grep-probes for "esc to interrupt" / "esc to cancel" / `(Ns ·` patterns. Confirms whether CC's spinner format has changed. | Each CC version bump. |
| `desktop/test-conpty/test-attention-false-match.mjs` | Production-accurate false-match probe (uses `@xterm/headless` for buffer rendering) — drives Claude prompts that nudge spinner-shape text into the response, verifies SPINNER_RE doesn't false-match. | When changing the SPINNER_RE shape or the `^` anchor. |
| `shared-fixtures/attention-classifier/*.json` | Pinned classifier inputs + expected outputs. Drives `attention-classifier-parity.test.ts`. | Whenever the spinner regex or classifier behavior changes. Add a fixture in the same commit. |
| `shared-fixtures/transcript-parity/` | Pinned transcript JSONL inputs + expected event streams for the parser. Drives `desktop/tests/transcript-parity.test.ts` and gates the Android Node-CLI parity. | Whenever transcript-watcher logic changes. |
| `shared-fixtures/raw-byte-listener/` | Raw-byte payload contract for the Android terminal-emulator vendor patch. Drives `raw-byte-listener-contract.test.ts`. | Whenever the terminal-emulator vendor patch or `pty:raw-bytes` payload changes. |
| `desktop/tests/ipc-channels.test.ts` | Cross-platform IPC parity matrix — every `window.claude.*` API present in `preload.ts` must be present in `remote-shim.ts` and reachable via a Kotlin `SessionService.kt` handler. | Auto-runs in `npm test`; fails CI if parity drifts. |
| `/audit` slash command | Drift between docs and code. Outputs `docs/AUDIT.md` + carries open items into `docs/knowledge-debt.md`. | Before any release; periodically. |

The most rigorous CC-version drift catch is: re-run `cc-snapshot.mjs` against the new CC, diff the resulting JSON against the prior snapshot, and treat any field change as a release-blocker until the affected coupling entry below is reviewed.

## Current verified baseline

| Field | Value |
|-------|-------|
| Claude Code CLI version | **2.1.119** (April 2026) |
| Paste-classification length threshold | **64 bytes** — atomic write ≥64 bytes ending in `\r` is paste-classified, `\r` becomes literal newline |
| Spinner glyph set | `✻ ✽ ✢ ✳ ✶ * ⏺ ◉ ·` (empirical; not from a documented contract) |
| Input-bar echo delay | ~6.75 s on cold start (Ink batches renders; warm session is faster) |
| Anthropic model ID convention | dotted-hyphen, e.g. `claude-opus-4-7` |

Update this table when you re-run snapshots after a CC version bump. Anything that doesn't match the current snapshot needs an audit before the release ships.

## Touchpoints

### Transcript JSONL shape
- **Files:** `desktop/src/main/transcript-watcher.ts`, `desktop/src/renderer/state/chat-reducer.ts`
- **Depends on:** JSONL entries in `~/.claude/projects/<hash>/*.jsonl` with fields `type`, `message.role`, `message.content[]` (including `text`, `tool_use`, `tool_result`, `thinking` block shapes), `message.usage`, `requestId`, `stop_reason`, and per-turn heartbeats for extended-thinking models
- **Break symptom:** Transcript events stop dispatching; chat UI goes silent while CC still runs. Per-turn metadata (model, usage, requestId, stopReason) disappears from turn bubbles and attention banners.

### Per-turn metadata fields
- **Files:** `desktop/src/renderer/state/chat-reducer.ts` (`TRANSCRIPT_TURN_COMPLETE`, `TRANSCRIPT_ASSISTANT_TEXT` handlers)
- **Depends on:** `message.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`, outer `requestId` (Anthropic `req_…`), `stop_reason` values (`end_turn`, `max_tokens`, `refusal`, `stop_sequence`, `pause_turn`), Anthropic model ID in `message.model`
- **Break symptom:** Token usage / request ID footers disappear; stop-reason banners mis-render; session-pill model reconciliation stops working.

### PTY spinner regex (attention-classifier)
- **Files:** `desktop/src/renderer/state/attention-classifier.ts` (`SPINNER_RE`)
- **Depends on:** CC thinking-spinner leading-glyph set `[✻✽✢✳✶*⏺◉·]` (each is one frame of CC's animation) followed by ` <Gerund>…` (any word + U+2026 ellipsis), anchored to the start of the line (`^`). The glyph set is empirical — discovered by inspecting real CC output, not from any documented contract. CC can introduce a new spinner frame in any release. The previous regex also required `(Ns · esc to interrupt)` after the gerund, but the 2026-04-26 audit confirmed CC v2.1.119 has dropped that suffix entirely; if a future version brings it back, the new regex still matches because the `…` ellipsis is the anchor. The `^` anchor is load-bearing: without it, Claude's response text containing markdown bullets (`* Loading…`) or literal spinner glyphs (`❯ ... ✻ Pondering…`, `● ✻ Pondering…`) triggers false matches. CC also has a hook-execution variant `<glyph> <Gerund>… (running stop hook · 3s · ↓ 1 tokens)` — the regex stops at `…`, so this still matches.
- **Active vs. stalled detection:** Glyph rotation across ticks. Same glyph for ≥10s ⇒ `thinking-stalled`. Verified in `test-conpty/test-attention-states.mjs` and `test-conpty/test-spinner-fullcapture.mjs`. The empirical glyph set captured in 2026-04-26 probes is `{✻ ✽ ✢ ✳ ✶ *}`; `⏺ ◉ ·` come from older traces and remain in the regex pending re-confirmation.
- **Break symptom:** Frame-by-frame intermittent misclassification — `attentionState` flips between `thinking-active` and `'ok'` 1/Nth of the time during a real assistant turn (where N is the spinner frame count). User sees the AttentionBanner flicker; on a well-timed pause CC stays "thinking" but the UI says it's done. Worse: if the regex matches *nothing* during real thinking (e.g. seconds-counter requirement under v2.1.119), the no-spinner-20s escalation in the hook flashes the wrong banner during every long turn. Re-run `node test-conpty/test-spinner-fullcapture.mjs` and `test-conpty/test-attention-states.mjs` on each CC bump to verify.

### PTY worker write protocol — Ink paste threshold
- **Files:** `desktop/src/main/pty-worker.js` (case `'input'`), `app/src/main/.../runtime/PtyBridge.kt` (`writeInput`), `desktop/src/renderer/hooks/useSubmitConfirmation.ts`
- **Depends on:** Two private Ink/CC behaviors that determine whether `body + \r` writes submit a chat message vs. leave a literal newline in the input bar: (1) the **paste-classification length threshold** — atomic writes longer than ~N chars are treated as paste, with trailing `\r` becoming literal newline; the worker's 64-byte chunking + 600 ms Enter-split is designed to keep each individual read below the threshold. Empirically verified: 6-byte atomic `ATEST\r` submits, 101-byte atomic `D + 100×z + \r` does not (CC v2.1.119, April 2026). (2) The **input-bar echo contract** — CC re-renders typed input back through stdout, which the planned echo-driven worker depends on. Both are private Ink internals with no documented contract.
- **Break symptom:** Length-threshold drift makes the chunking workaround stop sufficing — chat sends silently fail to submit (text appears in CC's input bar with literal newline, never reaches Claude) at frequencies that vary with message length and load. `useSubmitConfirmation` retry catches most but adds 5 s recovery latency. Echo-contract drift would break echo-driven send entirely if introduced.

### PTY input-bar echo (input-mirroring)
- **Files:** `desktop/src/main/pty-worker.js` (any future `onData`-watching submit logic)
- **Depends on:** CC echoing typed stdin bytes back into the rendered input bar via stdout, so a programmatic writer can observe consumption before sending the trailing `\r`. This is universal TUI behavior but is technically a CC-internal contract.
- **Break symptom:** If CC stopped echoing input (e.g. switched to a "silent input" mode mid-turn), an echo-driven worker would hang waiting for an echo that never comes; chat sends would never complete. No echo-driven worker is shipped yet — this entry is preventive for the planned change.

### Other PTY attention patterns
- **Files:** `desktop/src/renderer/state/attention-classifier.ts` (regexes for awaiting-input, shell-idle, error, stuck)
- **Depends on:** CC's prompt-boundary phrases and idle markers rendered to the terminal buffer
- **Break symptom:** AttentionBanner states misfire; user sees wrong guidance during PTY-based interactions.

### Hook protocol
- **Files:** `app/src/main/assets/hook-relay.js` (Android), `desktop/src/main/hook-relay.ts` (desktop), `youcoded-core/hooks/hooks-manifest.json`
- **Depends on:** CC's hook event JSON shape (`SessionStart`, `PreToolUse`, `Notification`, etc. — fields `tool_name`, `tool_input`, `session_id`, etc.), CC's `settings.json` hooks schema accepted by the loader
- **Break symptom:** Hooks silently stop firing or fail with cryptic errors; write-guard / worktree-guard / statusline stop functioning.

### Statusline hook payload
- **Files:** `desktop/hook-scripts/statusline.sh`, `app/src/main/assets/statusline.sh`, `desktop/hook-scripts/usage-fetch.js`
- **Depends on:** CC's statusline JSON payload fields (`model`, `session_id`, `version`, and any usage counters surfaced to the statusline hook)
- **Break symptom:** Status bar goes blank or shows stale values; usage counters stop updating; session-context pill loses model/version info.

### Plugin registry four-file format
- **Files:** `desktop/src/main/claude-code-registry.ts`, `app/src/main/.../skills/PluginInstaller.kt`
- **Depends on:** Exact file format of (a) `~/.claude/settings.json` `enabledPlugins` entry key shape `"<id>@<marketplace>": true`, (b) `~/.claude/plugins/installed_plugins.json` v2 entry schema with absolute `installPath`, (c) `~/.claude/plugins/known_marketplaces.json`, (d) `~/.claude/plugins/marketplaces/<marketplace>/.claude-plugin/marketplace.json`
- **Break symptom:** Installed plugins invisible to CC loader; skill marketplace installs report success but `/reload-plugins` shows "0 new plugins".

### MCP configuration schema
- **Files:** `desktop/src/main/mcp-reconciler.ts`
- **Depends on:** CC's MCP-server configuration schema in `~/.claude/mcp.json` or `~/.claude/settings.json` (server entries with `command`, `args`, `env`, and any transport/scope fields owned by Claude Code)
- **Break symptom:** MCP reconciliation writes invalid config; CC refuses to load MCP servers after YouCoded touches the file; silent MCP-server drop-offs.

### Slash commands YouCoded references or intercepts
- **Files:** `desktop/src/renderer/state/slash-command-dispatcher.ts`, `desktop/src/renderer/components/InputBar.tsx`, `desktop/src/renderer/components/ModelPickerPopup.tsx`
- **Depends on:** CC's command names stable across releases (`/model`, `/resume`, `/compact`, `/help`, etc.)
- **Break symptom:** Session-pill reconciliation mis-detects model drift; user-facing tips reference dead commands.

### Anthropic model ID convention
- **Files:** `desktop/src/renderer/state/chat-reducer.ts` (per-turn metadata), `desktop/src/renderer/App.tsx` (session-pill model reconciliation useEffect)
- **Depends on:** Dotted-hyphen model ID form (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`) served by CC in transcript `message.model`
- **Break symptom:** Unknown model IDs render raw in session pill; display-name lookup fails silently.

### CLI invocation flags
- **Files:** `desktop/src/main/session-manager.ts`, `app/src/main/.../runtime/PtyBridge.kt`
- **Depends on:** `claude` CLI accepting the flags YouCoded passes at launch (notably `--resume <session-id>` and any default flags in the launch command)
- **Break symptom:** Session resume breaks; PTY spawns fail; new sessions launch in unexpected state.

### npm package entry-point layout (Android)
- **Files:** `app/src/main/.../runtime/Bootstrap.kt` (`isFullySetup`, `installClaudeCode`, `selfTest`), `app/src/main/.../runtime/PtyBridge.kt` (launch command)
- **Depends on:** `npm install -g @anthropic-ai/claude-code` producing a JS entry at `lib/node_modules/@anthropic-ai/claude-code/cli.js`, launchable via `linker64 node claude-wrapper.js cli.js`. Claude Code is currently pinned to **2.1.112** — the last release with this layout. Bumping the pin requires migrating Android to the native-binary distribution (2.1.113+).
- **Break symptom:** Bootstrap self-test fails with "Claude Code CLI entry point not found"; even bypassing self-test, PtyBridge launch fails because `cli.js` is absent. Observed in Claude Code 2.1.113 when the npm package was repackaged as a native-binary launcher with `bin/claude.exe` + `install.cjs` + per-platform sibling packages (`@anthropic-ai/claude-code-linux-arm64` etc.).

### Native installer bootstrap script (Desktop)
- **Files:** `desktop/src/main/prerequisite-installer.ts` (`installClaude`)
- **Depends on:** `https://claude.ai/install.ps1` (Windows) and `https://claude.ai/install.sh` (macOS/Linux) URLs continuing to redirect to two-stage bootstrap scripts that (a) download a per-version `claude` binary from `downloads.claude.ai/claude-code-releases/<version>/<platform>/`, and (b) invoke `<binary> install` to register `claude` on PATH (HKCU registry on Windows; `~/.zshrc` / `~/.bashrc` on POSIX). Bootstraps verified non-interactive (no `Read-Host` / `read` prompts), require no admin or sudo, exit 0 on success / 1 on failure, and SHA-verify their downloads. Distinct from the Android entry above — desktop migrated off the npm path; Android still uses npm because the Termux runtime relies on the `cli.js` JS-entry shape. Verified 2026-04-28.
- **Break symptom:** First-run wizard reports "Failed to install Claude Code: <stderr from bootstrap>" or "Claude Code installed but is not on this app's PATH yet — restart YouCoded." Existing-user upgrades unaffected (`installClaude` is dormant when `detectClaude` already finds `claude`). New users on clean machines can't get past the first-run installer step. Likely triggers: (a) Anthropic moves distribution to winget-only / Microsoft Store / a custom URL scheme; (b) bootstrap becomes interactive (adds a `Read-Host` prompt — would hang our `runCommand` invocation); (c) the `<binary> install` subcommand is removed or renamed; (d) Anthropic stops auto-redirecting `claude.ai/install.{ps1,sh}` to `downloads.claude.ai`.

### Permission flow messages
- **Files:** `desktop/src/renderer/state/hook-dispatcher.ts`, `desktop/src/renderer/hooks/usePromptDetector.ts`, `desktop/src/renderer/state/chat-reducer.ts`
- **Depends on:** CC's approval-request shape in transcript or hook-relay, matching the IPC message YouCoded constructs for `PERMISSION_REQUEST`
- **Break symptom:** Permission prompts don't appear; approvals never propagate back to CC; tool calls hang in `awaiting-approval`.

### JSONL transcript file location
- **Files:** `desktop/src/main/transcript-watcher.ts`
- **Depends on:** Transcript files written at `~/.claude/projects/<encoded-cwd-path>/*.jsonl` with CC's path-encoding scheme
- **Break symptom:** Transcript watcher watches the wrong directory; chat UI silent for all sessions.

### CC built-in command list
- **Files:** `desktop/src/main/cc-builtin-commands.ts`, `app/src/main/kotlin/com/youcoded/app/runtime/CommandProvider.kt` (the `CC_BUILTIN_COMMANDS` companion block)
- **Depends on:** Claude Code's set of built-in slash commands — names and behaviors baked into the compiled `claude` binary. These lists are hand-maintained; the SDK init message's `slash_commands` array omits core meta commands so automated discovery is not viable. Both files carry a version-anchor comment ("Last verified against Claude Code CLI vX.Y.Z — DATE") at the top.
- **Break symptom:** New CC built-ins don't appear in the YouCoded CommandDrawer search. Removed CC built-ins still appear but remain unclickable with a "Run in Terminal View" note, so user impact is minor (they don't work when the user follows that hint in Terminal View). Renamed built-ins show with their old name.

### claude --version output format
- **Files:** `youcoded-admin/skills/release/SKILL.md` (Phase 4 Step 3 and Step 2 baseline-line injection)
- **Depends on:** `claude --version` output containing a parseable `\d+(\.\d+)+` substring
- **Break symptom:** Release skill's CC version capture fails; baseline line not written; next release's `review-cc-changes` agent exits with the "no baseline" notice.

### claude -p stdin mode (Settings → Development summarizer)
- **Files:** `desktop/src/main/dev-tools.ts` (`summarizeIssue`), `app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt` (`dev:summarize-issue` case)
- **Depends on:** `claude -p` accepting the prompt on stdin (no positional arg) and emitting a parseable JSON envelope on stdout. Reuses the user's Claude Code OAuth token automatically — no separate auth.
- **Break symptom:** Bug-report summarizer degrades to fallback envelope (renderer shows raw description with "Summary unavailable" note). Submission still works, but maintainers see a less-useful issue body. Failure is silent — the user never sees an error.

### gh CLI (Settings → Development bug-report submission)
- **Files:** `desktop/src/main/dev-tools.ts` (`submitIssue`, `isGhAuthenticated`), `app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt` (`dev:submit-issue` case)
- **Depends on:** `gh auth status` exiting non-zero when the user isn't logged in; `gh issue create --repo … --title … --body-file … --label …` writing the created-issue URL to stdout on success and exiting non-zero on failure; the `--label` flag rejecting unknown labels (which is why `bug`, `enhancement`, `youcoded-app:reported` must pre-exist on `itsdestin/youcoded`). Note: this is `gh` CLI, not Claude Code itself, but it shares the same pattern of "behavior we shell out to and parse" so it lives here.
- **Break symptom:** Issue submission silently falls back to the URL-prefill path (browser opens with prefilled fields) on every call when the auth-check exit code or `issue create` stdout format changes. User can still submit manually in the browser; YouCoded just stops doing it for them.

### Task tool result strings (Open Tasks chip)
- **Files:** `desktop/src/renderer/state/task-state.ts` (`parseTaskCreateResult`, `parseTaskListResult`)
- **Depends on:** Two CC-emitted result strings parsed by the Open Tasks chip data layer. (1) `TaskCreate` response: `"Task #<N> created successfully: <subject>"` — the numeric id is only in this string, not in the tool input. (2) `TaskList` response: newline-separated rows matching `^#<N> \[(pending|in_progress|completed)\] (?:Task \d+: )?<subject>$` — authoritative per-session snapshot.
- **Break symptom:** Open Tasks chip and popup lose visibility into newly-created tasks (they still appear after a subsequent `TaskUpdate` that carries `taskId` directly). If TaskList format changes, the `buildTasksById` authoritative-snapshot path silently stops reconciling status — chip counts drift from what `TaskList` reports until the user triggers an explicit TaskUpdate. Parsers return `null`/`[]` on mismatch, so no render crash — just silent data gaps.

### Android attention classifier

- **What:** `useAttentionClassifier` (renderer) runs on standalone Android by reading screen text via `window.claude.terminal.getScreenText`, which routes to `PtyBridge.readScreenText()` on the Android side. Classifier regex in `classifyBuffer` matches Claude Code CLI spinner glyphs (✻✽✢✳✶*⏺◉·) followed by `<Gerund>…`. The seconds-counter / "esc to interrupt" / "esc to cancel" markers were removed in the 2026-04-26 audit because CC v2.1.119 no longer emits any of them.
- **CC-coupled files:**
  - `desktop/src/renderer/state/attention-classifier.ts` (patterns)
  - `desktop/src/renderer/hooks/useAttentionClassifier.ts` (tick logic)
  - `desktop/tests/attention-classifier-parity.test.ts` + `shared-fixtures/attention-classifier/` (regression coverage)
- **Why coupled:** Patterns must match Claude Code's CLI output. Visual changes to the Ink UI (spinner glyph, prompt copy, error banner color) can break classification silently.
- **Review trigger:** Any Claude Code CHANGELOG entry mentioning TUI / Ink / prompt / spinner / progress updates.

### Terminal rendering surface (Tier 2)

- **What:** xterm.js (in the React WebView) is the sole terminal renderer on both platforms. Bytes flow desktop pty:output (string) → xterm; Android pty:raw-bytes (base64 → Uint8Array) → xterm. The `TerminalView` component is shared — touch platforms run with `disableStdin: true` and consume `pty:raw-bytes` via `usePtyRawBytes`; desktop runs unchanged.
- **CC-coupled files:**
  - `desktop/src/renderer/components/TerminalView.tsx` (renderer)
  - `desktop/src/renderer/hooks/usePtyRawBytes.ts` (Android byte consumer)
  - `app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt` (`launchRawByteBroadcast`)
  - `terminal-emulator-vendored/` (Termux v0.118.1 + RawByteListener patch)
- **Why coupled:** xterm renders Claude Code's TUI byte stream verbatim. Any CC change that re-ANSI-encodes the TUI differently (e.g. switches Ink to alternate-screen mode `\e[?1049h`, changes how it clears screen / scrolls regions, or starts using sequences xterm doesn't support) affects what users see — including the known-issue scrollback duplication when CC redraws the full TUI. CC switching to alt-screen would actually FIX the scrollback duplication, but would break our `terminal:get-screen-text` IPC if we relied on the main-screen buffer.
- **Review trigger:** CC CHANGELOG entries mentioning terminal rendering, alt-screen, scroll regions, ANSI escape sequence usage, or TUI redraw strategy.
