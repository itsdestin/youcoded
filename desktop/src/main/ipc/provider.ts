// provider.ts — the model providers (Settings → Providers): list, add or edit, remove, test, save a key, and
// the model catalog; plus finding Ollama / LM Studio on this computer. One table entry each, served to the
// computer's windows and to a phone.
//
// WHY (2026-09-30 one-core R3-6): these were written twice (ipcMain.handle in ipc-handlers.ts, `case`s in
// remote-server.ts). Both doors reach the SAME ProviderRegistry through the runtime (ctx.runtime), so each
// body is one line. WHAT A PHONE SEES, before -> now:
//   - Everything a phone could do it still can, with the same answers. A phone that arrives before the
//     runtime exists gets the same empty / null answers as before.
//   - A failed add/remove/save/catalog used to answer {ok:false,error} (no rejection) and now also carries the
//     table's failure marker, so the phone's page shows an error. provider:test keeps its {ok:false,message}.
//   - provider:set-key with no runtime yet used to answer "saved" for a key that was never saved; it now says
//     the providers are not ready. (A key is never in any answer: set-key answers `true`, list says only hasKey.)
//   - The bare-id form (`payload.id ?? payload`) the phone's old cases tolerated is gone: the phone's page
//     always sends {id}, as the computer does.
import { IPC } from '../../shared/backend-contract';
import { detectEndpoints } from '../models/endpoint-detectors';
import { defineChannel, type MainChannelCtx, type MainChannelDef } from './channel-def';

/** The registry, or a plain "not ready" for a call that would otherwise claim a save it never made. */
function registryOrThrow(ctx: MainChannelCtx) {
  if (!ctx.runtime) throw new Error('Providers are not ready yet. Try again.');
  return ctx.runtime.providerRegistry;
}

export const providerChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.PROVIDER_LIST, kind: 'handle', handler: (_p, ctx) => ctx.runtime ? ctx.runtime.providerRegistry.list() : [] }),
  // The payload IS the config (no wrapper), as both doors always sent it.
  defineChannel({ name: IPC.PROVIDER_UPSERT, kind: 'handle', handler: (config, ctx) => ctx.runtime ? ctx.runtime.providerRegistry.upsert(config) : null }),
  defineChannel({
    name: IPC.PROVIDER_REMOVE, kind: 'handle',
    handler: async ({ id }, ctx) => { if (ctx.runtime) await ctx.runtime.providerRegistry.remove(id); return true as const; },
  }),
  // `key`: an optional candidate checked instead of the saved key (the Connect dialog refuses a bad key before it
  // can replace a working one). A throw reaches a phone as the {ok,message} it always got.
  defineChannel({
    name: IPC.PROVIDER_TEST, kind: 'handle',
    handler: ({ id, key }, ctx) => ctx.runtime
      ? ctx.runtime.providerRegistry.testConnection(id, typeof key === 'string' ? key : undefined)
      : { ok: false, message: 'Native runtime not available.' },
    remoteOnError: (error) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }),
  }),
  defineChannel({
    name: IPC.PROVIDER_SET_KEY, kind: 'handle',
    handler: async ({ id, key }, ctx) => { await registryOrThrow(ctx).setKey(id, key); return true as const; },
  }),
  defineChannel({
    name: IPC.PROVIDER_CATALOG, kind: 'handle',
    handler: async (_p, ctx) => ctx.runtime ? ctx.runtime.modelCatalog.get(await ctx.runtime.providerRegistry.list()) : [],
  }),
  // Looks for Ollama / LM Studio on THIS computer (the only place they can be).
  defineChannel({
    name: IPC.ENDPOINTS_DETECT, kind: 'handle',
    handler: async (_p, ctx) => ctx.runtime ? detectEndpoints(fetch, await ctx.runtime.providerRegistry.list()) : [],
  }),
];
