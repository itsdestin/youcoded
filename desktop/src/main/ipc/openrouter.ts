// openrouter.ts — "Sign in with OpenRouter": status, start, cancel, one table entry each.
//
// WHY (2026-09-30 one-core R3-6): written twice. Starting the sign-in opens the browser ON THE COMPUTER (through
// the runtime's own platform.openExternal, inside OpenRouterSignIn) and listens there, so a phone cannot
// complete it: the phone's old case answered `false`, and that refusal is now declared as the entry's phone
// policy. WHAT A PHONE SEES, before -> now: the same. status and cancel are real; sign-in answers `false`.
import { IPC } from '../../shared/backend-contract';
import { defineChannel, type MainChannelDef } from './channel-def';

export const openrouterChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.OPENROUTER_SIGN_IN_STATUS, kind: 'handle', handler: (_p, ctx) => ctx.runtime?.openRouterSignIn?.status() ?? { state: 'idle' as const } }),
  defineChannel({
    name: IPC.OPENROUTER_SIGN_IN, kind: 'handle', remoteAllowed: false, refusal: { kind: 'reply', payload: false },
    handler: (_p, ctx) => ctx.runtime!.openRouterSignIn.signIn(),
  }),
  defineChannel({ name: IPC.OPENROUTER_CANCEL_SIGN_IN, kind: 'handle', handler: (_p, ctx) => ctx.runtime?.openRouterSignIn ? ctx.runtime.openRouterSignIn.cancelSignIn() : false }),
];
