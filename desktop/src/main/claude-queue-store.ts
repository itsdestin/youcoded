import { constants, promises as fs } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';
import { mutateFileUnderLock } from './artifacts/cas-write';
import type { QueueJournal, QueuePayload, QueueStorage } from '../shared/conversation-queue-types';

const id = z.string().min(1).max(256).regex(/^[^\x00-\x1f]+$/);
const uuid = z.string().uuid();
const sendId = z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/);
const text = z.string().max(262144).refine(s => !s.includes('\0'));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const alias = z.object({ provider: z.literal('claude'), conversationId: id }).strict();
const checkout = z.object({ checkoutId: id, sessionId: id, draftRevision: z.number().int().nonnegative().safe(), sendEpoch: uuid.optional() }).strict();
const attempt = z.object({ attemptId: uuid, queueItemId: uuid, sendId, alias, incarnation: id, boundaryId: id, boundarySeq: z.number().int().positive().safe(), wireHash: hash, createdAt: z.number().finite().nonnegative() }).strict();
const payloadBase = z.object({ sendEpoch: uuid, sendId, originalText: text, attachments: z.array(z.string().min(1).max(4096).refine(s => !s.includes('\0'))).max(32), displayContent: text, preparedAttachments: z.array(z.string().min(1).max(4096).refine(s=>!s.includes('\0'))).max(32).optional() }).strict();
const payload = payloadBase.refine(p => !!p.originalText.length || p.attachments.length > 0);
const item = payloadBase.extend({ queueItemId: uuid, timestamp: z.number().finite().nonnegative(), status: z.enum(['waiting', 'delivering', 'uncertain']), immediate: z.boolean().optional(), pauseBypass: z.boolean().optional(), checkout: checkout.optional(), attempt: attempt.extend({ admission: id.optional(), receipt: id.optional() }).optional() }).strict();
const tombstone = z.object({ sendEpoch: uuid, sendId, queueItemId: uuid, fingerprint: hash, reason: z.enum(['removed', 'edited', 'confirmed', 'dismissed']), checkout: checkout.optional(), attempt: attempt.optional(), transcriptUuid: id.optional(), nativeReceipt: id.optional(), nativeAdmission: id.optional() }).strict();
const journal = z.object({ version: z.literal(2), sendEpoch: uuid, queueId: uuid, revision: z.number().int().nonnegative().safe(), alias, aliases: z.array(alias).min(1).max(32), live: z.object({ incarnation: id }).strict().nullable(), paused: z.boolean(), pauseCause: id.optional(), items: z.array(item).max(64), tombstones: z.array(tombstone).max(1024), cancelledCheckouts: z.array(checkout).max(1024).default([]), legacyCheckoutEpoch: uuid.optional(), boundaryHighWater: z.number().int().nonnegative().safe(), quarantines: z.array(uuid).max(64), clear: z.object({ clearId: uuid, phase: z.enum(['frozen', 'executing', 'rebound']), aliasReserved: z.literal(true).optional() }).strict().nullable() }).strict();

export function validateQueuePayload(value: unknown): QueuePayload {
  const result = payload.safeParse(value);
  if (!result.success) throw Error('Invalid queue payload');
  return result.data;
}
export function validateQueueJournal(value: unknown): QueueJournal {
  const result = journal.safeParse(value);
  if (!result.success) throw Error('Invalid queue journal');
  const r = result.data;
  const aliases = r.aliases.map(a => JSON.stringify(a));
  if (new Set(aliases).size !== aliases.length || !aliases.includes(JSON.stringify(r.alias))) throw Error('Invalid queue journal identities');
  if (r.items.length + r.tombstones.length > 1024) throw Error('Queue identity history exceeds bounds');
  const confirmed = r.tombstones.flatMap(t => t.transcriptUuid ? [t.transcriptUuid] : []);
  if (new Set(confirmed).size !== confirmed.length) throw Error('Duplicate transcript confirmation');
  for (const t of r.tombstones) {
    if ((t.reason === 'confirmed') !== !!(t.attempt && t.transcriptUuid) || (t.reason === 'edited' && !t.checkout)
      || (t.attempt && (t.attempt.queueItemId !== t.queueItemId || t.attempt.sendId !== t.sendId))) throw Error('Invalid queue tombstone');
  }
  if ([...r.items, ...r.tombstones].some(i => i.sendEpoch !== r.sendEpoch)) throw Error('Invalid send epoch');
  if (r.clear?.phase === 'executing' && r.clear.aliasReserved !== true) throw Error('Clear alias slot was not reserved');
  const sends = [...r.items, ...r.tombstones].map(i => i.sendId);
  const ids = [...r.items, ...r.tombstones].map(i => i.queueItemId);
  if (new Set(sends).size !== sends.length || new Set(ids).size !== ids.length) throw Error('Duplicate queue item identity');
  const editTokens = [...r.items, ...r.tombstones].flatMap(i => i.checkout ? [i.checkout] : []).concat(r.cancelledCheckouts);
  if (editTokens.some(t => t.sendEpoch !== undefined && t.sendEpoch !== r.sendEpoch)) throw Error('Invalid checkout epoch');
  if (r.cancelledCheckouts.length + r.items.filter(i => i.checkout).length > 1024) throw Error('Checkout history exceeds bounds');
  const edits = editTokens.map(t => t.checkoutId);
  if (new Set(edits).size !== edits.length) throw Error('Duplicate queue checkout');
  let delivering = 0;
  for (const i of r.items) {
    if (!i.originalText.length && !i.attachments.length) throw Error('Empty queue payload');
    if ((i.status === 'waiting') !== !i.attempt || (i.checkout && i.status !== 'waiting')) throw Error('Invalid queue item state');
    if (i.attempt && (i.attempt.queueItemId !== i.queueItemId || i.attempt.sendId !== i.sendId || !aliases.includes(JSON.stringify(i.attempt.alias)))) throw Error('Invalid queue attempt identity');
    if (i.status === 'delivering') delivering++;
  }
  if (new Set(r.quarantines).size !== r.quarantines.length || r.quarantines.some(a => !r.items.some(i => i.attempt?.attemptId === a && !i.attempt.receipt))) throw Error('Invalid composer quarantine');
  if (delivering > 1 || (r.clear && r.clear.phase !== 'rebound' && !r.paused)) throw Error('Invalid queue dispatch state');
  return r;
}

const retiredJournal = z.object({ version: z.literal(2), retired: z.literal(true), queueId: uuid, revision: z.number().int().nonnegative().safe() }).strict();
export function canRetireQueue(r: QueueJournal): boolean {
  return r.live === null && r.items.length === 0 && r.tombstones.length === 0 && !r.quarantines.length && (!r.clear || r.clear.phase === 'rebound');
}

/** Instance-local private journals. Alias index is rebuilt from records, never a second fallible file. */
export class ClaudeQueueStore implements QueueStorage {
  static readonly MAX_BYTES = 2 * 1024 * 1024;
  static readonly MAX_QUEUES = 128;
  private readonly directory: string;
  constructor(userDataRoot: string) {
    if (!isAbsolute(userDataRoot)) throw Error('Queue storage root must be absolute');
    this.directory = join(userDataRoot, 'claude-queues');
  }
  private file(queueId: string): string { return join(this.directory, uuid.parse(queueId) + '.json'); }
  private async read(file: string): Promise<string | null> {
    let handle;
    try { handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > ClaudeQueueStore.MAX_BYTES) throw Error('Queue journal exceeds storage bounds');
      // WHY fixed allocation + capped read: stat is not a bound if another writer grows/replaces the file.
      const bytes = Buffer.alloc(ClaudeQueueStore.MAX_BYTES + 1); let length = 0;
      while (length < bytes.length) { const n = (await handle.read(bytes, length, bytes.length - length, null)).bytesRead; if (!n) break; length += n; }
      if (length > ClaudeQueueStore.MAX_BYTES) throw Error('Queue journal exceeds storage bounds');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    } finally { await handle.close(); }
  }
  async load(): Promise<QueueJournal[]> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const records: QueueJournal[] = []; const entries = await fs.opendir(this.directory);
    for await (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue; // lock/temp siblings are not committed journals
      if (!entry.isFile()) throw Error('Invalid queue store entry');
      const key = entry.name.slice(0, -5); const raw = await this.read(this.file(key));
      if (raw === null) throw Error('Queue journal disappeared during restore');
      const value: unknown = JSON.parse(raw);
      const retired = retiredJournal.safeParse(value);
      if (retired.success) {
        if (retired.data.queueId !== key) throw Error('Retired queue identity mismatch');
        await fs.unlink(this.file(key)); // interrupted retirement cleanup, never a runnable record
        continue;
      }
      if (records.length >= ClaudeQueueStore.MAX_QUEUES) throw Error('Queue registry full');
      const record = validateQueueJournal(value);
      if (record.queueId !== key) throw Error('Queue file identity mismatch');
      records.push(record);
    }
    return records;
  }
  async retire(queueId: string, expectedRevision: number): Promise<void> {
    // WHY CAS marker BEFORE unlink: a crash after the transition is recoverable, and a
    // stale writer can match neither the marker nor the absent record's revision.
    const written = await mutateFileUnderLock(this.file(queueId), raw => {
      if (raw === null) throw Error('Queue revision conflict');
      const value: unknown = JSON.parse(raw); const marker = retiredJournal.safeParse(value);
      if (marker.success) {
        // WHY: retirement already committed before a failed unlink. Only the EXACT
        // caller's committed revision may complete it; stale retries never delete newer data.
        if (marker.data.queueId !== queueId || marker.data.revision !== expectedRevision + 1) throw Error('Queue revision conflict');
        return null;
      }
      const previous = validateQueueJournal(value);
      if (previous.queueId !== queueId || previous.revision !== expectedRevision) throw Error('Queue revision conflict');
      if (!canRetireQueue(previous)) throw Error('Queue still has recoverable data');
      return JSON.stringify({ version: 2, retired: true, queueId, revision: expectedRevision + 1 });
    }, file => this.read(file));
    if (!written) throw Error('Queue storage lock unavailable');
    await fs.unlink(this.file(queueId));
  }
  async save(value: QueueJournal, expectedRevision: number | null): Promise<void> {
    const record = validateQueueJournal(value); const content = JSON.stringify(record);
    if (Buffer.byteLength(content, 'utf8') > ClaudeQueueStore.MAX_BYTES) throw Error('Queue journal exceeds storage bounds');
    if (record.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) throw Error('Invalid queue revision');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    // WHY bounded parse inside the existing mkdir lock: stale writers cannot overwrite a claim.
    // This is a capped private journal (2 MiB), not an unbounded conversation/history parse.
    const written = await mutateFileUnderLock(this.file(record.queueId), current => {
      const previous = current === null ? null : validateQueueJournal(JSON.parse(current));
      if ((previous?.revision ?? null) !== expectedRevision) throw Error('Queue revision conflict');
      return content;
    }, file => this.read(file));
    if (!written) throw Error('Queue storage lock unavailable');
  }
}
