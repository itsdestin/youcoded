import { MAX_SYNC_FILE_BYTES, validateSyncName } from '../sync-spaces/guards';

export interface TransferContext {
  transferNonce: string;
  sessionId: string;
  provider: 'claude' | 'native';
  requesterDeviceId: string;
  senderDeviceId: string;
}

export interface HandoffReceipt extends TransferContext {
  v: 1;
  byteLength: number;
  sha256: string;
}

// WHY: These fields eventually select a synced file. Reuse the cross-platform
// path-segment validator, then narrow its permissive names to bounded IDs only.
const safeId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 100 &&
  /^[A-Za-z0-9._-]+$/.test(value) && validateSyncName(value) === null;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/** Unknown synced content cannot supply a path, unexpected authority or unbounded size. */
export function parseHandoffReceipt(value: unknown): HandoffReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const keys = ['v', 'transferNonce', 'sessionId', 'provider', 'requesterDeviceId', 'senderDeviceId', 'byteLength', 'sha256'];
  // WHY: A whitelist projection would silently turn a conflict-copy or a
  // receipt with an attacker-supplied location into apparently valid evidence.
  if (Object.keys(r).length !== keys.length || Object.keys(r).some((key) => !keys.includes(key))) return null;
  if (r.v !== 1 || !uuid(r.transferNonce) || !safeId(r.sessionId) ||
      (r.provider !== 'claude' && r.provider !== 'native') ||
      !safeId(r.requesterDeviceId) || !safeId(r.senderDeviceId) ||
      typeof r.byteLength !== 'number' || !Number.isSafeInteger(r.byteLength) ||
      r.byteLength < 0 || r.byteLength > MAX_SYNC_FILE_BYTES ||
      typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256)) return null;
  return {
    v: 1, transferNonce: r.transferNonce, sessionId: r.sessionId,
    provider: r.provider, requesterDeviceId: r.requesterDeviceId,
    senderDeviceId: r.senderDeviceId, byteLength: r.byteLength, sha256: r.sha256,
  };
}

export function matchesHandoffReceipt(receipt: HandoffReceipt, expected: TransferContext): boolean {
  return parseHandoffReceipt(receipt) !== null &&
    receipt.transferNonce === expected.transferNonce &&
    receipt.sessionId === expected.sessionId && receipt.provider === expected.provider &&
    receipt.requesterDeviceId === expected.requesterDeviceId &&
    receipt.senderDeviceId === expected.senderDeviceId;
}
