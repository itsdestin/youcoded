import type { QueueCheckout, QueueItem, QueuePayload } from './conversation-queue-types';

interface ConversationQueueIdentity { queueId: string; sendEpoch: string }
export type ConversationQueueAction =
  | { kind: 'identity' }
  | { kind: 'enqueue'; queueId: string; payload: QueuePayload }
  | { kind: 'remove' | 'dismiss'; itemId: string }
  | { kind: 'send-now'; itemId: string }
  | { kind: 'checkout'; itemId: string; token: QueueCheckout }
  | { kind: 'ack' | 'cancel'; token: QueueCheckout }
  | { kind: 'stop' | 'clear' };
export type ConversationQueueReply =
  | { status: 'unavailable' }
  | { status: 'identity'; identity: ConversationQueueIdentity }
  | { status: 'queued'; identity: ConversationQueueIdentity; itemId: string; sendId: string }
  | { status: 'reserved'; item: QueueItem }
  | { status: 'done' }
  | { status: 'rejected' | 'unknown'; message: string };
export interface ConversationQueueBridge { action(sessionId: string, action: ConversationQueueAction): Promise<ConversationQueueReply> }
export interface ConversationQueueChannelTypes {
  'session:queue-action': { request: { sessionId: string; action: ConversationQueueAction }; response: ConversationQueueReply };
}
