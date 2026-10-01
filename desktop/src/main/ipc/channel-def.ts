// channel-def.ts — how a family file writes one table entry.
//
// WHY (2026-09-30 one-core R3-1): split out of channel-table.ts so a family file
// (main/ipc/<family>.ts) and the table that lists every family do not import each other.
//
// THE PATTERN every family copies (R3-1 set it):
//   main/ipc/<family>.ts  exports `<family>Channels: MainChannelDef[]`, one `defineChannel` per
//   channel. The name and the request/response types come from `ChannelTypes` in
//   shared/backend-contract.ts (add the family's rows there first). The handler takes
//   (payload, ctx) and returns a plain value; BOTH doors run it.
import type { ChannelCtx, ChannelDef, ChannelTypes } from '../../shared/backend-contract';
import type { RemoteNativeRuntime } from '../create-runtime';
import type { CreateSessionDeps } from '../dev-tools';

/** What a table handler is given besides its payload. Typed with the slice of the runtime the
 *  PHONE door can also reach (RemoteNativeRuntime), because a handler both doors run may only
 *  lean on what both doors have. A family that needs more widens it. */
/** WHY (2026-09-30 one-core R3-2): things only the computer's own process holds (the session
 *  manager). Filled by the DESKTOP door only, so only a `desktopOnly` entry may lean on it; a phone
 *  never reaches such an entry, the table refuses it first. */
export interface DesktopServices {
  /** WHY (2026-09-30 one-core R3-7): tell every window of this computer (and NOT the phones) that a file
   *  or repo changed. The artifact and git change pushes always went to windows only; `ctx.broadcast`
   *  would also reach phones, a wider audience than they had. */
  sendToWindows(channel: string, payload: unknown): void;
  /** WHY (2026-10-01 one-core R3-8): tell every phone (and NOT the computer's windows). A theme change in one window
   *  already reaches the other windows itself; only the phones need this. */
  sendToPhones(message: { type: string; payload: unknown }): void;
  /** WHY (2026-10-01 one-core R3-8): the folders of every open session, for the document-comment folder gate (the
   *  phone door's twin is RemoteServices.sessionRoots). */
  sessionRoots(): string[];
  /** WHY getSession too (2026-09-30 one-core R3-5): native:session-context-text reads a Claude Code
   *  session's project folder to find its instruction file. */
  sessionManager: CreateSessionDeps['sessionManager'] & { getSession(id: string): { cwd: string } | undefined };
}
/** WHY (2026-09-30 one-core R3-4): the calling window's web contents, desktop door only. A few
 *  desktop handlers must know whether the window is still there (session:create fails cleanly if
 *  the window closed while it started) or send straight back to it (transcript replay). A phone
 *  has none. */
interface DesktopSender { id: number; isDestroyed?(): boolean; send?(channel: string, ...args: any[]): void; once?(event: string, listener: () => void): unknown }
/** WHY (2026-09-30 one-core R3-7): what only the PHONE door holds, the mirror of DesktopServices. A file
 *  channel needs to know which folders this phone may see (the ones the computer shows, plus the folder
 *  of a chat that is running), to give the phone its own watch id, and to mint its download links. */
export interface RemoteServices {
  /** The folders of every open session: a folder known only this way answers only that session's own records. */
  sessionRoots(): string[];
  /** This phone's project-watcher id (negative, never a window id), dropped when its socket closes. */
  watchSubscriberId(): number;
  /** This phone's watcher id if it has one yet, without making one (an unwatch before any watch is a no-op). */
  currentWatchId(): number | undefined;
  /** The roots this phone is already watching (capped per socket). */
  watchedRoots: Set<string>;
  /** A short-lived download link bound to this phone and this socket. */
  mintDownload(request: { absolutePath: unknown; projectRoot?: string; artifactId?: string }): Promise<unknown>;
  /** WHY (2026-10-01 one-core R3-8): this phone's document-comment watcher id (its own refcount map, separate from the
   *  project watcher's), made on first use and dropped when its socket closes. */
  docCommentsSubscriberId(): number;
  /** The id above if this phone has one yet, without making one (an unwatch before any watch is a no-op). */
  currentDocCommentsId(): number | undefined;
  /** Send a message to every OTHER phone (never the one asking). `queueWhileRestoring` holds it for a phone that is
   *  still catching up, as a live push would be. A theme or screen change made on this phone uses it. */
  relayToOthers(message: { type: string; payload: unknown }, opts?: { queueWhileRestoring?: boolean }): void;
  /** Send to this computer's own windows only. */
  sendToWindows(channel: string, payload: unknown): void;
  /** WHY (2026-10-01 one-core R3-8): the remote-access host this phone is talking to, for the read-only admin channels
   *  (config, client count, status, device list). The computer's door reads the same host through remote-admin.ts's bind. */
  host: RemoteHost;
}
/** The slice of the remote-access host the admin entries read. */
export interface RemoteHost {
  config: { toSafeObject(): Record<string, unknown>; port: number };
  getClientCount(): number;
  getClientList(): unknown[];
  getStatus(): unknown;
  getDeviceList(): unknown[];
}
export type MainChannelCtx = ChannelCtx<RemoteNativeRuntime> & { desktop?: DesktopServices; remote?: RemoteServices; sender?: DesktopSender };
export type MainChannelDef<Payload = any, Result = any> = ChannelDef<MainChannelCtx, Payload, Result>;

/** A table entry whose name pins its payload and answer types to ChannelTypes. */
export type TypedChannelDef<N extends keyof ChannelTypes> = Omit<
  MainChannelDef<ChannelTypes[N]['request'], ChannelTypes[N]['response']>,
  'name' | 'handler'
> & {
  name: N;
  handler: (
    payload: ChannelTypes[N]['request'],
    ctx: MainChannelCtx,
  ) => ChannelTypes[N]['response'] | Promise<ChannelTypes[N]['response']>;
};

/** Identity at runtime; at compile time it checks the handler against the channel's declared types. */
export function defineChannel<N extends keyof ChannelTypes>(def: TypedChannelDef<N>): MainChannelDef {
  return def as MainChannelDef;
}
