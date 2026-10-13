// specialists.ts — the specialists roster, the two model tiers and the card's Steer / Stop, one table
// entry each, served to the computer's windows and to a phone.
//
// WHY (2026-09-30 one-core R3-5): written twice before. Not gated on native.supported: a phone must still
// be able to see the roster and answer a hire's ask. With no runtime a phone gets the same plain
// "isn't connected" answers it always did (error-message-standards.md: general, no guessed cause).
// specialists:event is a push, driven by the delegation ledger; it is not an entry.
import { IPC } from '../../shared/backend-contract';
import { toListResult } from '../harness/specialists/catalog';
import { defineChannel, type MainChannelDef } from './channel-def';

const NOT_CONNECTED = { ok: false as const, error: 'The assistant runtime isn’t connected.' };

export const specialistsChannels: MainChannelDef[] = [
  // list ALWAYS re-reads (catalog.reload) so a file dropped into a specialists folder a moment ago shows up
  // without a Refresh click; ensurePersonalFolder is opt-in (Settings' "Open folder" needs somewhere to open
  // the first time).
  defineChannel({
    name: IPC.SPECIALISTS_LIST, kind: 'handle',
    handler: async (opts, ctx) => {
      if (!ctx.runtime) return { definitions: [], skipped: [], folders: { personal: '', claudeUser: '' } };
      const { specialistCatalog } = ctx.runtime;
      if (opts?.ensurePersonalFolder) await specialistCatalog.ensurePersonalFolder();
      await specialistCatalog.reload(opts?.cwd);
      return toListResult(specialistCatalog.snapshot(opts?.cwd));
    },
  }),
  defineChannel({ name: IPC.SPECIALISTS_DELEGATED_GET, kind: 'handle', handler: (_p, ctx) => ctx.runtime ? ctx.runtime.nativeHost.getDelegatedModels() : { budget: null, frontier: null } }),
  defineChannel({ name: IPC.SPECIALISTS_DELEGATED_SET, kind: 'handle', handler: ({ tier, binding }, ctx) => ctx.runtime ? ctx.runtime.nativeHost.setDelegatedModel(tier, binding) : NOT_CONNECTED }),
  defineChannel({ name: IPC.SPECIALISTS_STEER, kind: 'handle', handler: ({ sessionId, childId, text }, ctx) => ctx.runtime ? ctx.runtime.nativeHost.steerFromUser(sessionId, childId, text) : NOT_CONNECTED }),
  defineChannel({ name: IPC.SPECIALISTS_INTERRUPT, kind: 'handle', handler: ({ sessionId, childId }, ctx) => ctx.runtime ? ctx.runtime.nativeHost.interruptFromUser(sessionId, childId) : NOT_CONNECTED }),
];
