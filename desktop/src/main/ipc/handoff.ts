// handoff.ts — moving a conversation to this computer, one attempt at a time (handoff:*), one table
// entry each, served to the computer's windows and to a phone.
//
// WHY (2026-09-30 one-core R3-5): both doors already shared createHandoffTransport (the validation
// and the attempt controller); what was written twice was the routing wrapper around it. An attempt is
// OWNED by the connection that began it so it is cancelled when that window or phone goes away
// (cancelOwner, wired in main.ts and remote-server.ts).
import { IPC } from '../../shared/backend-contract';
import type { createHandoffTransport } from '../conversations/handoff-transport';
import { defineChannel, type MainChannelCtx, type MainChannelDef } from './channel-def';

let route: ReturnType<typeof createHandoffTransport> | undefined;
/** Called by registerIpcHandlers once the attempt controller exists. */
export function bindHandoffRoute(next: ReturnType<typeof createHandoffTransport> | undefined): void { route = next; }

/** Who owns an attempt: the calling window, or the calling phone (the strings cancelOwner is keyed by). */
const ownerOf = (ctx: MainChannelCtx) => ctx.door === 'remote' ? `remote:${ctx.clientId}` : `window:${ctx.windowId}`;

function run(action: string) {
  return (payload: unknown, ctx: MainChannelCtx) => {
    if (!route) throw new Error('Handoff attempts are unavailable.');
    return route(ownerOf(ctx), action, payload);
  };
}

/** A phone has no rejected-invoke channel: a failed request answers {ok:false,error} (the phone's page
 *  turns that back into a rejection, REJECT_ON_NOT_OK), with the wording the old phone case used. */
const phoneFailure = (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : 'Handoff request failed.' });

const handoff = (name: typeof IPC.HANDOFF_BEGIN | typeof IPC.HANDOFF_STATUS | typeof IPC.HANDOFF_WAIT | typeof IPC.HANDOFF_RETRY
  | typeof IPC.HANDOFF_SAVED_COPY | typeof IPC.HANDOFF_FORCE | typeof IPC.HANDOFF_CANCEL | typeof IPC.HANDOFF_CREATE_PARAMS) =>
  defineChannel({ name, kind: 'handle', handler: run(name.slice('handoff:'.length)) as any, remoteOnError: phoneFailure });

export const handoffChannels: MainChannelDef[] = [
  handoff(IPC.HANDOFF_BEGIN), handoff(IPC.HANDOFF_STATUS), handoff(IPC.HANDOFF_WAIT), handoff(IPC.HANDOFF_RETRY),
  handoff(IPC.HANDOFF_SAVED_COPY), handoff(IPC.HANDOFF_FORCE), handoff(IPC.HANDOFF_CANCEL), handoff(IPC.HANDOFF_CREATE_PARAMS),
];
