import type { ModelMessage } from 'ai';
import { finalizeRemainingCalls } from './tool-group-finalization';

export interface BusyMessage {
  id: string;
  text: string;
  attachments: string[];
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
  text: string, attachments: string[], emit: () => string, appGenerated: boolean,
  imageParts: (paths: string[]) => Array<{ type: 'file'; mediaType: string; data: Buffer }>,
  markAppGenerated: (message: ModelMessage) => ModelMessage,
  history: ModelMessage[], origins: Array<string[] | null>, record: (uuid: string) => void,
): void {
  const images = imageParts(attachments);
  const uuid = emit();
  const message = (images.length
    ? { role: 'user', content: [{ type: 'text', text }, ...images] } as ModelMessage
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
