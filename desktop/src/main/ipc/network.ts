// network.ts — the app's own "is this computer online?" check, one table entry.
//
// WHY (card #236): the sign-in cards and the first-run screen must tell "no internet" from "something
// wrong with your account". Phone policy: ALLOWED — it reports the HOST's network (the computer that
// runs the sign-in), which is exactly the answer a phone's card needs. Never throws (checkInternet).
import { IPC } from '../../shared/backend-contract';
import { checkInternet } from '../network-check';
import { defineChannel, type MainChannelDef } from './channel-def';

export const networkChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.NETWORK_CHECK, kind: 'handle', handler: async () => ({ online: await checkInternet() }) }),
];
