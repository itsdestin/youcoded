/** Host-owned queue data only; no renderer/transport/global state and no inferred model intent. */
export interface QueueAlias { provider: 'claude'; conversationId: string }
export interface QueuePayload { sendEpoch: string; sendId: string; originalText: string; attachments: string[]; displayContent: string; preparedAttachments?: string[] }
export interface QueueCheckout { checkoutId: string; sessionId: string; draftRevision: number; sendEpoch?: string }
export interface QueueAttempt {
  attemptId: string;
  queueItemId: string;
  sendId: string;
  alias: QueueAlias;
  incarnation: string;
  boundaryId: string;
  boundarySeq: number;
  wireHash: string;
  createdAt: number;
}
export interface QueueItem extends QueuePayload {
  queueItemId: string;
  timestamp: number;
  status: 'waiting' | 'delivering' | 'uncertain';
  checkout?: QueueCheckout;
  /** Host classified this new intent as idle-ready; not a time-based visibility delay. */
  immediate?: boolean;
  /** Fresh deliberate intent may run independently of older paused waiting messages. */
  pauseBypass?: boolean;
  /** Admission is the native CAS claim, NOT successful next(e) acceptance. */
  attempt?: QueueAttempt & { admission?: string; receipt?: string };
}
export interface QueueTombstone {
  sendId: string;
  sendEpoch: string;
  queueItemId: string;
  fingerprint: string;
  reason: 'removed' | 'edited' | 'confirmed' | 'dismissed';
  checkout?: QueueCheckout;
  attempt?: QueueAttempt;
  transcriptUuid?: string;
  nativeReceipt?: string;
  nativeAdmission?: string;
}
export interface QueueJournal {
  version: 2;
  sendEpoch: string;
  queueId: string;
  revision: number;
  alias: QueueAlias;
  aliases: QueueAlias[];
  live: { incarnation: string } | null;
  paused: boolean;
  /** WHY (2026-10-22): the ONE attempt whose trouble paused a running queue. Resolving exactly that
   *  lets the rest continue; any other pause (restart, Clear, identity change) deletes it, so those stay paused as before. */
  pauseCause?: string;
  items: QueueItem[];
  tombstones: QueueTombstone[];
  /** Bounded terminal checkout identities in this send epoch; stale retries cannot reserve again. */
  cancelledCheckouts: QueueCheckout[];
  /** Epoch-less legacy local callers are admitted only in the queue's original epoch. */
  legacyCheckoutEpoch?: string;
  /** Monotonic sequence high-water within this live incarnation; old/equal fences never recur. */
  boundaryHighWater: number;
  /** Attempts whose staged composer/admission outcome is not safe for further automated writes. */
  quarantines: string[];
  clear: { clearId: string; phase: 'frozen' | 'executing' | 'rebound'; aliasReserved?: true } | null;
}
export interface QueueStorage {
  load(): Promise<QueueJournal[]>;
  /** Atomic compare-and-swap; null requires absence. Rejection must never grant a delivery token. */
  save(record: QueueJournal, expectedRevision: number | null): Promise<void>;
  /** CAS retire only a closed, empty queue; old queueId requests must not recreate it. */
  retire(queueId: string, expectedRevision: number): Promise<void>;
}
export interface QueueClaimInput { boundaryId: string; boundarySeq: number; incarnation: string; alias: QueueAlias; wireHash: string; expectedItemId?: string }
export interface QueueClaim { item: QueueItem; attempt: QueueAttempt }
export interface QueueEnqueueResult { duplicate: boolean; item: QueueItem | QueueTombstone }
