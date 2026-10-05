// social.ts — friends and presence: social:lookup-handle / send-request / list-requests / accept-request / decline-request /
// cancel-request / list-friends / unfriend / block / unblock / list-blocks, and social:presence-connect / -disconnect / -send.
// The computer's own account session only.
//
// WHY (2026-10-01 one-core R3-8): fourteen ipcMain handlers in social-handlers.ts, registered with the account's auth store.
// Every call carries the account bearer token, which lives in main and never crosses to a window or a phone, and none was ever
// bridged to a phone, so the table refuses all of them for a phone from the entries (`desktopOnly`) with the "not available
// over remote access" answer the old default gave. They are the account's friends list and the presence socket, so opening
// them to a phone is a product decision (see the R3-8 report), not part of this move. The operations are built where the token
// and presence socket are (social-handlers.ts) and reached through getSocialOps().
import { IPC } from '../../shared/backend-contract';
import { getSocialOps, type SocialOps } from '../social-handlers';
import { defineChannel, type MainChannelDef } from './channel-def';

const ops = (): SocialOps => { const o = getSocialOps(); if (!o) throw new Error('friends are not ready'); return o; };

export const socialChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.SOCIAL_LOOKUP_HANDLE, kind: 'handle', desktopOnly: true, handler: ({ handle }) => ops().lookupHandle(handle) }),
  defineChannel({ name: IPC.SOCIAL_SEND_REQUEST, kind: 'handle', desktopOnly: true, handler: ({ handle }) => ops().sendRequest(handle) }),
  defineChannel({ name: IPC.SOCIAL_LIST_REQUESTS, kind: 'handle', desktopOnly: true, handler: () => ops().listRequests() }),
  defineChannel({ name: IPC.SOCIAL_ACCEPT_REQUEST, kind: 'handle', desktopOnly: true, handler: ({ id }) => ops().acceptRequest(id) }),
  defineChannel({ name: IPC.SOCIAL_DECLINE_REQUEST, kind: 'handle', desktopOnly: true, handler: ({ id }) => ops().declineRequest(id) }),
  defineChannel({ name: IPC.SOCIAL_CANCEL_REQUEST, kind: 'handle', desktopOnly: true, handler: ({ id }) => ops().cancelRequest(id) }),
  defineChannel({ name: IPC.SOCIAL_LIST_FRIENDS, kind: 'handle', desktopOnly: true, handler: () => ops().listFriends() }),
  defineChannel({ name: IPC.SOCIAL_UNFRIEND, kind: 'handle', desktopOnly: true, handler: ({ userId }) => ops().unfriend(userId) }),
  defineChannel({ name: IPC.SOCIAL_BLOCK, kind: 'handle', desktopOnly: true, handler: ({ userId }) => ops().block(userId) }),
  defineChannel({ name: IPC.SOCIAL_UNBLOCK, kind: 'handle', desktopOnly: true, handler: ({ userId }) => ops().unblock(userId) }),
  defineChannel({ name: IPC.SOCIAL_LIST_BLOCKS, kind: 'handle', desktopOnly: true, handler: () => ops().listBlocks() }),
  defineChannel({ name: IPC.SOCIAL_PRESENCE_CONNECT, kind: 'handle', desktopOnly: true, handler: () => ops().presenceConnect() }),
  defineChannel({ name: IPC.SOCIAL_PRESENCE_DISCONNECT, kind: 'handle', desktopOnly: true, handler: () => ops().presenceDisconnect() }),
  defineChannel({ name: IPC.SOCIAL_PRESENCE_SEND, kind: 'handle', desktopOnly: true, handler: ({ message }) => ops().presenceSend(message) }),
];
