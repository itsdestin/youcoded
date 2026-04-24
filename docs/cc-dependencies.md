# Claude Code Dependencies

This doc tracks every place YouCoded couples to Claude Code's behavior. The `review-cc-changes` release agent reads it to map CC CHANGELOG entries to code that might break. Humans read it when adding CC-adjacent code.

## When to update

When you add code that parses CC output, consumes a CC file, depends on CLI behavior, or matches a CC text pattern, add an entry below. An omitted touchpoint silently downgrades the release agent to free-reasoning-only mode for that area — don't rely on the agent to notice a coupling that isn't documented here.

Each entry has three fields:

- **Files:** one or more code paths
- **Depends on:** plain-English description of the CC aspect this code relies on
- **Break symptom:** observable user-facing failure if CC changes this

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
- **Depends on:** CC thinking-spinner glyphs `[✻✽✢✳✶*⏺◉]` and suffix `(Ns · esc to interrupt)` (case-insensitive)
- **Break symptom:** `attentionState` misclassifies — AttentionBanner shows false positives or negatives; ThinkingIndicator visibility wrong.

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
