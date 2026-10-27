import type { QueueCheckout, QueueItem, QueuePayload } from './conversation-queue-types';

interface ConversationQueueIdentity { queueId: string; sendEpoch: string }
export type ConversationQueueAction =
  | { kind: 'identity' }
  | { kind: 'enqueue'; queueId: string; payload: QueuePayload }
  | { kind: 'remove' | 'dismiss'; itemId: string }
  | { kind: 'send-now'; itemId: string }
  | { kind: 'checkout'; itemId: string; token: QueueCheckout }
  | { kind: 'ack' | 'cancel'; token: QueueCheckout }
  | { kind: 'stop' | 'clear' }
  // Did this queue ever accept this send? Asked for a saved send whose answer was lost (submit-outgoing.ts settleSavedQueueSend).
  | { kind: 'lookup'; queueId: string; sendId: string };
export type ConversationQueueReply =
  | { status: 'unavailable' }
  | { status: 'identity'; identity: ConversationQueueIdentity }
  | { status: 'queued'; identity: ConversationQueueIdentity; itemId: string; sendId: string }
  | { status: 'reserved'; item: QueueItem }
  | { status: 'lookup'; identity: ConversationQueueIdentity; found: boolean }
  | { status: 'done'; /** Dismiss: the words to put back in the dismissing screen's empty message box. */ restore?: { text: string; attachments: string[] } }
  | { status: 'rejected' | 'unknown'; message: string };
export interface ConversationQueueBridge { action(sessionId: string, action: ConversationQueueAction): Promise<ConversationQueueReply> }
export interface ConversationQueueChannelTypes {
  'session:queue-action': { request: { sessionId: string; action: ConversationQueueAction }; response: ConversationQueueReply };
}
