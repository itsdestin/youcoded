// R-4 phase 2 guard: every per-chat Map/Set held by the main-side owners of chat state is listed here with how it is put away.
// WHY: the review could not say which of ~100 lists leak, and a new one can be added silently. Adding a list to one of these
// files now fails this test until you say how it is cleaned: 'forget' (the owner's own forget()/destroy() path, proven by
// session-cleanup-leak.test.ts or native-host-leak.test.ts), 'registry' (signed up with SessionManager.onSessionClose),
// or 'exempt: <why>' (bounded, or not per chat). The list below was audited 2026-11-18 by reading every delete site.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const F = 'forget';
const LISTS: Record<string, Record<string, string>> = {
  'session-manager.ts': { sessions: F, handoffStops: F, handoffStopping: F, ptySizes: F, inputBlocked: F },
  'session-live.ts': { timers: F, lastCompactStart: F, clearTimers: F, lastClearAt: F, popupTimers: F, pendingModel: F, directReceipts: F, outputTails: F, firstOutputAt: F, stopTargets: F },
  'session-screens.ts': { per: F, sizes: F, queueWaiters: F },
  'session-record.ts': { records: F, gone: 'exempt: tombstones, capped at TOMBSTONES_MAX', extraSummaryListeners: 'exempt: app-wide listeners, not per chat' },
  'harness/native-session-host.ts': {
    live: F, modelRefs: 'exempt: keyed by model, released per chat', specialistMetaByChildId: F,
    modeFor: 'exempt: one short word per chat, kept on purpose so the chosen mode survives close and resume',
    rememberedFor: F, childrenOf: F, takenNamesOf: F, specialistSlots: F, activeWriterChild: F, specialistSpawnCounts: F,
    pendingDeliveryParents: F, inMemoryFallback: F, pendingHostNotices: F, shellRegistries: F, shellSidecars: F, shellRestores: F,
    drainingShellRegistries: 'exempt: emptied when the kill settles', unwrittenOutcomes: 'exempt: emptied by its own bounded retries',
    presetIdFor: F, lastQueueAnnounced: F, receipts: 'exempt: a local variable inside one function', destroying: 'exempt: holds a teardown only while it runs',
  },
};

const FIELD = /^[ \t]*(?:private |readonly |public )*([A-Za-z_]+)[!?]?(?:: [^=\n]+)? = new (?:Map|Set)\b/gm;

describe('per-chat lists are all accounted for', () => {
  for (const [file, expected] of Object.entries(LISTS)) {
    it(file, () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', file), 'utf8');
      const found = [...src.matchAll(FIELD)].map((m) => m[1]).sort();
      expect(found).toEqual(Object.keys(expected).sort());
    });
  }
});
