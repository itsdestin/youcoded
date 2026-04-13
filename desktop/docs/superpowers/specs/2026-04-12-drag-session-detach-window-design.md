# Drag Session to Detach Into New Window — Design

**Date:** 2026-04-12
**Status:** Design approved, pending implementation plan
**Scope:** Desktop only (Electron). Android unaffected.

## Summary

Allow the user to drag a session pill out of `SessionStrip` to spawn a new OS window owning that session, and to drag it back into another window's strip to re-dock. Add a "Launch in New Window" toggle to the session-creation and resume menus as a non-drag entry point to the same machinery.

Peer window model: every window is a full copy of the app shell with its own `SessionStrip`, its own reducer, and its own set of owned sessions. No "primary" window.

## Goals

- Drag detach: mousedown on pill + drag past window bounds → new window spawns at cursor with the session.
- Drag re-dock: drag pill from window B's strip, drop into window A's strip → session moves to A; B auto-closes if empty.
- "Launch in New Window" toggle in session creation + resume dialogs.
- Cross-window session visibility: Shift-hold switcher shows local sessions first, then a grouped "Sessions in other windows" section.
- Singleton subsystems (PartyKit lobby, future tray) run in a designated leader window; leadership transfers on close.

## Non-Goals

- Drag-to-rearrange pill order across windows (within-window reorder is a separate feature).
- "Merge all windows" command.
- Restoring detached peer windows across app restarts — on relaunch, all sessions come up in one window.
- Re-dock by dropping on window body (strip-only drop target).
- Right-click menu for detach.
- Remote-access browser clients participating in the detach model — they always show the full session list, unchanged from today.

## Architecture

### Peer window model

Electron spawns N `BrowserWindow` instances, each running the full React app. Main process owns:

- `SessionManager` — PTY workers, session lifecycle (unchanged)
- `TranscriptWatcher`, `HookRelay`, `RemoteServer` — unchanged, continue to run in main
- **New: `WindowRegistry`** — source of truth for window ownership. Maps `sessionId → windowId`, tracks `leaderWindowId`, broadcasts directory updates.

Each renderer retains its own reducer and `TerminalRegistry`. A renderer only holds state for sessions its window owns.

### Event routing

Today: main emits `transcript:event`, `hook:event`, `pty:output`, `permission:request` via webContents to a single renderer. The implicit assumption is "one renderer."

Change: all per-session emits go through a `routeToOwner(sessionId, channel, payload)` helper in main that looks up the owning window via `WindowRegistry` and calls that window's `webContents.send()`. Not broadcast. Not forwarded to other windows.

Events that are cross-window by nature (window directory, leader changes, theme, settings) use new broadcast channels that main sends to all windows.

### State hydration on detach

The reducer is deterministic from transcript events. Window B rebuilds session state from the transcript JSONL rather than serializing the source reducer's in-memory state.

Sequence for detach of session X from window A to new window B:

1. Main creates `BrowserWindow` B at cursor coords, marks it initialized-but-session-less.
2. Main updates `WindowRegistry`: `X → B`. Emits:
   - To A: `SESSION_OWNERSHIP_LOST { sessionId: X }`. A removes X from its timeline, drops the `TerminalRegistry` entry, removes the pill.
   - To B: `SESSION_OWNERSHIP_ACQUIRED { sessionId: X, sessionInfo }`. B creates the timeline slot and marks X active.
3. B requests `transcript:replay-from-start { sessionId: X }`. `TranscriptWatcher.getHistory(X)` reads JSONL from disk and streams events to B; B's reducer processes them through the existing `TRANSCRIPT_*` actions.
4. **Event gap handling:** between ownership transfer and replay completion, main buffers live `transcript:event` / `hook:event` / `pty:output` for session X in a per-session queue. The queue flushes to B immediately after B acks replay done.
5. `attentionState` starts at `'ok'` in B — it's derived from the xterm screen buffer, not transcript-persisted. The 1s classifier re-evaluates on next tick. Acceptable flicker.

Same flow applies to re-dock (source window releases, target window acquires and hydrates).

## Detach Gesture

**Trigger:** pointerdown on a session pill; pointermove exceeds a 40px threshold outside the strip's bounding box.

**Inside-window drag behavior:**
- Render a ghost pill at cursor.
- Dim the original pill.
- Remaining pills shift to close the gap via the existing `packSessions` layout.

**Cross-window detection:**
- Use pointer events with `element.setPointerCapture(pointerId)` on mousedown. Required on Windows to keep pointer events firing after the cursor leaves the window (macOS works without this).
- When pointermove reports coordinates outside window bounds, fire IPC `session:detach-start { sessionId, screenX, screenY }`.

**Spawn:**
- Main creates a new `BrowserWindow` at `(screenX - offset, screenY - offset)` so the cursor lands over the new window's strip where the pill will appear.
- Main transfers ownership via the hydration flow above.
- Source window cleans up its ghost.

**No cross-window visual during the outside-window phase** — once the cursor leaves the source window's bounds, we don't render a preview. The new window appearing under the cursor is the drop feedback.

## Re-Dock Gesture

**Trigger:** pointerdown on pill in window B, drag, release inside window A's SessionStrip bounds.

**Cross-window cursor tracking:**

OS delivers pointer events only to the active window. While dragging from B, window A cannot see pointer events. Solution:

1. Window B emits `session:drag-started { sessionId }` on drag start.
2. Main starts a ~30Hz ticker that calls `screen.getCursorScreenPoint()` and broadcasts `cross-window-cursor { screenX, screenY }` to all windows.
3. Each window converts to local coords, checks if the cursor is over its `SessionStrip` bounding box. If yes, show a highlight/drop-zone indicator.
4. On pointerup in B:
   - If cursor is over another window's strip, B sends `session:drag-dropped { sessionId, targetWindowId, insertIndex }`.
   - If cursor is over no window's strip, B sends `session:detach-start { screenX, screenY }` — treated as a new-window detach.
5. Main stops the cursor ticker at pointerup.

**Ownership transfer:** identical to detach — source releases, target acquires and hydrates via transcript replay.

**Empty-source cleanup:** if window B ends up with zero sessions after a detach or re-dock AND there is at least one other peer window open, main closes B silently. If B is the only window, it stays open in the empty-state landing view.

## Session Creation and Resume: "Launch in New Window" Toggle

Two entry points get a new checkbox/switch:

- **Session creation form** (new session dialog) — checkbox *Launch in new window*.
- **Resume browser** (`ResumeBrowser.tsx`) — same checkbox on each resume entry's action row, or a global toggle at the top of the panel.

When checked, after `SessionManager.createSession(...)` resolves, main immediately performs the same "spawn new window + transfer ownership" path used by drag-detach. Zero new lifecycle code; different entry point into the existing machinery.

Hidden on Android (WebView host is single-window).

## Window Close Behavior

- **Close window with active sessions** → prompt: *"This window has N sessions. Close anyway? [Close & kill sessions] [Cancel]"*. Confirm kills all owned sessions.
- **Close empty non-last window** → no prompt, just closes.
- **Close last window** → normal Electron behavior (quit on Windows/Linux, stay open on macOS).
- **Auto-close on emptied-by-detach** → close silently if any other window exists.

## Session Switcher (Shift-hold dropdown)

Current: single list of all sessions. New: two groups.

```
┌─── Sessions in this window ───┐
│ ● destincode        (active)  │
│ ○ destinclaude                │
├─── Sessions in other windows ─┤
│ ○ marketplace   → window 2    │
│ ○ themes-dev    → window 3    │
└───────────────────────────────┘
```

- Local group = sessions owned by this window (normal behavior).
- Remote group = sessions from `WINDOW_DIRECTORY_UPDATED` events. Each entry shows its owning window label and a subtle arrow.
- Selecting a local entry = today's behavior.
- Selecting a remote entry = IPC `window:focus-and-switch { windowId, sessionId }`. Main calls `BrowserWindow.focus()` on the target window and sends it a `SESSION_SWITCHED` action to make that session active.

Window labels: `window 2`, `window 3`, etc., assigned by main in creation order. (A future enhancement could let users name windows.)

## Singleton Coordination

Not all renderer-side subsystems can safely run in every window.

### Leader election

- Main tracks `leaderWindowId = first spawned window`.
- On leader close, promote next-oldest window; broadcast `LEADER_CHANGED { leaderWindowId }`.
- Renderers read `isLeader` from state and gate leader-only subsystems on it.

### What runs only in the leader

- **`usePartyLobby`** — PartyKit lobby connection. Per-user presence, not per-window. Running in multiple windows would double-count the user as "online."
- Future tray icon / system notifications if added.

### What stays per-window

- **`usePartyGame`** — per-game socket. Running a game in a non-leader window is fine.
- Reducer, `TerminalRegistry`, attention classifier, permission UI.

### What stays in main (unchanged)

- `RemoteServer`, `TranscriptWatcher`, `HookRelay`, `SessionManager`.

## Cross-Window Broadcasts

New IPC event channels:

| Event | Direction | Purpose |
|---|---|---|
| `SESSION_OWNERSHIP_ACQUIRED` | main → specific renderer | Tell target window it now owns a session (with `SessionInfo`) |
| `SESSION_OWNERSHIP_LOST` | main → specific renderer | Tell source window to release a session |
| `WINDOW_DIRECTORY_UPDATED` | main → all renderers | `{ windows: [{ id, label, sessionIds }] }` — drives switcher's remote group |
| `LEADER_CHANGED` | main → all renderers | Start/stop leader-gated subsystems |
| `THEME_CHANGED` | any renderer → main → all renderers | Live theme sync across windows |
| `SETTINGS_CHANGED` | any renderer → main → all renderers | Remote config, skill list, chip set, etc. |
| `cross-window-cursor` | main → all renderers | Active only during cross-window drag |
| `session:detach-start` | renderer → main | Cursor left window bounds during drag |
| `session:drag-started` | renderer → main | Drag initiated; begin cursor broadcast |
| `session:drag-dropped` | renderer → main | Drop landed in another window's strip |
| `window:focus-and-switch` | renderer → main | Switcher selected a remote session |
| `transcript:replay-from-start` | renderer → main | Request full transcript history for a session |

## Edge Cases

- **Permission prompt on a detached session** — routed via ownership registry. No double-prompt.
- **Drag into minimized window** — impossible because its strip isn't visible, so cursor-over-strip never matches. Falls back to new-window detach on drop.
- **Drag between monitors** — `screen.getCursorScreenPoint()` is OS-level and monitor-agnostic. Works natively.
- **Same-session-ID races** — main is the single writer of `WindowRegistry`. Any IPC referencing a session no longer owned by the claimed source window is rejected. IPC is serialized to main, so no concurrent mutation.
- **Window bounds persistence** — each window persists its own bounds in localStorage. On app relaunch, only the first-launched window restores bounds. Detached windows do not survive app restart; their sessions come up in the single restored window.
- **Android** — does not apply. `remote-shim.ts` does not implement detach IPC. "Launch in new window" toggle hidden.
- **Overlay layers** — per-window stacks. No cross-window overlay coordination needed.
- **Header chat/terminal toggle placement** — platform-conditional via `navigator.platform`, works per-window identically.

## File Changes (indicative, not the implementation plan)

**Main process (new or modified):**
- `src/main/window-registry.ts` — new. Ownership map, leader tracking, directory broadcast.
- `src/main/main.ts` — `BrowserWindow` creation refactored to use `WindowRegistry`; IPC handlers added for detach / drag / focus-and-switch.
- `src/main/ipc-handlers.ts` — wrap per-session emits with `routeToOwner(sessionId, ...)`.
- `src/main/transcript-watcher.ts` — ensure `getHistory(sessionId)` can stream all events on demand (should already exist; verify).
- `src/main/hook-relay.ts` — `permission:request` routing via ownership registry.

**Renderer (new or modified):**
- `src/renderer/components/SessionStrip.tsx` — drag detach + drop-target logic; ghost pill; drop-zone indicator; two-group switcher.
- `src/renderer/App.tsx` — reducer cases for `SESSION_OWNERSHIP_ACQUIRED` / `_LOST`; leader state; window directory state.
- `src/renderer/state/chat-reducer.ts` — new actions for ownership gained/lost.
- `src/renderer/hooks/usePartyLobby.ts` — gate on `isLeader`.
- `src/renderer/remote-shim.ts` — stub detach IPC (no-op on Android).
- `src/renderer/preload.ts` — new IPC channel constants (must mirror main).
- Session creation dialog + `ResumeBrowser.tsx` — "Launch in new window" toggle.

**Shared:**
- `src/shared/types.ts` — `WindowInfo`, `WindowDirectoryEntry`, new IPC payload types.

## Open Questions

None at design time — all forks resolved with the user. Implementation plan will surface ordering and test strategy.
