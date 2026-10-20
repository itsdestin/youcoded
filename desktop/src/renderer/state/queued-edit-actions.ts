import type { QueueCheckout } from '../../shared/conversation-queue-types';
import { newSendId } from './send-ids';

export interface QueueDraftSnapshot { sessionId: string; revision: number; empty: boolean }
interface EditItem { queueItemId: string; originalText: string; attachments: string[] }
export interface QueuedEditApi {
  checkout(sessionId: string, itemId: string, token: QueueCheckout): Promise<{ status: 'reserved'; item: EditItem } | { status: 'unavailable' }>;
  ack(sessionId: string, token: QueueCheckout): Promise<void>;
  cancel(sessionId: string, token: QueueCheckout): Promise<void>;
}
export interface QueuedEditComposer {
  snapshot(): QueueDraftSnapshot | undefined;
  /** Atomically compare the actual current session/draft, then fill text AND files. False changes nothing. */
  fillIfCurrent(before: QueueDraftSnapshot, text: string, attachments: string[]): boolean;
}
export type QueuedEditOutcome = 'edited' | 'draft-busy' | 'session-changed' | 'draft-changed' | 'too-late' | 'unknown' | 'too-many-pending';
interface PendingEdit {
  before: QueueDraftSnapshot;
  token: QueueCheckout;
  phase: 'checkout' | 'ack' | 'cancel' | 'indeterminate';
  cancelOutcome?: QueuedEditOutcome;
}

/** One coordinator per mounted app/composer, never a module-global registry shared across views. */
export function createQueuedEditActions(options: { api: QueuedEditApi; composer: QueuedEditComposer; makeId?: () => string; maxPending?: number; storage?: {load():string|null;save(value:string):void} }): {
  edit(sessionId: string, itemId: string, sendEpoch?: string): Promise<QueuedEditOutcome>;
} {
  const pending = new Map<string, PendingEdit>();
  let restored=false;
  const persist=()=>options.storage?.save(JSON.stringify([...pending]));
  const restore=()=>{if(restored)return;const raw=options.storage?.load();if(raw){const entries=JSON.parse(raw);if(!Array.isArray(entries)||entries.length>128)throw Error('Invalid saved edits');for(const [key,value] of entries)pending.set(key,value);}restored=true;};
  const busy = new Map<string, Promise<QueuedEditOutcome>>();
  const limit = Math.max(1, Math.min(128, options.maxPending ?? 64));
  async function run(key: string, sessionId: string, itemId: string, sendEpoch?: string): Promise<QueuedEditOutcome> {
    try {
      restore();
      let entry = pending.get(key);
      if (!entry) {
        const before = options.composer.snapshot();
        if (!before || before.sessionId !== sessionId) return 'session-changed';
        if (!before.empty) return 'draft-busy';
        if (pending.size >= limit) return 'too-many-pending';
        // WHY: a retry belongs to the epoch in which its ownership request began, never the newest snapshot.
        entry = { before: { ...before }, token: { checkoutId: (options.makeId ?? newSendId)(), sessionId, draftRevision: before.revision, ...(sendEpoch ? { sendEpoch } : {}) }, phase: 'checkout' };
        pending.set(key, entry);persist(); // checkpoint token BEFORE checkout IPC, including a lost reply/reload
      }
      if (entry.phase === 'indeterminate') return 'unknown';
      if (entry.phase === 'checkout') {
        persist();
        const result = await options.api.checkout(sessionId, itemId, entry.token);
        if (result.status === 'unavailable') { pending.delete(key); persist(); return 'too-late'; }
        if (result.item.queueItemId !== itemId) {
          entry.phase = 'cancel'; entry.cancelOutcome = 'unknown';
        } else {
          // WHY: the draft/session can change during checkout. The composer performs the final
          // synchronous compare-and-fill; only an actual successful transfer may retire the host copy.
          let filled: boolean;
          try { filled = options.composer.fillIfCurrent(entry.before, result.item.originalText, [...result.item.attachments]); }
          catch { entry.phase = 'indeterminate'; return 'unknown'; }
          entry.phase = filled ? 'ack' : 'cancel';
          entry.cancelOutcome = 'draft-changed';
        }
      }
      persist(); // draft persistence belongs to atomic fillIfCurrent; phase/token must survive before ack
      if (entry.phase === 'ack') {
        // WHY: retain this token if the reply is lost. A retry acknowledges only; it never refills
        // the composer again or overwrites text the user added after the first successful refill.
        await options.api.ack(sessionId, entry.token);
        pending.delete(key); persist(); return 'edited';
      }
      await options.api.cancel(sessionId, entry.token);
      pending.delete(key); persist(); return entry.cancelOutcome ?? 'draft-changed';
    } catch {
      // A missing reply is not proof the host did nothing. Keep the phase/token for an idempotent retry.
      return 'unknown';
    }
  }
  return {
    edit(sessionId, itemId, sendEpoch) {
      const key = JSON.stringify([sessionId, itemId]);
      const current = busy.get(key); if (current) return current;
      let finish!: (outcome: QueuedEditOutcome) => void;
      const result = new Promise<QueuedEditOutcome>(resolve => { finish = resolve; });
      busy.set(key, result);
      const settle = (outcome: QueuedEditOutcome) => { busy.delete(key); finish(outcome); };
      void run(key, sessionId, itemId, sendEpoch).then(settle, () => settle('unknown'));
      return result;
    },
  };
}
