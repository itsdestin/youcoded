// channel-table.ts — the ONE table of app features that both doors serve.
//
// WHY (2026-09-29 one-core R2): every feature used to be written twice — an ipcMain handler in
// ipc-handlers.ts for the desktop's own windows, and a `case` in remote-server.ts for a phone —
// and the two drifted (a phone answering differently, or not at all). The table holds each
// feature ONCE: a name, a handler that takes one payload object, and the policy a phone is
// held to. The desktop door registers every entry with Electron; the phone door looks a
// message up here BEFORE its old switch. R2 ships the mechanism EMPTY: with zero entries neither
// door does anything new. R3 moves real channels in, one family at a time.
//
// The entry shape (ChannelDef) lives in shared/backend-contract.ts next to the channel names; a
// family's entries are written with defineChannel (channel-def.ts) in main/ipc/<family>.ts.
//
// WHY (2026-09-30 one-core R3-1): the table now holds its first six families (tags, folders,
// defaults, modes, analytics, settings). To move a family: add its request/response rows to
// ChannelTypes, write main/ipc/<family>.ts, list it below, then delete its ipcMain.handle blocks
// in ipc-handlers.ts and its `case`s in remote-server.ts. Never leave a case behind: the table
// answers first on the phone, so a leftover case is dead code that looks alive.
import type { ChannelCtx } from '../../shared/backend-contract';
import type { RemoteNativeRuntime } from '../create-runtime';
import type { MainChannelCtx, MainChannelDef } from './channel-def';
import { tagsChannels } from './tags';
import { foldersChannels } from './folders';
import { defaultsChannels } from './defaults';
import { modesChannels } from './modes';
import { analyticsChannels } from './analytics';
import { settingsChannels } from './settings';

export type { MainChannelCtx, MainChannelDef } from './channel-def';

/** Every channel both doors serve. Mutable so a test can place a test-only entry and remove it again. */
export const CHANNEL_TABLE: MainChannelDef[] = [
  ...tagsChannels,
  ...foldersChannels,
  ...defaultsChannels,
  ...modesChannels,
  ...analyticsChannels,
  ...settingsChannels,
];

let indexed: { size: number; byName: Map<string, MainChannelDef> } | null = null;
/** The entry for a channel name, or undefined. The lookup map is rebuilt only when the table's size changed. */
export function findChannel(name: string): MainChannelDef | undefined {
  if (!indexed || indexed.size !== CHANNEL_TABLE.length) {
    indexed = { size: CHANNEL_TABLE.length, byName: new Map(CHANNEL_TABLE.map((d) => [d.name, d])) };
  }
  return indexed.byName.get(name);
}

// ── Desktop door ───────────────────────────────────────────────────────────────

/** The two Electron registration calls the desktop door needs (a fake stands in for tests). */
interface IpcMainLike {
  handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void;
  on(channel: string, listener: (event: any, ...args: any[]) => void): void;
}

/** Register every table entry with Electron. `handle` entries answer with the handler's own value
 *  (a throw rejects the invoke, exactly as a hand-written ipcMain.handle does); `on` entries are
 *  fire-and-forget; `push` entries have no receiver and register nothing. */
export function registerDesktopChannels(
  ipc: IpcMainLike,
  getRuntime: () => RemoteNativeRuntime | null,
  /** Tell every window and every phone (see ChannelCtx.broadcast). */
  broadcast: ChannelCtx['broadcast'],
): void {
  const seen = new Set<string>();
  for (const def of CHANNEL_TABLE) {
    if (seen.has(def.name)) throw new Error(`channel table lists ${def.name} twice`);
    seen.add(def.name);
    const ctxFor = (event: any): MainChannelCtx => ({ door: 'desktop', runtime: getRuntime(), windowId: event?.sender?.id, broadcast });
    if (def.kind === 'handle') {
      ipc.handle(def.name, (event, payload) => def.handler(payload, ctxFor(event)));
    } else if (def.kind === 'on') {
      ipc.on(def.name, (event, payload) => {
        // An ipcMain.on listener that throws would surface as an uncaught main-process exception.
        Promise.resolve()
          .then(() => def.handler(payload, ctxFor(event)))
          .catch((error) => console.warn(`[channel-table] ${def.name} failed:`, error instanceof Error ? error.message : error));
      });
    }
  }
}

// ── Phone door ─────────────────────────────────────────────────────────────────

/** What the phone door should send back for one message. `reply: false` = send nothing. */
type RemoteOutcome = { reply: false } | { reply: true; payload: unknown };

/** Runs one table entry for a phone. The single place a phone's policy is applied, so a family
 *  moved into the table cannot forget it: desktop-only and phone-refused channels answer their
 *  declared refusal without the handler ever running. */
export async function serveRemoteChannel(def: MainChannelDef, payload: unknown, ctx: MainChannelCtx): Promise<RemoteOutcome> {
  if (def.desktopOnly || def.remoteAllowed === false || def.kind === 'push') {
    const refusal = def.refusal ?? { kind: 'unsupported' as const };
    if (refusal.kind === 'silent') return { reply: false };
    if (refusal.kind === 'reply') return { reply: true, payload: refusal.payload };
    return {
      reply: true,
      payload: { ok: false, error: `This feature isn't available over remote access yet (${def.name}).`, unsupported: true },
    };
  }
  if (def.kind === 'on') {
    try { await def.handler(payload, ctx); } catch (error) {
      console.warn(`[channel-table] ${def.name} failed:`, error instanceof Error ? error.message : error);
    }
    return { reply: false };
  }
  try {
    return { reply: true, payload: await def.handler(payload, ctx) };
  } catch (error) {
    // A phone has no rejected-invoke channel, so a throw becomes what the entry declares
    // (remoteOnError: the soft answer its caller expects), else the {ok:false,error} shape the
    // rest of remote-server already answers with.
    if (def.remoteOnError) return { reply: true, payload: def.remoteOnError(error, payload) };
    return { reply: true, payload: { ok: false, error: error instanceof Error ? error.message : 'That did not work. Try again.' } };
  }
}
