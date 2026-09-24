> Migrated from youcoded-dev docs/PITFALLS.md (2026-07-15 triage). The path-scoped rule in youcoded-dev/.claude/rules/pty-io.md is the terse always-injected layer; this doc is the depth.

# PTY I/O mechanism — depth

Writing programmatically into Claude Code's Ink TUI input bar exposes undocumented behaviors. Submit logic: `desktop/src/main/pty-worker.js` (case `'input'`) + `app/.../PtyBridge.kt` (`writeInput`). Renderer safety net: `useSubmitConfirmation.ts`. Gate: `state/pty-input-gate.ts`.

## The mechanism (April 2026 audit, CC v2.1.119)

- **Paste classification is LENGTH-GATED.** Empirical bisection (`test-conpty/cc-snapshot.mjs`): an atomic 63-byte write (62-char body + `\r`) submits cleanly; an atomic 64-byte write (63-char body + `\r`) leaves the body in the input bar with a literal `\n` — the `\r` was absorbed as paste content. The threshold is **exactly 64 bytes** for CC v2.1.119 (likely an Ink buffer-size constant); future versions may shift it. The bisected value lives in `test-conpty/snapshots/cc-<version>.json` — re-run `cc-snapshot.mjs` on each CC bump and diff.
- **CC echoes typed bytes back through stdout** (Ink re-renders the input bar). Cold-start delay ~6.7s on Windows; warm-session sub-second. Universal TUI behavior but also a CC-internal contract — see `docs/cc-dependencies.md` "PTY input-bar echo."
- **Windows ConPTY drops bytes on large single writes** (>~600). Bracketed-paste markers don't survive ConPTY at all. Both are addressed by chunking the body ≤56 bytes.

## The submit protocol (post-April-2026 redesign)

Three deterministic shapes; no 600ms timing guesses on the Windows path:

1. **Passthrough** — no trailing `\r`. Single write.
2. **Atomic submit** — `\r` AND total ≤ `SAFE_ATOMIC_LEN` (56 bytes; 8-byte margin under the threshold). One write.
3. **Echo-driven submit** (desktop) / **600ms split** (Android) — `\r` AND >56. Chunk body ≤56 bytes, then `\r` separately.
   - **Desktop:** wait for the body tail to echo from CC stdout (proving CC drained the body from its input pipe), then write `\r` as one byte — no timing assumption. On echo timeout (`ECHO_TIMEOUT_MS`, 12s) SUPPRESS the CR (no echo ⇒ a live Ink select menu has focus; a blind `\r` answers it). Recovery is the renderer retry. Do NOT reintroduce the blind fallback CR (2026-07-09 stray-Enter fix, youcoded#110).
   - **Android:** still 600ms gap (Linux PTY has no ConPTY gap-collapse). Mirroring desktop's echo-driven approach is a TODO in `PtyBridge.writeInput`.

## Answering a live Ink select menu (2026-07-26, CC 2.1.220)

Driving CC's menus (folder trust, Resume Session, theme/login pickers, usage-limit,
auto-mode opt-in; on 2.1.281 the startup dialogs are unnumbered — see below) is a separate protocol from submitting text, and it was wrong from
the feature's introduction until 2026-07-26. Two behaviours, both measured with
`node-pty` + `@xterm/headless` against the real CLI:

- **Arrows in a write that ends with `\r` are DISCARDED.** CC acts on the Enter alone
  and confirms whatever option is currently highlighted. Measured on `/model`: cursor
  at index 1, `UP×5 + DOWN×N + \r` as ONE write committed index 1 for N = 0,1,2,3.
  The old `menuToButtons` emitted exactly that shape, so **every** button answered the
  highlighted option — on Resume Session that is option 1, which runs `/compact`
  (hence "all options just compact the session"), and on the folder-trust dialog it
  meant clicking "No, exit" TRUSTED the folder.
- **The menus WRAP, they do not clamp.** `UP×5` on the 3-option resume prompt moves
  index 0 → 1. So "overshoot UP to anchor at the top" — the premise of the April 2026
  fix — was false independently of the point above.
- **A bare digit selects AND submits the matching numbered option.** One byte, no
  Enter, no dependence on cursor position. Verified on `/model`, the real Resume
  Session prompt, and the 2.1.220 folder-trust prompt. A numbered menu's button always
  takes this path (`menuToButtons` → `state/prompt-input.ts` → `sendPromptInput`); the
  digit is read off the option's own screen line (`ParsedMenu.optionNumbers`), never
  inferred from list position.

**Unnumbered menus exist since CC 2.1.281** (2026-09-23): the folder-trust dialog, the
bypass-permissions warning and single-server MCP approval print no "1." / "2.", and a
typed digit does nothing on them (fixture `untrusted-digit-ignored`). Their buttons carry
`pick` and go through `state/ink-menu-driver.ts` (`answerInkMenu`) — verified navigation:
- before the first key the screen must show the SAME option set the card showed (its
  signature); otherwise nothing is typed;
- ONE arrow per write, toward the target, each confirmed on screen before the next; the
  direction comes from where the cursor really is (the menus wrap);
- Enter alone, only once the cursor sits on exactly the target label; success = the menu
  left the screen and stayed gone. Timings: `INK_MENU_TIMING`; failures `menu-changed` /
  `menu-gone` / `not-taken`, worded by the card.

Only ONE device may drive such a menu at a time: `main/menu-answer-lock.ts` (IPC
`session:menu-lock`, a 20 s lease, one instance shared by desktop IPC and the remote
WebSocket host; Kotlin `MenuAnswerLock.kt`). Without it a desktop's arrows and a phone's
Enter could combine into an answer neither person chose. The second device is refused and its card says
"Another device is answering this right now, so nothing was sent."

The old two-write fallback (navigation, then `\r` 150ms later — `PROMPT_SUBMIT_DELAY_MS`,
verified on 2.1.220: split that way `UP×5 + DOWN×N` then `\r` committed the option N steps
away, where ONE write committed the highlighted one) now only serves a `submitInput`
button from Android's native detector or an older build's saved state.

**The plan card** (`parser/plan-menu-parser.ts` + `state/plan-menu-driver.ts`, 2026-09-23)
builds its buttons from CC's REAL plan menu (its rows vary plan to plan; the old four
fixed buttons could APPROVE on "No, refine plan"). Each button types the digit printed on
its own row, after re-reading the screen and finding the same number and wording. The
feedback row is a live text box, so when the cursor sits there one up-arrow goes first
(its own write, confirmed); feedback is typed only into an empty box, and Enter only after
the box shows exactly that text. Unreadable → the card says so and points at terminal
view; it never falls back to positions. **Kept cards** (a card whose hook closed while
CC's menu may still be up) offer buttons only when the prompt on screen shows THIS call
(`parser/kept-card-binding.ts`); two asks with identical visible input cannot be told apart.

Guards: `desktop/tests/keystroke-diagnostic.test.ts`, `prompt-integration.test.ts`,
`prompt-card.test.tsx`, `startup-dialogs.test.ts`, `menu-answer-lock.test.ts`,
`plan-menu-parser.test.ts`, `plan-menu-driver.test.ts`, `kept-card-binding.test.ts`.
Protocol facts live in `docs/cc-dependencies.md` → "Ink menu option selection",
"Plan-approval menu" and "Startup dialogs"; re-probe on a CC version bump.
<!-- verify: {"path": "youcoded/desktop/src/main/menu-answer-lock.ts", "contains": "MENU_ANSWER_LEASE_MS = 20_000"} -->

## Invariants

- Don't reintroduce a 600ms enter-split in the desktop worker (echo observation makes it superfluous + timing-fragile).
- Don't atomic-write any `body + \r` longer than 56 bytes — the constants are version-coupled and can shift downward.
- Don't reintroduce bracketed-paste markers (`\x1b[200~...\x1b[201~`) on Windows (ConPTY mangles them).
- **`useSubmitConfirmation` is the second-line defense** — sends a bare `\r` only when `pending` stays set 8s after submit AND `canRetrySubmit()` passes: `attentionState==='ok'`, no awaiting-approval/running current-turn tools, no in-flight assistant turn, no uncompleted interactive prompt. `attentionState==='ok'` ALONE is not idle (normal mid-turn + while a permission/AskUserQuestion menu is up); gating on it alone auto-answered prompts. Don't gate on `!isThinking` (never clears if CC never got the message).
- **Never write to the PTY during a pending interaction** — CC's Ink select menu is LIVE while a hook permission card is up. Every automated writer consults `hasPendingInteraction`/`canRetrySubmit` or main-side `HookRelay.hasPendingPermission(sessionId)` (Android: `EventBridge.hasPendingPermission`). Deliberate menu-drivers (`state/prompt-input.ts` for PromptCard/TrustGate, `plan-menu-driver.ts` for the plan card, kept-card buttons, terminal-view xterm keystrokes) intentionally bypass; ToolCard itself no longer writes to the PTY. Fixed youcoded#110.
- **One sanitized string** — the optimistic bubble + PTY send both derive from `components/outgoing-message.ts`; the transcript confirms by content match (PTY send replaces newlines AND tabs with spaces — CC takes a typed tab as the Tab key and drops it, 2026-09-23). A newline-bearing bubble stayed `pending` forever + armed a stray retry `\r`.

## Diagnostics

- `YOUCODED_PTY_TRACE=1` → per-event trace at `~/.claude/youcoded-pty-trace-<pid>.log` (`IN`, `ATOMIC`, `CHUNK k=X/Y`, `ECHO_WAIT`, `ECHO_OK`, `ECHO_TIMEOUT … suppressing CR`, `CR after-echo`, `PASSTHROUGH`, `INPUT_ERROR`). Zero overhead when unset.
- `test-conpty/test-worker-submit.mjs` runs the actual forked `pty-worker.js` against real `claude`.
- `test-conpty/test-multiline-submit.mjs` runs `node-pty` directly (distinguishes CC behavior from worker regressions).
- `test-conpty/cc-snapshot.mjs` captures the empirical baseline (paste threshold, echo). `test-conpty/README.md` is the reusable methodology.
- Startup dialogs: `main/startup-dialog-log.ts` writes a `startup-dialog` line to `~/.claude/desktop.log` for every dialog Claude Code shows before a session starts, and a warning after a minute of waiting. `test-conpty/capture-startup-dialogs.mjs` captures the real dialogs in an isolated home (shared helpers: `cc-capture-lib.mjs`); `test-conpty/check-startup-drift.mjs --app` names any change, and `.github/workflows/cc-startup-drift.yml` runs it daily. Procedure: `docs/cc-dependencies.md` → "Startup dialogs".

## PTY resize (Windows) & ESC routing

- **`TerminalView.fitAndSync` dedups on unchanged cols/rows** before the resize IPC — ConPTY reflows + re-emits its buffer on every resize, and the ResizeObserver + `proposeDimensions()` fire spuriously (font load, jitter), so without dedup CC's Ink UI is re-emitted into xterm scrollback (duplicated chrome). The dedup is a closure (`lastCols`/`lastRows`) in the mount effect — keep it in the renderer, which owns "what dimensions should the PTY be." Android unaffected (no reflow on SIGWINCH).
- **ESC flows through `useEscClose` → chat-passthrough** (capture-phase `preventDefault` on a popped overlay; App bubble-phase reads `defaultPrevented` before forwarding `\x1b`). Returns when `viewMode==='terminal'` (xterm forwards ESC natively). Chat-to-PTY interrupt is single-byte — don't wrap it in the paste-splitter. Interrupt markers (`[Request interrupted by user]`) become `user-interrupt` events → `TRANSCRIPT_INTERRUPT` → `endTurn()`.

## Launch environment

- **Spawned `claude` must NOT inherit CC's session-identity env vars** (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, etc.). Launched from inside a CC session, the child believes it's nested — nested interactive CC writes NO top-level transcript, so the chat view stays permanently EMPTY (terminal view works, hooks fire — masking the cause). `pty-worker.js` case `'spawn'` DELETES those vars. Don't re-add a raw `...process.env` spread. `CLAUDE_DESKTOP_SESSION_ID`/`_PIPE` are ours, set fresh. Android unaffected. Shipped youcoded#106. Diagnostic signature: terminal view works + chat view empty + no `<session-id>*.jsonl` under `~/.claude/projects` even though `topics/`, `.gitbranch-`, `.session-stats-` sidecars exist. (`claude -p` is NOT a repro — print mode always writes a transcript.)
