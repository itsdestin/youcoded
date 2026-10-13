// permissions.ts — answering a permission prompt (permission:respond) and the remembered "Always allow"
// rules (permissions:*), one table entry each, served to the computer's windows and to a phone.
//
// WHY (2026-09-30 one-core R3-5): both were written twice. permission:respond is the ONE channel the
// assistant's own asks and Claude Code's hook prompts share, so its routing (native broker first, then
// the hook relay) is now stated once instead of in two copies that had to agree.
import { IPC } from '../../shared/backend-contract';
import type { HookRelay } from '../hook-relay';
import { defineChannel, type MainChannelDef } from './channel-def';

let hookRelay: HookRelay | undefined;
/** Called by registerIpcHandlers with the hook relay (the same object the phone door holds). It is the
 *  one thing a table handler needs that the runtime does not carry. */
export function bindPermissionHooks(relay: HookRelay | undefined): void { hookRelay = relay; }

export const permissionsChannels: MainChannelDef[] = [
  // Native asks share the channel; their ids are 'native-'-prefixed so routing is exact: the native broker
  // first, then the Claude Code hook relay (absent in a native-only run, which answers false).
  defineChannel({
    name: IPC.PERMISSION_RESPOND, kind: 'handle',
    handler: ({ requestId, decision }, ctx) => {
      if (ctx.runtime?.nativeHost.respondPermission(requestId, decision as Record<string, unknown>)) return true;
      return hookRelay ? hookRelay.respond(requestId, decision) : false;
    },
  }),
  // list READS the store directly: it only reports what is on disk. No runtime means no grants to show.
  defineChannel({ name: IPC.PERMISSIONS_LIST, kind: 'handle', handler: (_p, ctx) => ctx.runtime ? ctx.runtime.permissionStore.list() : [] }),
  // remove / remove-project go through nativeHost.revokeRule / revokeProject and NEVER permissionStore.remove:
  // the store touches disk only, while the host also clears the live in-memory rule, so an already-running
  // session stops granting what was just revoked. false = nothing matched (a stale list), which is also the
  // honest answer when the runtime is not wired.
  defineChannel({ name: IPC.PERMISSIONS_REMOVE, kind: 'handle', handler: ({ slug, rule }, ctx) => ctx.runtime ? ctx.runtime.nativeHost.revokeRule(slug, rule) : false }),
  defineChannel({ name: IPC.PERMISSIONS_REMOVE_PROJECT, kind: 'handle', handler: ({ slug }, ctx) => ctx.runtime ? ctx.runtime.nativeHost.revokeProject(slug) : false }),
];
