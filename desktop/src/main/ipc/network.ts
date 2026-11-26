// network.ts — the app's own "is this computer online?" check, one table entry.
//
// WHY (card #236): the sign-in cards and the first-run screen must tell "no internet" from "something
// wrong with your account". Never throws (checkInternet).
//
// Phone policy: REFUSED to a visiting phone (Destin, 2026-11-18: "if i'm on my phone, i wouldnt even
// be able to connect to the computer in the first place"). A phone that reached the computer has
// already proved the computer is online, so the answer is useless there. The Android app's own
// screen is the backend's owner, not a visitor, so it still gets the real check. A refused call
// proves nothing to the cards that ask: they keep the provider's own words.
import { IPC } from '../../shared/backend-contract';
import { checkInternet } from '../network-check';
import { defineChannel, type MainChannelDef } from './channel-def';

export const networkChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.NETWORK_CHECK, kind: 'handle', remoteAllowed: false, handler: async () => ({ online: await checkInternet() }) }),
];
