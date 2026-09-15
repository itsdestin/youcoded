import { requiredRead, passiveRead } from './path-access';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export interface InstructionDownloadRequest {
  id: string; sessionId: string; file: string; phase: 'ask' | 'denied' | 'waiting';
}
interface PendingInstruction {
  request: InstructionDownloadRequest; token: string;
  resolve(content: string): void; reject(error: Error): void;
}
const requests = new Map<string, PendingInstruction>();
const released = new Map<string, number>();
/** Revokes interest, not the provider's in-flight download. Only this session's
 * waiting promises are rejected; other sessions and their consent are untouched. */
export function releaseInstructionRequests(sessionId: string): void {
  released.set(sessionId, (released.get(sessionId) ?? 0) + 1);
  for (const [id, pending] of requests) if (pending.request.sessionId === sessionId) {
    requests.delete(id); pending.reject(new Error('Conversation closed while waiting for instructions.'));
  }
  changed();
}
export const instructionDownloadEvents = new EventEmitter();
function changed() { instructionDownloadEvents.emit('changed'); }
export function listInstructionDownloads(sessionId: string): InstructionDownloadRequest[] {
  return [...requests.values()].filter(p => p.request.sessionId === sessionId).map(p => ({ ...p.request }));
}

/** Native startup waits here. Not now parks ONLY this conversation; it does not
 * silently strip instructions, block the main thread, or authorize later reads. */
export async function readRequiredInstructionFile(filePath: string, sessionId: string): Promise<string> {
  const generation = released.get(sessionId) ?? 0;
  const result = await requiredRead(filePath, sessionId);
  if (generation !== (released.get(sessionId) ?? 0)) throw new Error('Conversation closed while checking instructions.');
  if (result.ok) return result.bytes.toString('utf8');
  if (result.error !== 'needs-download' || !('operationToken' in result) || !result.operationToken)
    throw new Error(`Instructions unavailable (${result.error}); conversation has not started.`);
  if (requests.size >= 32) throw new Error('Too many conversations are waiting for instruction downloads.');
  return new Promise<string>((resolve, reject) => {
    const id = randomUUID();
    requests.set(id, { request: { id, sessionId, file: filePath, phase: 'ask' }, token: result.operationToken!, resolve, reject });
    changed();
  });
}

/** A renderer supplies a request id and decision, never a pathname or read token.
 * The pending server record is the ONLY source of the operation and session scope. */
export async function answerInstructionDownload(id: string, sessionId: string, action: string): Promise<{ ok: boolean }> {
  const pending = requests.get(id);
  if (!pending || pending.request.sessionId !== sessionId || pending.request.phase === 'waiting') return { ok: false };
  if (action === 'deny' || action === 'review') {
    pending.request.phase = action === 'deny' ? 'denied' : 'ask'; changed(); return { ok: true };
  }
  if (action !== 'allow') return { ok: false };
  pending.request.phase = 'waiting'; changed();
  try {
    const result = await requiredRead(pending.request.file, sessionId, { operationToken: pending.token });
    if (!result.ok && result.error === 'needs-download' && 'operationToken' in result && result.operationToken) {
      pending.token = result.operationToken; pending.request.phase = 'ask'; changed(); return { ok: false };
    }
    requests.delete(id); changed();
    if (result.ok) pending.resolve(result.bytes.toString('utf8'));
    else pending.reject(new Error(`Instructions unavailable (${result.error}); conversation has not started.`));
  } catch (error) {
    requests.delete(id); changed(); pending.reject(error instanceof Error ? error : new Error('Instruction download failed.'));
  }
  return { ok: true };
}
export async function readPassiveFileText(filePath: string): Promise<string | null> {
  const bytes = await passiveRead(filePath);
  return bytes?.toString('utf8') ?? null;
}
