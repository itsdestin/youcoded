import { ipcMain, WebContents } from 'electron';
import type { SerializedChatState } from '../renderer/state/chat-types';
import type { WindowRegistry } from './window-registry';

const EXPORT_CHANNEL = 'chat:export-snapshot';
const RESPONSE_CHANNEL = 'chat:snapshot-response';
const TIMEOUT_MS = 2000;

type SnapshotTarget = Pick<WebContents, 'send' | 'isDestroyed'>;
interface WindowAnswer {
  answered: boolean;
  snapshot: SerializedChatState;
  /** Sessions whose history this window was still fetching — its copy is incomplete. */
  loadingSessionIds: string[];
}
const UNANSWERED: WindowAnswer = { answered: false, snapshot: { sessions: [] }, loadingSessionIds: [] };

/**
 * Ask one renderer window for its chat state. Resolves "unanswered" on timeout, on a
 * send that throws, and on a window that reports its own serialization failed
 * (`degraded`) — in all three this window's copies cannot be trusted.
 */
function askWindow(target: SnapshotTarget, timeoutMs: number): Promise<WindowAnswer> {
  const requestId = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (answer: WindowAnswer) => {
      if (settled) return;
      settled = true;
      ipcMain.off(RESPONSE_CHANNEL, onResponse);
      if (timer) clearTimeout(timer);
      resolve(answer);
    };
    const onResponse = (_e: unknown, payload: { requestId: string; snapshot?: SerializedChatState; loadingSessionIds?: unknown }) => {
      if (!payload || payload.requestId !== requestId) return;
      const snap = payload.snapshot;
      if (!snap || !Array.isArray(snap.sessions) || snap.degraded) { finish(UNANSWERED); return; }
      const loading = Array.isArray(payload.loadingSessionIds)
        ? payload.loadingSessionIds.filter((x): x is string => typeof x === 'string')
        : [];
      finish({ answered: true, snapshot: snap, loadingSessionIds: loading });
    };
    ipcMain.on(RESPONSE_CHANNEL, onResponse);
    timer = setTimeout(() => {
      console.warn(`[chat-snapshot] a window did not answer the export within ${timeoutMs}ms`);
      finish(UNANSWERED);
    }, timeoutMs);
    try {
      target.send(EXPORT_CHANNEL, requestId);
    } catch (err) {
      console.error('[chat-snapshot] send failed:', err);
      finish(UNANSWERED);
    }
  });
}

export interface MergedSnapshotDeps {
  registry: WindowRegistry;
  webContentsFor: (windowId: number) => SnapshotTarget | null;
  /** main.ts's first window while it lives: where an unowned session's events go. */
  fallbackWindowId: () => number | undefined;
  /** Every session the host runs, so one no window answered for is still counted. */
  knownSessionIds: () => string[];
  timeoutMs?: number;
}

/**
 * The chat state a remote client hydrates from, built from EVERY main window
 * (remote access batch 2, design §2, contract R1).
 *
 * WHY every window and merge by owner: this used to ask the first window only. A
 * session dragged into a second window reached the phone stale or empty — every
 * window seeds a key for every session, but only the owner receives its events — and
 * once the first window closed the answer was `{ sessions: [] }` with no sign
 * anything was missing. Now all windows are asked in parallel (one shared budget:
 * every request starts together), and each session is taken from the window its
 * events are routed to: the owner; for an unowned session the first window while it
 * lives (where main.ts routes those events), else the leader.
 *
 * A session is OMITTED and the snapshot marked `degraded` when that window did not
 * answer, when a transfer into it has not been read yet (registry.isPendingTransfer),
 * or when the window reports its history still loading. The phone keeps its own copy
 * of an omitted session (the reducer's per-session apply) and the strip offers
 * Refresh, which is honest; a stale copy presented as current is not.
 *
 * `focus` names the session the desktop is showing, so a first connect opens it.
 */
export async function requestMergedChatSnapshot(deps: MergedSnapshotDeps): Promise<SerializedChatState> {
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const windowIds = deps.registry.getMainWindowIds();
  const answers = new Map<number, WindowAnswer>();
  await Promise.all(windowIds.map(async (id) => {
    const target = deps.webContentsFor(id);
    answers.set(id, target && !target.isDestroyed() ? await askWindow(target, timeoutMs) : UNANSWERED);
  }));

  const order: string[] = [];
  const seen = new Set<string>();
  const note = (sid: string) => { if (!seen.has(sid)) { seen.add(sid); order.push(sid); } };
  for (const sid of deps.knownSessionIds()) note(sid);
  for (const id of windowIds) {
    const a = answers.get(id);
    if (a?.answered) for (const [sid] of a.snapshot.sessions) note(sid);
  }

  const live = new Set(windowIds);
  const fallback = deps.fallbackWindowId();
  const leader = deps.registry.getLeaderId();
  // No window at all means no copy of anything could be taken: say so.
  let degraded = windowIds.length === 0;
  const sessions: SerializedChatState['sessions'] = [];
  for (const sid of order) {
    const owner = deps.registry.getOwner(sid);
    const responsible = owner !== undefined && live.has(owner) ? owner
      : fallback !== undefined && live.has(fallback) ? fallback
      : leader;
    const answer = responsible !== undefined ? answers.get(responsible) : undefined;
    if (!answer?.answered) { degraded = true; continue; }
    if (deps.registry.isPendingTransfer(sid) || answer.loadingSessionIds.includes(sid)) { degraded = true; continue; }
    // A window that answered but holds no key for the session has never seen it (it
    // was created a moment ago): nothing to omit, nothing missing.
    const copy = answer.snapshot.sessions.find(([id]) => id === sid);
    if (copy) sessions.push(copy);
  }
  const focus = { sessionId: deps.registry.getFocusSessionId() };
  return degraded ? { sessions, degraded: true, focus } : { sessions, focus };
}
