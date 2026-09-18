// ── The shared window.claude bridge shape: session, on, favorites ──
//
// WHY these types exist (Plan B source-grep sweep, 2026-09-16): preload.ts
// (Electron) and remote-shim.ts (remote browser and Android) are two
// hand-written copies of the same window.claude surface, and a member missing
// from one crashes React on that platform. That parity used to be
// tests/shim-parity.test.ts, which grepped both files as text — and whose regex
// stopped at the first `}` it met, so it only ever compared `create`. Both
// object literals now end in `satisfies` (a compile-time check that is erased
// from the build — nothing runs differently), so `npm run typecheck` refuses a
// drifted member list:
//   - preload.ts is checked against SharedBridge EXACTLY for `session` and `on`:
//     a new member there is an "unknown property" error until it is added here,
//     and adding it here makes remote-shim.ts fail until it implements it.
//   - remote-shim.ts is checked against RemoteBridge: it must implement every
//     member here and may carry more (on.chatHydrate and on.prompt*, which only
//     a remote client receives).
// Parameter TYPES are checked, names are not: the 2026-08-12 loadHistory bug
// (the shim took (sessionId, count, all, projectSlug)) is a type error, but a
// swap of two same-typed parameters is not — remote-shim.test.ts
// drives that order onto the wire, but for the SHIM only: preload.ts's
// loadHistory takes the same-typed (sessionId, projectSlug) pair, and nothing
// checks that preload keeps them in that order. Signatures follow preload.ts.
// This is not the renderer's view of window.claude (that is the `declare global`
// in useIpc.ts). Only PreloadBridge/RemoteBridge are exported (knip ratchet).
// Its own file, not shared/types.ts, so the bridge shape is found in one place
// and types.ts stays inside its line budget (review of Plan B, 2026-09-17).

import type { SessionMetaResult } from './types';

/** A listener handle as the bridges return it — pass it back to `off()`. */
type BridgeHandler = (...args: any[]) => void;

/** window.claude.session — every member both bridges must implement. */
interface SessionBridge {
  create(opts: { name: string; cwd: string; skipPermissions: boolean; cols?: number; rows?: number; resumeSessionId?: string; provider?: 'claude' | 'native'; model?: string }): Promise<unknown>;
  destroy(sessionId: string): Promise<unknown>;
  list(): Promise<unknown>;
  /** False on a remote client whose connection is down; always true on desktop. */
  canSend(): boolean;
  sendInput(sessionId: string, text: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  signalReady(sessionId: string): void;
  respondToPermission(requestId: string, decision: object): Promise<unknown>;
  browse(): Promise<unknown[]>;
  /** Order is (sessionId, projectSlug, count, all) on every bridge and caller. */
  loadHistory(sessionId: string, projectSlug: string, count?: number, all?: boolean): Promise<unknown[]>;
  switch(sessionId: string): Promise<unknown>;
  noteSelected(sessionId: string | null): void;
  setFlag(sessionId: string, flag: string, value: boolean): Promise<unknown>;
  setTag(sessionId: string, tagId: string, value: boolean): Promise<unknown>;
  setNote(sessionId: string, note: string): Promise<unknown>;
  getMeta(sessionId: string): Promise<SessionMetaResult>;
}

/** window.claude.on — the push subscriptions both bridges must implement.
 *  Members returning `() => void` hand back an unsubscribe function; the rest
 *  return a handle for `off()`. */
interface BridgeListeners {
  sessionCreated(cb: (info: any) => void): BridgeHandler;
  sessionDestroyed(cb: (id: string, exitCode: number, focusSessionId?: string | null) => void): BridgeHandler;
  ptyOutput(cb: (sessionId: string, data: string) => void): BridgeHandler;
  ptyOutputForSession(sessionId: string, cb: (data: string) => void): () => void;
  ptyRawBytesForSession(sessionId: string, cb: (data: string) => void): () => void;
  ptyResetForSession(sessionId: string, cb: () => void): () => void;
  hookReplayComplete(cb: (payload: { sessionId: string; pendingRequestIds: string[] }) => void): () => void;
  remoteConversationStatus(cb: (status: { phase: string }) => void): () => void;
  hookEvent(cb: (event: any) => void): BridgeHandler;
  statusData(cb: (data: any) => void): BridgeHandler;
  sessionRenamed(cb: (sessionId: string, name: string) => void): BridgeHandler;
  sessionMoved(cb: (payload: { sessionId: string; device?: string; claudeSessionId?: string; projectSlug?: string; projectPath?: string }) => void): BridgeHandler;
  sessionMetaChanged(cb: (sessionId: string, meta: { flag: string; value: boolean }) => void): () => void;
  tagsChanged(cb: (payload: any) => void): () => void;
  specialistEvent(cb: (e: any) => void): () => void;
  shellEvent(cb: (e: any) => void): () => void;
  sessionPermissionMode(cb: (sessionId: string, mode: string) => void): BridgeHandler;
  uiAction(cb: (action: any) => void): BridgeHandler;
  transcriptEvent(cb: (event: any) => void): BridgeHandler;
  transcriptShrink(cb: (payload: { sessionId: string; oldSize: number; newSize: number }) => void): BridgeHandler;
}

/** The members of window.claude these types pin. Every other member is
 *  unchecked here (`Record<string, unknown>` below lets it through). */
interface SharedBridge {
  session: SessionBridge;
  on: BridgeListeners;
  /** The arcade's favourite games (favorites:get / favorites:set). */
  getFavorites(): Promise<string[]>;
  setFavorites(favorites: string[]): Promise<unknown>;
}

/** What preload.ts's exposed object satisfies: SharedBridge, with `session`
 *  and `on` exact, plus any other top-level member. */
export type PreloadBridge = SharedBridge & Record<string, unknown>;

/** What remote-shim.ts's window.claude satisfies: at least SharedBridge, with
 *  room for remote-only extras inside `session` and `on`. */
export type RemoteBridge = Omit<SharedBridge, 'session' | 'on'> & {
  session: SessionBridge & Record<string, unknown>;
  on: BridgeListeners & Record<string, unknown>;
} & Record<string, unknown>;
