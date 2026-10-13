import type { ModelMessage } from 'ai';
import { finalizeRemainingCalls } from './tool-group-finalization';

/** One part a user message carries after its text: a delivered picture, or a
 *  note naming a picture the model did not get. */
export type UserPart = { type: 'file'; mediaType: string; data: Buffer } | { type: 'text'; text: string };
/** What the model is handed per attachment: a path (original or prepared
 *  derivative), the original plus the preparer's refusal reason, or a prepared
 *  derivative plus the ORIGINAL's size (so the model can be told it was shrunk). */
export type ModelAttachment = string | { path: string; prepareFailed: string } | { path: string; original: { path: string; width: number; height: number } };
type OriginalSize = { width: number; height: number };

/** The `user-message` event data for a human send. `modelAttachments` is
 *  persisted (as paths) only when it differs from `attachments` — a prepared
 *  copy stood in for an original — so ordinary sends keep today's exact shape.
 *  A failed preparation persists its original path, so reopen re-gates it.
 *  `originalSizes` (parallel, null where not downscaled) is persisted only when a
 *  prepared copy stood in. WHY persisted: reopen must write the same "downscaled"
 *  note, and re-reading the original's header there would be a new blocking read.
 *  WHY here: it is shared by the opening send and the busy-message claim, and
 *  this file owns that shared boundary (and harness-session.ts its line budget). */
export function userMessageData(text: string, attachments: string[], modelAttachments?: ModelAttachment[]):
  { text: string; attachments?: string[]; modelAttachments?: string[]; originalSizes?: Array<OriginalSize | null> } {
  if (!attachments.length) return { text };
  const persisted = modelAttachments?.map((m) => typeof m === 'string' ? m : m.path);
  const sizes = modelAttachments?.map((m): OriginalSize | null => typeof m !== 'string' && 'original' in m ? { width: m.original.width, height: m.original.height } : null);
  return { text, attachments,
    ...(persisted && persisted.some((p, i) => p !== attachments[i]) ? { modelAttachments: persisted } : {}),
    ...(sizes?.some(Boolean) ? { originalSizes: sizes } : {}) };
}

export interface BusyMessage {
  id: string;
  text: string;
  attachments: string[];
  /** WHY: a message queued while a turn ran must still reach the model as its
   *  prepared copy — parallel to `attachments`, absent when they are the same. */
  modelAttachments?: ModelAttachment[];
  restore?: () => void;
}

/** WHY: the claim and acceptance are one synchronous boundary. An exception
 * returns the unaccepted head to its host, rather than losing a queued send. */
export function claimBusyMessage(
  take: (() => BusyMessage | undefined) | undefined,
  accept: (item: BusyMessage) => void,
  beforeAccept?: () => void,
): boolean {
  const item = take?.();
  if (!item) return false;
  try {
    beforeAccept?.();
    accept(item);
  } catch (err) {
    item.restore?.();
    throw err;
  }
  return true;
}

/** WHY: the emitted event is the authority for both live and rebuilt history;
 * no synthetic steer or app-generated marker is used for human input. */
export function appendUserHistory(
  text: string, modelPaths: ModelAttachment[], emit: () => string, appGenerated: boolean,
  imageParts: (paths: ModelAttachment[]) => UserPart[],
  markAppGenerated: (message: ModelMessage) => ModelMessage,
  history: ModelMessage[], origins: Array<string[] | null>, record: (uuid: string) => void,
): void {
  const parts = imageParts(modelPaths);
  const uuid = emit();
  // WHY parts may be notes: an attachment the gate refused is a trailing text
  // part naming it, so the model is told rather than left to assume it saw it.
  const message = (parts.length
    ? { role: 'user', content: [{ type: 'text', text }, ...parts] } as ModelMessage
    : { role: 'user', content: text } as ModelMessage);
  history.push(appGenerated ? markAppGenerated(message) : message);
  origins.push([uuid]);
  record(uuid);
}

/** Pair every unstarted call before adding new human input. Already completed
 * results stay at the front of the same tool message. */
export function supersedeToolGroup<TCall extends { toolCallId: string; toolName: string }, TPart>(
  calls: readonly TCall[], from: number, completed: TPart[], completedOrigins: string[],
  emit: (data: { toolUseId: string; toolName: string; toolResult: string; isError: true }) => string,
  part: (call: TCall, text: string) => TPart,
  record: (uuid: string) => void, commit: (parts: TPart[], origins: string[]) => void,
  injectCompleted: (calls: TCall[]) => void,
  reason = 'Not run: new user input arrived before this action started.',
  afterCompleted?: () => void,
): void {
  const remaining = finalizeRemainingCalls(calls, from,
    () => reason,
    (call, text) => emit({ toolUseId: call.toolCallId, toolName: call.toolName, toolResult: text, isError: true }), part);
  remaining.origins.forEach(record);
  commit([...completed, ...remaining.parts], [...completedOrigins, ...remaining.origins]);
  injectCompleted(calls.slice(0, from));
  afterCompleted?.();
}
