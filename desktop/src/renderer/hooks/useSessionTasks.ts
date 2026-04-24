import { useCallback, useEffect, useMemo, useState } from 'react';
import { useChatState } from '../state/chat-context';
import { buildTasksById, TaskState } from '../state/task-state';

export const INACTIVE_STORAGE_KEY = 'youcoded-tasks-inactive-v1';

type InactiveMap = Record<string, string[]>;

interface Counts {
  running: number;
  pending: number;
  completed: number;
  inactive: number;
}

function readInactive(): InactiveMap {
  try {
    const raw = localStorage.getItem(INACTIVE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeInactive(map: InactiveMap): void {
  try {
    localStorage.setItem(INACTIVE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage full / unavailable — silently drop; the flag is a nice-to-have.
  }
}

/**
 * Session-scoped task derivation + local "marked inactive" overlay.
 *
 * Subscribes to the session's toolCalls Map via useChatState and derives
 * tasks using buildTasksById. Overlays a per-session `markedInactive` flag
 * backed by localStorage so users can dismiss stale open tasks from the chip.
 *
 * Auto-clears the inactive flag when a task transitions to `completed` — the
 * flag means "I'm tired of seeing this stale open task", not "I never want to
 * see this task". Once Claude closes it naturally, the concern is resolved.
 */
export function useSessionTasks(sessionId: string) {
  const session = useChatState(sessionId);
  const [inactiveMap, setInactiveMap] = useState<InactiveMap>(() => readInactive());

  const sessionInactive = useMemo(
    () => new Set(inactiveMap[sessionId] ?? []),
    [inactiveMap, sessionId],
  );

  // Derive tasks from the session's toolCalls (memoized on the Map ref).
  const derived = useMemo(() => buildTasksById(session.toolCalls), [session.toolCalls]);

  // Overlay markedInactive and sort by orderIndex ascending.
  const tasks = useMemo<TaskState[]>(() => {
    const out: TaskState[] = [];
    for (const t of derived.values()) {
      out.push({ ...t, markedInactive: sessionInactive.has(t.id) });
    }
    out.sort((a, b) => a.orderIndex - b.orderIndex);
    return out;
  }, [derived, sessionInactive]);

  // Auto-clear the inactive flag once a task completes. Inactive means "I'm
  // tired of seeing this stale open task" — when Claude closes it naturally,
  // the concern is resolved. Runs as a post-render effect so it doesn't
  // synchronously set state during the memo. The next render sees the updated
  // sessionInactive and the task's markedInactive flips to false.
  useEffect(() => {
    const toClear = tasks
      .filter(t => t.markedInactive && t.status === 'completed')
      .map(t => t.id);
    if (toClear.length === 0) return;
    setInactiveMap(prev => {
      const curr = new Set(prev[sessionId] ?? []);
      let changed = false;
      for (const id of toClear) { if (curr.delete(id)) changed = true; }
      if (!changed) return prev;
      const next = { ...prev };
      if (curr.size === 0) delete next[sessionId];
      else next[sessionId] = [...curr];
      writeInactive(next);
      return next;
    });
  }, [tasks, sessionId]);

  const counts = useMemo<Counts>(() => {
    let running = 0, pending = 0, completed = 0, inactive = 0;
    for (const t of tasks) {
      if (t.markedInactive) { inactive++; continue; }
      if (t.status === 'in_progress') running++;
      else if (t.status === 'completed' || t.status === 'deleted') completed++;
      else pending++; // undefined status counts as pending (just created)
    }
    return { running, pending, completed, inactive };
  }, [tasks]);

  const markInactive = useCallback((taskId: string) => {
    setInactiveMap(prev => {
      const curr = new Set(prev[sessionId] ?? []);
      curr.add(taskId);
      const next = { ...prev, [sessionId]: [...curr] };
      writeInactive(next);
      return next;
    });
  }, [sessionId]);

  const unhide = useCallback((taskId: string) => {
    setInactiveMap(prev => {
      const curr = new Set(prev[sessionId] ?? []);
      curr.delete(taskId);
      const next = { ...prev };
      if (curr.size === 0) delete next[sessionId];
      else next[sessionId] = [...curr];
      writeInactive(next);
      return next;
    });
  }, [sessionId]);

  // Cross-TAB storage sync only. The browser's storage event fires when ANOTHER
  // browsing context (different tab or window) writes to localStorage — NOT when
  // the current page writes. Two useSessionTasks instances in the same page are
  // NOT auto-synced by this listener. To avoid that, mount only ONE instance per
  // page and thread the derived state down (see App.tsx — single useSessionTasks
  // call at AppInner root, reused by StatusBar chip + OpenTasksPopup).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === INACTIVE_STORAGE_KEY) setInactiveMap(readInactive());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return { tasks, counts, markInactive, unhide };
}
