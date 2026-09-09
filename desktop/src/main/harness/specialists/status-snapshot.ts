import { createHash } from 'crypto';
import type { ModelMessage } from 'ai';

export type SpecialistLifecycleStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export interface SpecialistStatusSnapshotRecord {
  childId: string;
  title: string;
  agentType: string;
  status: SpecialistLifecycleStatus;
  delivered: boolean;
  stale: boolean;
  startedAt: number;
  rawReport?: string;
  reportPath?: string;
  failureText?: string;
}

interface NormalizedSpecialistStatusRecord {
  childId: string;
  title: string;
  agentType: string;
  status: SpecialistLifecycleStatus;
  delivered: false;
  stale: boolean;
  startedAt: number;
  reportDigest?: string;
  reportPath?: string;
  failureText?: string;
}

export interface SpecialistStatusSnapshot {
  version: 1;
  records: NormalizedSpecialistStatusRecord[];
}

export interface SpecialistStatusSnapshotUpdate {
  snapshot: SpecialistStatusSnapshot;
  message: string;
}

const STATUS_OPEN = '<specialists-status>';
const STATUS_CLOSE = '</specialists-status>';
const SNAPSHOT_PREFIX = '<!-- snapshot-v1:';

function reportDigest(value: string | undefined): string | undefined {
  return value === undefined ? undefined : createHash('sha256').update(value).digest('hex');
}

/** WHY: compare ledger facts rather than rendered elapsed-time text, so an ordinary
 * turn never rewrites the model's existing prefix merely because the clock moved. */
export function normalizeSpecialistStatusSnapshot(
  records: readonly SpecialistStatusSnapshotRecord[],
): SpecialistStatusSnapshot {
  return {
    version: 1,
    records: records
      .filter((record) => !record.delivered)
      .map((record) => ({
        childId: record.childId,
        title: record.title,
        agentType: record.agentType,
        status: record.status,
        delivered: false as const,
        stale: record.stale,
        startedAt: record.startedAt,
        reportDigest: reportDigest(record.rawReport),
        reportPath: record.reportPath,
        failureText: record.failureText,
      }))
      .sort((a, b) => a.childId.localeCompare(b.childId)),
  };
}

function equalityShape(snapshot: SpecialistStatusSnapshot): unknown {
  return snapshot.records.map(({ startedAt: _elapsedOnly, ...record }) => record);
}

export function specialistStatusSnapshotsEqual(
  left: SpecialistStatusSnapshot | null,
  right: SpecialistStatusSnapshot,
): boolean {
  return left !== null && JSON.stringify(equalityShape(left)) === JSON.stringify(equalityShape(right));
}

function statusLine(record: NormalizedSpecialistStatusRecord, now: number, staleMinutes: number): string {
  switch (record.status) {
    case 'running': {
      const elapsedS = Math.max(0, Math.round((now - record.startedAt) / 1_000));
      const staleNote = record.stale ? `, may be stuck — no activity for at least ${staleMinutes}m` : '';
      return `${record.title} (${record.agentType}): running — ${elapsedS}s${staleNote}`;
    }
    case 'completed':
      return `${record.title} (${record.agentType}): finished — report delivery pending`;
    case 'failed':
      return `${record.title} (${record.agentType}): failed${record.failureText ? ` — ${record.failureText}` : ''} — report delivery pending`;
    case 'interrupted':
      return `${record.title} (${record.agentType}): interrupted — no report will arrive`;
    default: {
      const exhaustive: never = record.status;
      return exhaustive;
    }
  }
}

function encodeSnapshot(snapshot: SpecialistStatusSnapshot): string {
  return Buffer.from(JSON.stringify(snapshot), 'utf8').toString('base64');
}

/** Returns only a meaningful append. Empty-with-no-prior-state is deliberately silent. */
export function specialistStatusUpdate(
  previous: SpecialistStatusSnapshot | null,
  current: SpecialistStatusSnapshot,
  now = Date.now(),
  staleMinutes = 2,
  forceKnownEmpty = false,
): SpecialistStatusSnapshotUpdate | null {
  if (specialistStatusSnapshotsEqual(previous, current)) return null;
  if (previous === null && current.records.length === 0 && !forceKnownEmpty) return null;

  const lines = current.records.length > 0
    ? current.records.map((record) => statusLine(record, now, staleMinutes))
    : ['No specialist status is currently reportable.'];
  const authority = previous === null
    ? 'This is the current specialist status snapshot.'
    : 'This snapshot supersedes all earlier specialist status snapshots.';
  return {
    snapshot: current,
    message: `${STATUS_OPEN}\n${authority}\n${lines.join('\n')}\n${SNAPSHOT_PREFIX}${encodeSnapshot(current)} -->\n${STATUS_CLOSE}`,
  };
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isNormalizedRecord(value: unknown): value is NormalizedSpecialistStatusRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.childId === 'string'
    && typeof record.title === 'string'
    && typeof record.agentType === 'string'
    && (record.status === 'running' || record.status === 'completed'
      || record.status === 'failed' || record.status === 'interrupted')
    && record.delivered === false
    && typeof record.stale === 'boolean'
    && typeof record.startedAt === 'number'
    && Number.isFinite(record.startedAt)
    && (record.reportDigest === undefined
      || (typeof record.reportDigest === 'string' && /^[a-f0-9]{64}$/.test(record.reportDigest)))
    && isOptionalString(record.reportPath)
    && isOptionalString(record.failureText);
}

function isSnapshot(value: unknown): value is SpecialistStatusSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.version !== 1 || !Array.isArray(snapshot.records)) return false;
  const childIds = new Set<string>();
  for (const record of snapshot.records) {
    if (!isNormalizedRecord(record) || childIds.has(record.childId)) return false;
    childIds.add(record.childId);
  }
  return true;
}

function decodeSnapshot(content: string): SpecialistStatusSnapshot | null {
  const marker = content.indexOf(SNAPSHOT_PREFIX);
  if (!content.startsWith(STATUS_OPEN) || marker < 0) return null;
  const end = content.indexOf(' -->', marker);
  if (end < 0) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(content.slice(marker + SNAPSHOT_PREFIX.length, end), 'base64').toString('utf8'));
    // WHY: history is user-controlled on resume; accepting a lookalike record
    // with the wrong shape can poison comparison and suppress every later update.
    return isSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Recover only snapshots emitted by this helper; legacy rendered blocks are unknown. */
export function recoverSpecialistStatusSnapshot(messages: readonly ModelMessage[]): SpecialistStatusSnapshot | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index]?.content;
    if (typeof content !== 'string') continue;
    const snapshot = decodeSnapshot(content);
    if (snapshot) return snapshot;
  }
  return null;
}
