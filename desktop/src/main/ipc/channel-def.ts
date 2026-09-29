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
export interface DesktopServices { sessionManager: CreateSessionDeps['sessionManager'] }
export type MainChannelCtx = ChannelCtx<RemoteNativeRuntime> & { desktop?: DesktopServices };
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
