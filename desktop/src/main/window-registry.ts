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

interface WindowEntry {
  id: number;
  createdAt: number;
  label: string;
}

export class WindowRegistry extends EventEmitter {
  // id (BrowserWindow webContentsId) -> window entry
  private readonly windows = new Map<number, WindowEntry>();
  // sessionId -> owning window id
  private readonly ownership = new Map<string, number>();
  // Monotonic label counter. Never reused even after unregister, so a label
  // always identifies a distinct window within the app's lifetime.
  private labelCounter = 0;

  /** Register a new window. No-op if id already known. Emits 'changed' on success. */
  registerWindow(id: number, createdAt: number): void {
    if (this.windows.has(id)) return;
    this.labelCounter += 1;
    this.windows.set(id, {
      id,
      createdAt,
      label: `window ${this.labelCounter}`,
    });
    this.emit('changed');
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

  getOwner(sessionId: string): number | undefined {
    return this.ownership.get(sessionId);
  }

  /** Oldest-createdAt window is the leader. Undefined when no windows registered. */
  getLeaderId(): number | undefined {
    let leader: WindowEntry | undefined;
    for (const entry of this.windows.values()) {
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
   */
  getDirectory(
    resolver: (sessionId: string) => SessionInfo | undefined,
  ): WindowDirectory {
    const sortedEntries = Array.from(this.windows.values()).sort(
      (a, b) => a.createdAt - b.createdAt,
    );
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
