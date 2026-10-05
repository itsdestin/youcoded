// models.ts — the local model manager (Settings → Local models): the curated list, Hugging Face search,
// quantisations, download / cancel / resume, delete, what is installed, per-model settings, vision, the memory
// check and reload. One table entry each, served to the computer's windows and to a phone.
// (The singular `model:*` channels are the remembered model choice, a different family: model.ts.)
//
// WHY (2026-09-30 one-core R3-6): written twice; both doors reach the SAME ModelManager and EngineManager
// through the runtime. models:download-progress (the push) is not here: it is sent from the emitter in
// ipc-handlers.ts to every window and every phone, unchanged. A download starts through the one `download` /
// `resume` / `addVision` call exactly as before, from whichever door asked; the table runs each request once.
// WHAT A PHONE SEES, before -> now: the same answers; with no runtime yet the same `[]` / `null` / empty ones
// (an empty download id is never made up: add-vision and download answer null). A failure now carries the
// table's failure marker; models:settings, set-settings and add-vision were already rejected by the phone's
// page. The bare-value forms the phone's old cases tolerated (`payload.modelId ?? payload`, ...) are gone.
import { IPC } from '../../shared/backend-contract';
import { defineChannel, type MainChannelDef } from './channel-def';

export const modelsChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.MODELS_CURATED, kind: 'handle', handler: (_p, ctx) => ctx.runtime ? ctx.runtime.modelManager.curatedList() : [] }),
  defineChannel({ name: IPC.MODELS_SEARCH, kind: 'handle', handler: ({ query }, ctx) => ctx.runtime ? ctx.runtime.modelManager.search(query) : [] }),
  defineChannel({ name: IPC.MODELS_QUANTS, kind: 'handle', handler: ({ repo }, ctx) => ctx.runtime ? ctx.runtime.modelManager.quants(repo) : [] }),
  defineChannel({ name: IPC.MODELS_DOWNLOAD, kind: 'handle', handler: ({ repo, quant }, ctx) => ctx.runtime ? ctx.runtime.modelManager.download(repo, quant) : null }),
  defineChannel({ name: IPC.MODELS_DOWNLOAD_CANCEL, kind: 'handle', handler: ({ downloadId }, ctx) => { ctx.runtime?.modelManager.cancel(downloadId); return true as const; } }),
  defineChannel({ name: IPC.MODELS_DELETE, kind: 'handle', handler: async ({ id }, ctx) => { await ctx.runtime?.engineManager.deleteModel(id); return true as const; } }),
  defineChannel({ name: IPC.MODELS_INSTALLED, kind: 'handle', handler: (_p, ctx) => ctx.runtime ? ctx.runtime.engineManager.installedModels() : [] }),
  // Resume an interrupted download from the manifest beside its .partial: no Hugging Face round trip.
  defineChannel({ name: IPC.MODELS_RESUME, kind: 'handle', handler: ({ modelId }, ctx) => ctx.runtime ? ctx.runtime.modelManager.resume(modelId) : { downloadId: '' } }),
  // The STORED settings, so the dialog can also show "Applies after the current reply" and the last load error.
  defineChannel({ name: IPC.MODELS_SETTINGS, kind: 'handle', handler: ({ modelId }, ctx) => ctx.runtime ? ctx.runtime.engineManager.modelSettings(modelId) : null }),
  // Every rejection (context too small, an engine option the binary does not know) THROWS with the reason the
  // dialog shows. The value saves at once and the engine is left alone until the current reply ends.
  defineChannel({ name: IPC.MODELS_SET_SETTINGS, kind: 'handle', handler: ({ modelId, patch }, ctx) => ctx.runtime ? ctx.runtime.engineManager.setModelSettings(modelId, patch ?? {}) : null }),
  // Returns the download id straight away; the bytes report on the ordinary models:download-progress stream.
  defineChannel({ name: IPC.MODELS_ADD_VISION, kind: 'handle', handler: ({ modelId }, ctx) => ctx.runtime ? ctx.runtime.modelManager.addVision(modelId) : null }),
  // The create-time / swap-time memory guard, and [Reload Model].
  defineChannel({
    name: IPC.MODELS_MEMORY_CHECK, kind: 'handle',
    handler: ({ modelId }, ctx) => ctx.runtime ? ctx.runtime.modelManager.memoryCheck(modelId) : { verdict: 'ok' as const, headline: '', detail: '' },
  }),
  defineChannel({ name: IPC.MODELS_LOAD, kind: 'handle', handler: async ({ modelId }, ctx) => { await ctx.runtime?.engineManager.loadModel(modelId); return true as const; } }),
];
