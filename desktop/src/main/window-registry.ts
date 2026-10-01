// WindowRegistry tracks BrowserWindows and which sessions they own.
//
// Why this exists: with drag-to-detach, a session can move between windows.
// The main process needs to know which window owns each session so it can
// route session-scoped IPC events (pty output, transcript updates) to only
// the correct renderer — not broadcast them everywhere.
//
// The registry also elects a "leader" window (the oldest one) which is
// responsible for global concerns (registry writes, marketplace refresh,
// etc.) that should happen exactly once even when multiple windows are open.

import { EventEmitter } from 'events';
import type {
  SessionInfo,
  WindowDirectory,
  WindowDirectoryEntry,
  WindowInfo,
} from '../shared/types';

export type WindowKind = 'main' | 'buddy';

const MAX_SESSION_ID_LENGTH = 256;

interface WindowEntry {
  id: number;
  createdAt: number;
  label: string;
  // Buddy windows (floating mascot + compact chat) are registered so the
  // subscription system works, but they must NOT appear as independent
  // windows in the switcher directory or be eligible for leadership. See
  // getDirectory / getLeaderId below.
  kind: WindowKind;
}

export class WindowRegistry extends EventEmitter {
  // id (BrowserWindow webContentsId) -> window entry
  private readonly windows = new Map<number, WindowEntry>();
  // sessionId -> owning window id
  private readonly ownership = new Map<string, number>();
  // Monotonic label counter. Never reused even after unregister, so a label
  // always identifies a distinct window within the app's lifetime.
  // Only incremented for main windows — buddy windows are invisible to the
  // switcher so they don't need a "window N" label.
  private labelCounter = 0;

  /**
   * Register a new window. No-op if id already known. Emits 'changed' on success.
   * `kind` defaults to 'main' for backwards compatibility; pass 'buddy' for
   * the floater windows so they're excluded from directory/leader lookups.
   */
  registerWindow(id: number, createdAt: number, kind: WindowKind = 'main'): void {
    if (this.windows.has(id)) return;
    let label: string;
    if (kind === 'main') {
      this.labelCounter += 1;
      label = `window ${this.labelCounter}`;
    } else {
      label = 'buddy';
    }
    this.windows.set(id, { id, createdAt, label, kind });
    this.emit('changed');
  }

  /** Look up the kind of a registered window. Undefined if unknown. */
  getKind(id: number): WindowKind | undefined {
    return this.windows.get(id)?.kind;
  }

  /**
   * Unregister a window and release any sessions it owned.
   * Emits exactly one 'changed' event even when multiple sessions are released
   * as a side effect — callers should treat it as a single atomic mutation.
   */
  unregisterWindow(id: number): void {
    if (!this.windows.has(id)) return;
    this.windows.delete(id);
    // Release any sessions owned by this window WITHOUT emitting per-release,
    // so consumers only see one 'changed' for the whole unregister.
    for (const [sessionId, ownerId] of this.ownership) {
      if (ownerId === id) this.ownership.delete(sessionId);
    }
    // Release subscriptions too — buddy windows subscribe without owning.
    this.releaseAllSubscriptionsForWindow(id, /* silent */ true);
    // A closed window shows nothing: drop its selection and, if it was the last one
    // focused, fall back to the leader for the remote snapshot's focus.
    this.selected.delete(id);
    if (this.lastFocusedMain === id) this.lastFocusedMain = undefined;
    this.emit('changed');
  }

  /** Assign ownership of a session to a window. Throws if window unknown. */
  assignSession(sessionId: string, windowId: number): void {
    if (!this.windows.has(windowId)) {
      throw new Error(`WindowRegistry: unknown window ${windowId}`);
    }
    this.ownership.set(sessionId, windowId);
    this.emit('changed');
  }

  /**
   * Release ownership of a session (if any). Always emits 'changed'.
   *
   * WHY the phones' watches SURVIVE this (one-core R5-3): a window letting go of a session says nothing about the
   * phones watching it. Before per-session delivery nothing read a phone's watch, so wiping the whole set here was
   * harmless; now a phone's watch is its ONLY way to receive the session, and a release that wiped it would silently
   * stop that phone's chat (and its terminal) without the phone ever being told. Only windows' subscriptions go.
   * A session that has truly ended calls `endSession` instead.
   */
  releaseSession(sessionId: string): void {
    this.ownership.delete(sessionId);
    // WHY (2026-09-16, per-session-maps investigation): a dead session's
    // subscriber set used to survive until the subscribing window closed —
    // the buddy window subscribes without owning, so every session it ever
    // mirrored left an entry behind. The WINDOW part of the set is still dropped here; the phone part is kept (see above).
    const set = this.subscriptions.get(sessionId);
    if (set) {
      for (const id of [...set]) if (!this.sockets.has(id)) set.delete(id);
      if (set.size === 0) this.subscriptions.delete(sessionId);
    }
    this.emit('changed');
  }

  /**
   * The session is over (its process exited or it was destroyed): forget every audience member's interest in it,
   * windows and phones. WHY separate from `releaseSession` (one-core R5-3): a phone is told the session ended by the
   * global `session:destroyed` push and drops its own watch; a watch left behind here would be a leak, and worse, would
   * make a session id that comes back (a native session is keyed by the id it resumes) deliver its NEW record's events
   * to a phone that never filled it.
   */
  endSession(sessionId: string): void {
    this.subscriptions.delete(sessionId);
    this.releaseSession(sessionId);
  }

  // sessionId -> Set of subscriber windowIds. Separate from `ownership`:
  // a window can subscribe to a session it does NOT own (e.g. the buddy
  // mirrors the active session while main still owns it). Session events
  // are routed to owner UNION subscribers in the IPC router.
  private readonly subscriptions = new Map<string, Set<number>>();

  /** Add a subscription. Idempotent. Emits 'changed' on mutation. Throws if window unknown. */
  subscribe(sessionId: string, windowId: number): void {
    // WHY sockets too (one-core R5-1): a phone's watch is the same "this audience member wants this
    // session" fact a buddy window's subscribe is. A socket is not a window, so its changes never emit
    // 'changed' (that rebroadcasts the window directory to every renderer).
    const isSocket = this.sockets.has(windowId);
    if (!isSocket && !this.windows.has(windowId)) {
      throw new Error(`WindowRegistry: unknown window ${windowId}`);
    }
    let set = this.subscriptions.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscriptions.set(sessionId, set);
    }
    const before = set.size;
    set.add(windowId);
    if (set.size !== before && !isSocket) this.emit('changed');
  }

  /** Remove a subscription. Idempotent. Emits 'changed' on mutation. */
  unsubscribe(sessionId: string, windowId: number): void {
    const set = this.subscriptions.get(sessionId);
    if (!set) return;
    const removed = set.delete(windowId);
    if (set.size === 0) this.subscriptions.delete(sessionId);
    if (removed && !this.sockets.has(windowId)) this.emit('changed');
  }

  /** Read-only view of subscribers for a session. */
  getSubscribers(sessionId: string): Set<number> {
    // WINDOWS only: callers (sendForSession, the remote snapshot's owner pick) treat every id here as a
    // webContents id. Phones that watch a session are read through getSocketWatchers.
    const set = this.subscriptions.get(sessionId);
    const out = new Set<number>();
    if (set) for (const id of set) if (!this.sockets.has(id)) out.add(id);
    return out;
  }

  /** Phones watching this session: the delivery filter for every session-scoped push and for terminal output (R5-3). */
  getSocketWatchers(sessionId: string): number[] {
    const set = this.subscriptions.get(sessionId);
    return set ? [...set].filter((id) => this.sockets.has(id)) : [];
  }

  /**
   * Remove a window from every subscription.
   * @param silent - if true, suppresses the 'changed' emission so callers
   *                 that want to bundle it into a larger mutation (e.g.
   *                 unregisterWindow) can emit exactly one event.
   */
  releaseAllSubscriptionsForWindow(windowId: number, silent = false): void {
    let mutated = false;
    for (const [sid, set] of this.subscriptions) {
      if (set.delete(windowId)) mutated = true;
      if (set.size === 0) this.subscriptions.delete(sid);
    }
    if (mutated && !silent) this.emit('changed');
  }

  getOwner(sessionId: string): number | undefined {
    return this.ownership.get(sessionId);
  }

  // Phones (remote sockets) as audience members, with NEGATIVE ids so they can never collide with a
  // webContents id. WHY (2026-10-01 one-core R5-1, seam S6): "who wants this session's events" used to be
  // two lists — this registry for windows and RemoteServer.clients for phones — and the ~15 paired
  // sendForSession + broadcast call sites were exactly where they drifted. Sockets are NOT windows: they are
  // not in `windows`, so the directory, the leader election and getWindowIds never see them, and joining or
  // leaving never emits 'changed'.
  private readonly sockets = new Set<number>();

  registerSocket(id: number): void {
    if (!Number.isInteger(id) || id >= 0) throw new Error(`WindowRegistry: a socket id must be a negative integer, got ${id}`);
    this.sockets.add(id);
  }

  /** A phone left: drop it and every subscription it held (silently — it was never a window). */
  unregisterSocket(id: number): void {
    if (!this.sockets.delete(id)) return;
    for (const [sid, set] of this.subscriptions) {
      set.delete(id);
      if (set.size === 0) this.subscriptions.delete(sid);
    }
  }

  isSocket(id: number): boolean { return this.sockets.has(id); }
  getSocketIds(): number[] { return Array.from(this.sockets); }

  /**
   * Who a session-scoped push goes to. Windows: the owner plus subscribers; when there are none the push
   * falls back to the primary window (the unowned-session rule sendForSession always had). Sockets: the
   * phones that have OPENED the session (session:open subscribes them).
   *
   * WHY watchers and not every phone (one-core R5-2): a phone's screen is filled from the record as of an event
   * number, so a push that reached it BEFORE it opened the session would be applied to a session with no history and
   * then overlap the fill. A phone watches only the conversation on its screen and a few it looked at lately (R5-3,
   * `session:open` starts a watch, `session:unwatch` ends it), so everything else is simply not sent to it.
   */
  resolveAudience(sessionId: string): { windowIds: number[]; socketIds: number[]; fallbackToPrimary: boolean } {
    const windowIds = new Set<number>();
    const ownerId = this.ownership.get(sessionId);
    if (ownerId != null) windowIds.add(ownerId);
    for (const subId of this.getSubscribers(sessionId)) windowIds.add(subId);
    return { windowIds: [...windowIds], socketIds: this.getSocketWatchers(sessionId), fallbackToPrimary: windowIds.size === 0 };
  }

  /**
   * Move a session from the window that owns it to another. Returns false (and changes
   * nothing) when `fromWindowId` is not the current owner — the race protection main.ts's
   * transferOwnership relies on.
   *
   * WHY no "inherited" mark any more (one-core R5-2): the target window used to be marked so its first
   * page read to the end of the file (it missed the live stream), and the remote snapshot skipped the
   * session until that page was read. Every screen now fills through `session:open`, which always reads
   * to the end of the file and carries the record's recent past, so there is nothing to mark.
   */
  transferSession(sessionId: string, fromWindowId: number, toWindowId: number): boolean {
    if (this.ownership.get(sessionId) !== fromWindowId) return false;
    this.assignSession(sessionId, toWindowId);
    return true;
  }

  // Remote access batch 2 (design §2, R2): which session each MAIN window shows, as
  // reported by its renderer (session:selected), and which main window was focused
  // last. Nothing else under main/ knows a window's selection, and a phone connecting
  // for the first time opens what the desktop is showing.
  //
  // LAST focused, not currently focused: while someone is using the phone, no desktop
  // window has focus at all, and BrowserWindow.getFocusedWindow() would always be null.
  // Selection changes do not emit 'changed' — that event rebroadcasts the directory to
  // every renderer, and nothing there depends on another window's selection.
  private readonly selected = new Map<number, string>();
  private lastFocusedMain: number | undefined;

  setSelectedSession(windowId: number, sessionId: string | null): void {
    if (this.windows.get(windowId)?.kind !== 'main') return;
    // A renderer can send anything; no session id is this long, and the value rides every
    // snapshot and session:destroyed to phones.
    if (sessionId && sessionId.length > MAX_SESSION_ID_LENGTH) return;
    if (sessionId) this.selected.set(windowId, sessionId);
    else this.selected.delete(windowId);
  }

  noteFocused(windowId: number): void {
    if (this.windows.get(windowId)?.kind === 'main') this.lastFocusedMain = windowId;
  }

  /** The last-focused main window's selection, else the leader's, else null. */
  getFocusSessionId(): string | null {
    if (this.lastFocusedMain !== undefined) {
      const sel = this.selected.get(this.lastFocusedMain);
      if (sel) return sel;
    }
    const leader = this.getLeaderId();
    return leader !== undefined ? this.selected.get(leader) ?? null : null;
  }

  /** Main (non-buddy) window ids, oldest first — the windows that hold chat copies. */
  getMainWindowIds(): number[] {
    return Array.from(this.windows.values())
      .filter((e) => e.kind === 'main')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((e) => e.id);
  }

  /**
   * Oldest-createdAt MAIN window is the leader. Undefined when no main
   * windows registered. Buddy windows are never eligible for leadership —
   * responsibilities like "PartyKit lobby singleton" and "primary-window
   * fallback for unowned sessions" only make sense on a real main window.
   */
  getLeaderId(): number | undefined {
    let leader: WindowEntry | undefined;
    for (const entry of this.windows.values()) {
      if (entry.kind !== 'main') continue;
      if (!leader || entry.createdAt < leader.createdAt) leader = entry;
    }
    return leader?.id;
  }

  getWindowIds(): number[] {
    return Array.from(this.windows.keys());
  }

  sessionsForWindow(windowId: number): string[] {
    const out: string[] = [];
    for (const [sessionId, ownerId] of this.ownership) {
      if (ownerId === windowId) out.push(sessionId);
    }
    return out;
  }

  /**
   * Build a window directory snapshot ordered by createdAt ascending. For each
   * window, invokes the resolver per owned sessionId and keeps only those that
   * return a defined SessionInfo (stale/closed sessions silently drop out).
   *
   * Buddy windows are excluded: the directory drives the switcher's "Sessions
   * in other windows" group, and a floating buddy is not "another window"
   * from the user's point of view. Buddy windows remain registered so the
   * subscription system works — they just aren't visible here.
   */
  getDirectory(
    resolver: (sessionId: string) => SessionInfo | undefined,
  ): WindowDirectory {
    const sortedEntries = Array.from(this.windows.values())
      .filter((e) => e.kind === 'main')
      .sort((a, b) => a.createdAt - b.createdAt);
    const windows: WindowDirectoryEntry[] = sortedEntries.map((entry) => {
      const info: WindowInfo = {
        id: entry.id,
        label: entry.label,
        createdAt: entry.createdAt,
      };
      const sessions: SessionInfo[] = [];
      for (const sessionId of this.sessionsForWindow(entry.id)) {
        const resolved = resolver(sessionId);
        if (resolved) sessions.push(resolved);
      }
      return { window: info, sessions };
    });
    return {
      leaderWindowId: this.getLeaderId() ?? -1,
      windows,
    };
  }
}
