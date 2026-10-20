import { z } from 'zod';
import { IPC } from '../../shared/backend-contract';
import { defineChannel } from './channel-def';
import { sessionOpsWhenReady } from './session';
import type { ConversationQueueAction, ConversationQueueReply } from '../../shared/conversation-queue-channel-types';
const id = z.string().min(1).max(256).refine(s => !/[\x00-\x1f]/.test(s));
const token = z.object({ checkoutId: id, sessionId: id, draftRevision: z.number().int().nonnegative().safe(), sendEpoch: z.string().uuid().optional() }).strict();
const payload = z.object({ sendEpoch: z.string().uuid(), sendId: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/), originalText: z.string().max(262144), displayContent: z.string().max(262144), attachments: z.array(z.string().min(1).max(4096)).max(32) }).strict();
const request = z.object({ sessionId: id, action: z.discriminatedUnion('kind', [
 z.object({ kind: z.literal('identity') }).strict(), z.object({ kind: z.literal('enqueue'), queueId: z.string().uuid(), payload }).strict(),
 z.object({ kind: z.enum(['remove','send-now','dismiss']), itemId: id }).strict(), z.object({ kind: z.literal('checkout'), itemId: id, token }).strict(),
 z.object({ kind: z.enum(['ack','cancel']), token }).strict(), z.object({ kind: z.enum(['stop','clear']) }).strict(),
]) }).strict();
export const queueChannels = [defineChannel({ name: IPC.SESSION_QUEUE_ACTION, kind: 'handle', handler: async (value,ctx): Promise<ConversationQueueReply> => {
 const parsed = request.safeParse(value); if (!parsed.success) return { status: 'rejected', message: 'Invalid queue action.' };
 const { sessionId, action } = parsed.data; const ops = await sessionOpsWhenReady(ctx);
 if (ops.sessionManager.getSession(sessionId)?.provider === 'native') {
  // WHY delegate unchanged: the native host already owns its FIFO and interruption semantics.
  if (action.kind === 'remove' || action.kind === 'send-now') {
   const result = action.kind === 'remove' ? ops.nativeHost.removeQueued(sessionId,action.itemId) : ops.nativeHost.sendQueuedNow(sessionId,action.itemId);
   return result ? { status: 'done' } : { status: 'rejected', message: 'This message is no longer waiting.' };
  }
  return { status: 'unavailable' };
 }
 return ops.queueAction ? ops.queueAction(sessionId,action as ConversationQueueAction) : { status: 'unavailable' };
} })];
