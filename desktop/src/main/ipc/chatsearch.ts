// chatsearch.ts — the two session-reference channels (chatsearch:resolve / chatsearch:read), one entry each.
//
// WHY (2026-09-30 one-core R3-7): an ipcMain handler in ipc-handlers.ts and a phone `case` in
// remote-server.ts, both already calling refs-service so a phone and the computer could not disagree about
// which folders may be read. One entry each now; the phone has no extra gate (refs-service is the gate for
// both) and keeps its access unchanged.
import { IPC } from '../../shared/backend-contract';
import { resolveConversations, readConversation } from '../chatsearch-index/refs-service';
import { defineChannel, type MainChannelDef } from './channel-def';

export const chatsearchChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.CHATSEARCH_RESOLVE, kind: 'handle', handler: (p) => resolveConversations(p?.shortIds) }),
  defineChannel({ name: IPC.CHATSEARCH_READ, kind: 'handle', handler: (req) => readConversation(req) }),
];
