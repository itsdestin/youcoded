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

// Remote access batch 2 (§2): how long a transfer counts as "the copy is still arriving"
// for the remote snapshot. The inheriting window requests its first page as soon as it
// acquires the session (tens of milliseconds); 10 s leaves wide margin under load.
const PENDING_TRANSFER_MS = 10_000;
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
    // A window that closed before reading its inherited page leaves a mark that
    // would otherwise outlive it and mis-serve whoever inherits that id later.
    for (const [sessionId, winId] of this.inheritedByTransfer) {
      if (winId === id) {
        this.inheritedByTransfer.delete(sessionId);
        this.transferMarkedAt.delete(sessionId);
      }
    }
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

  /** Release ownership of a session (if any). Always emits 'changed'. */
  releaseSession(sessionId: string): void {
    this.ownership.delete(sessionId);
    // Called when the session exits or is destroyed: nothing will read its first page
    // again, so a transfer gap left behind would degrade the remote snapshot for good.
    this.inheritedByTransfer.delete(sessionId);
    this.transferMarkedAt.delete(sessionId);
    this.emit('changed');
  }

  // sessionId -> Set of subscriber windowIds. Separate from `ownership`:
  // a window can subscribe to a session it does NOT own (e.g. the buddy
  // mirrors the active session while main still owns it). Session events
  // are routed to owner UNION subscribers in the IPC router.
  private readonly subscriptions = new Map<string, Set<number>>();

  /** Add a subscription. Idempotent. Emits 'changed' on mutation. Throws if window unknown. */
  subscribe(sessionId: string, windowId: number): void {
    if (!this.windows.has(windowId)) {
      throw new Error(`WindowRegistry: unknown window ${windowId}`);
    }
    let set = this.subscriptions.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscriptions.set(sessionId, set);
    }
    const before = set.size;
    set.add(windowId);
    if (set.size !== before) this.emit('changed');
  }

  /** Remove a subscription. Idempotent. Emits 'changed' on mutation. */
  unsubscribe(sessionId: string, windowId: number): void {
    const set = this.subscriptions.get(sessionId);
    if (!set) return;
    const removed = set.delete(windowId);
    if (set.size === 0) this.subscriptions.delete(sessionId);
    if (removed) this.emit('changed');
  }

  /** Read-only view of subscribers for a session. */
  getSubscribers(sessionId: string): Set<number> {
    const set = this.subscriptions.get(sessionId);
    return set ? new Set(set) : new Set();
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

  // sessionId -> the window that inherited it through an ownership TRANSFER and
  // has not yet read its first page of history.
  //
  // Why this exists: TRANSCRIPT_PAGE's first page deliberately stops at the
  // transcript watcher's startOffset, because everything after that byte was
  // already delivered to the requester over the live TRANSCRIPT_EVENT stream.
  // That contract holds for a window that has been listening since the watcher
  // attached — and is FALSE for a window that just inherited the session, which
  // received none of it. Such a window used to render history that ended at the
  // moment the session was resumed, silently missing every message since
  // (Destin, 2026-09-03: "the latest message shown is not actually the latest").
  // A marked session's first page reads to EOF instead. One-shot: consumed by
  // the first page read, so paging further back behaves normally.
  private readonly inheritedByTransfer = new Map<string, number>();

  // When each mark was set — the remote snapshot counts a mark as "pending" only for a
  // bounded time (see isPendingTransfer). The one-shot read-to-EOF mark itself never
  // expires.
  private readonly transferMarkedAt = new Map<string, number>();

  /** Mark a session as inherited by `windowId`, so its first page reads to EOF. */
  markInheritedByTransfer(sessionId: string, windowId: number, now: number = Date.now()): void {
    this.inheritedByTransfer.set(sessionId, windowId);
    this.transferMarkedAt.set(sessionId, now);
  }

  /**
   * True exactly once, for the window that inherited this session — and clears
   * the mark. Any other window (or a second read) gets false and today's
   * stop-at-startOffset behaviour.
   */
  consumeInheritedByTransfer(sessionId: string, windowId: number): boolean {
    if (this.inheritedByTransfer.get(sessionId) !== windowId) return false;
    this.inheritedByTransfer.delete(sessionId);
    this.transferMarkedAt.delete(sessionId);
    return true;
  }

  /**
   * Remote access batch 2 (design §2): is this session's copy in its new window still
   * arriving? A NON-consuming read of the same mark consumeInheritedByTransfer spends —
   * the remote snapshot asks it on every connect and must never steal the mark that
   * makes the inheriting window's first page read to EOF. While it is set, that
   * window's copy stops at the moment the session was resumed, so the snapshot omits
   * the session and says it is degraded rather than hand a phone a stale copy.
   */
  //
  // BOUNDED (T3 review, 3): the mark only has to cover the moments between the transfer
  // and the inheriting window asking for its first page — from then on that window's own
  // `history.loading`, which the exporter reports, covers the incomplete copy through
  // every retry. A session whose page can never resolve (a shell, an exited session with
  // no transcript) re-marks on each failed read and then gives up, and an unbounded mark
  // degraded every snapshot for the life of that window.
  isPendingTransfer(sessionId: string, now: number = Date.now()): boolean {
    const markedAt = this.transferMarkedAt.get(sessionId);
    return this.inheritedByTransfer.has(sessionId) && markedAt !== undefined && now - markedAt < PENDING_TRANSFER_MS;
  }

  /**
   * Move a session from the window that owns it to another, and mark the gap. Returns
   * false (and changes nothing) when `fromWindowId` is not the current owner — the
   * race protection main.ts's transferOwnership relied on. One method so the pending
   * state the remote snapshot reads is produced by the real transfer path, never by a
   * second copy of its two steps.
   */
  transferSession(sessionId: string, fromWindowId: number, toWindowId: number, now: number = Date.now()): boolean {
    if (this.ownership.get(sessionId) !== fromWindowId) return false;
    this.assignSession(sessionId, toWindowId);
    this.markInheritedByTransfer(sessionId, toWindowId, now);
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
