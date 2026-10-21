import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { createConversationStore } from '../conversations/conversation-store';
import { createTagRegistry } from '../conversations/tag-registry';
import { ccProjectSlug, nativeStoreSlug } from '../slug-encoding';
import { refreshChatsearchIndex, resolveTranscriptPathTwoStep } from './refresh-core';
import type { IndexJob, IndexReply } from './index-worker-runner';

// WHY load records here, not via workerData: list() awaits IO but still parses
// records and repairs conflicts on its caller's thread. Cloning the complete
// collection into workerData would also leave history-sized work on main.
async function refresh(job: IndexJob): Promise<boolean> {
  const store = createConversationStore(job.storeRoot);
  const lanes = await Promise.all((['claude', 'native'] as const).map(async (provider) => ({
    provider, lane: provider,
    records: await store.list(provider).catch(() => []),
    resolveTranscriptPath: (rec: import('../conversations/store-core').ConversationRecord) => {
      // Preserve the frozen native slug; CC's Windows drive casing differs.
      const local = provider === 'claude'
        ? path.join(job.homeRoot, '.claude', 'projects', ccProjectSlug(rec.originalPath), `${rec.id}.jsonl`)
        : path.join(job.homeRoot, '.youcoded', 'sessions', nativeStoreSlug(rec.originalPath), `${rec.id}.jsonl`);
      return resolveTranscriptPathTwoStep(rec, local, job.storeRoot);
    },
  })));
  const tagLabels = new Map<string, string>();
  // WHY reuse the registry IO shell: preserve conflict folding and tombstones,
  // but keep synchronous tag parsing off main too. Unavailable means unlabeled.
  try {
    if (job.tagsRoot !== null) {
      for (const tag of await createTagRegistry(job.tagsRoot).list()) tagLabels.set(tag.id, tag.label);
    }
  } catch { /* unlabeled is acceptable; an empty conversation index is not */ }
  return refreshChatsearchIndex({ ...job, lanes, tagLabels });
}

void refresh(workerData as IndexJob).then(
  (value) => { parentPort?.postMessage({ ok: true, value } satisfies IndexReply); },
  (error: unknown) => { parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies IndexReply); },
);
