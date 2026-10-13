// search.ts — WebSearch keys (Settings → Providers → Search): the two keyed backends (Tavily, Exa), whether a
// key is saved, save / remove one, and test one. One table entry each, served to windows and to a phone.
//
// WHY (2026-09-30 one-core R3-6): written twice; both doors reach the SAME SearchKeyStore and SearchService
// through the runtime. A key goes IN (set-key, test) and is NEVER in an answer: set-key and remove-key answer
// `true`, list says only {id, label, hasKey}. WHAT A PHONE SEES, before -> now: the same, except a key save
// or removal with no runtime yet now says "not ready" instead of "saved" for a change that never happened.
import { IPC } from '../../shared/backend-contract';
import { defineChannel, type MainChannelCtx, type MainChannelDef } from './channel-def';

function storeOrThrow(ctx: MainChannelCtx) {
  if (!ctx.runtime) throw new Error('Web search is not ready yet. Try again.');
  return ctx.runtime.searchKeyStore;
}

export const searchChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.SEARCH_LIST, kind: 'handle', handler: (_p, ctx) => ctx.runtime ? ctx.runtime.searchKeyStore.list() : [] }),
  defineChannel({ name: IPC.SEARCH_SET_KEY, kind: 'handle', handler: async ({ backend, key }, ctx) => { await storeOrThrow(ctx).setKey(backend, key); return true as const; } }),
  defineChannel({ name: IPC.SEARCH_REMOVE_KEY, kind: 'handle', handler: async ({ backend }, ctx) => { await storeOrThrow(ctx).removeKey(backend); return true as const; } }),
  // Never throws: { ok, message } is the result.
  defineChannel({
    name: IPC.SEARCH_TEST, kind: 'handle',
    handler: ({ backend, key }, ctx) => ctx.runtime ? ctx.runtime.searchService.testBackend(backend, key) : { ok: false, message: 'Native runtime not available.' },
  }),
];
