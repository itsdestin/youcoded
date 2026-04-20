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
