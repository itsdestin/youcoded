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
 * WHY every window: this used to ask the first window only. A session dragged into a
 * second window reached the phone stale or empty — every window seeds a key for every
 * session, but only the window its messages are routed to has them — and once the first
 * window closed the answer was `{ sessions: [] }` with no sign anything was missing.
 *
 * WHICH window's copy (T3 review, 1 and 2): exactly the window main routes the
 * session's messages to — ipc-handlers.ts `sendForSession`: the owner; for an unowned
 * session with subscribers, only those subscribers (buddies, never asked here); else the
 * first window while it lives. Anything else holds a copy the messages never reached, and
 * the host's restore skips queued transcript events below its cut line for every session
 * in this snapshot (remote-server.ts restoreClient) — so a copy from a window that is not
 * the recipient would silently lose them. Such a session is OMITTED and the snapshot
 * marked `degraded`: the phone keeps its own copy, receives every queued event, and the
 * strip offers Refresh. (The design's "else the leader" branch is not taken for that
 * reason: with the first window gone, an unowned session's messages reach no window.)
 *
 * Also omitted and degraded: a session whose recipient did not answer, reported its own
 * export failed, is mid-transfer, is still loading that session's history, or answered
 * without a copy of a session the host runs; and a session whose recipient or pending
 * state changed while the windows were answering — both are read when the requests go
 * out (T3 review, 4), because a drag during the wait means the copy came from a window
 * that answered before it acquired the session.
 *
 * `focus` names the session the desktop is showing, so a first connect opens it.
 */
export async function requestMergedChatSnapshot(deps: MergedSnapshotDeps): Promise<SerializedChatState> {
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const windowIds = deps.registry.getMainWindowIds();
  const live = new Set(windowIds);
  const known = deps.knownSessionIds();
  const knownSet = new Set(known);

  const recipientOf = (sid: string): number | undefined => {
    const owner = deps.registry.getOwner(sid);
    if (owner !== undefined) return live.has(owner) ? owner : undefined;
    if (deps.registry.getSubscribers(sid).size > 0) return undefined;
    const fallback = deps.fallbackWindowId();
    return fallback !== undefined && live.has(fallback) ? fallback : undefined;
  };
  const atRequest = new Map(known.map((sid) => [sid, {
    recipient: recipientOf(sid),
    pending: deps.registry.isPendingTransfer(sid),
  }]));

  const answers = new Map<number, WindowAnswer>();
  await Promise.all(windowIds.map(async (id) => {
    const target = deps.webContentsFor(id);
    answers.set(id, target && !target.isDestroyed() ? await askWindow(target, timeoutMs) : UNANSWERED);
  }));

  const order: string[] = [...known];
  const seen = new Set(known);
  for (const id of windowIds) {
    const a = answers.get(id);
    if (!a?.answered) continue;
    for (const [sid] of a.snapshot.sessions) if (!seen.has(sid)) { seen.add(sid); order.push(sid); }
  }

  // No window at all means no copy of anything could be taken: say so.
  let degraded = windowIds.length === 0;
  const sessions: SerializedChatState['sessions'] = [];
  for (const sid of order) {
    // A key only some window holds, for a session the host no longer runs (every running
    // session — native ones too — is created through the session manager): a leftover
    // slot, not a missing conversation. Skip it quietly.
    const isKnown = knownSet.has(sid);
    const before = atRequest.get(sid);
    const recipient = recipientOf(sid);
    if (before && before.recipient !== recipient) { degraded = true; continue; }
    if (recipient === undefined) { if (isKnown) degraded = true; continue; }
    const answer = answers.get(recipient);
    if (!answer?.answered) { if (isKnown) degraded = true; continue; }
    const pending = !!before?.pending || deps.registry.isPendingTransfer(sid) || answer.loadingSessionIds.includes(sid);
    if (pending) { degraded = true; continue; }
    const copy = answer.snapshot.sessions.find(([id]) => id === sid);
    if (copy) sessions.push(copy);
    else if (isKnown) degraded = true;
  }
  const focus = { sessionId: deps.registry.getFocusSessionId() };
  return degraded ? { sessions, degraded: true, focus } : { sessions, focus };
}
