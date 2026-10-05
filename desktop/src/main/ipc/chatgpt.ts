// chatgpt.ts — "Sign in with ChatGPT": status and the three verbs, one table entry each.
//
// WHY (2026-09-30 one-core R3-6): written twice. `ctx.runtime.chatgptAuth` is already the account with the
// YOUCODED_CHATGPT=0 kill switch applied (null = off: signed-out / false), exactly as both old copies read it.
// WHAT A PHONE SEES, before -> now: the same. status, cancel and sign-out are real; sign-in is REFUSED with
// `false` (declared here as the phone's policy, where it was a bare `case`) because the browser tab and the
// 127.0.0.1:1455 listener it needs live on the computer. signIn() THROWS its two verbatim sentences (port in
// use, keychain unavailable); the computer's window shows them, a phone's page gets them as an error.
import { IPC } from '../../shared/backend-contract';
import { defineChannel, type MainChannelDef } from './channel-def';

export const chatgptChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.CHATGPT_STATUS, kind: 'handle', handler: (_p, ctx) => ctx.runtime?.chatgptAuth ? ctx.runtime.chatgptAuth.status() : { state: 'signed-out' as const } }),
  defineChannel({
    name: IPC.CHATGPT_SIGN_IN, kind: 'handle', remoteAllowed: false, refusal: { kind: 'reply', payload: false },
    handler: (_p, ctx) => ctx.runtime?.chatgptAuth ? ctx.runtime.chatgptAuth.signIn() : false,
  }),
  defineChannel({ name: IPC.CHATGPT_CANCEL_SIGN_IN, kind: 'handle', handler: (_p, ctx) => ctx.runtime?.chatgptAuth ? ctx.runtime.chatgptAuth.cancelSignIn() : false }),
  defineChannel({ name: IPC.CHATGPT_SIGN_OUT, kind: 'handle', handler: (_p, ctx) => ctx.runtime?.chatgptAuth ? ctx.runtime.chatgptAuth.signOut() : false }),
];
