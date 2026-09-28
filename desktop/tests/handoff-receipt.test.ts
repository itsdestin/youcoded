import { describe, expect, it } from 'vitest';
import { matchesHandoffReceipt, parseHandoffReceipt, type TransferContext } from '../src/main/conversations/handoff-receipt';
import { MAX_SYNC_FILE_BYTES } from '../src/main/sync-spaces/guards';

const nonce = '3db07e20-1244-4a1b-85bf-bde2db925e41';
const otherNonce = 'ab63d487-d312-4ba3-a2b3-bf61f2231b59';
const receipt: TransferContext & { v: number; byteLength: number; sha256: string } = {
  v: 1, transferNonce: nonce, sessionId: 'c0911cd0-e7c8-425c-861a-f6b7f2256313',
  provider: 'claude', requesterDeviceId: 'requester-1', senderDeviceId: 'sender-1',
  byteLength: 0, sha256: 'a'.repeat(64),
};

describe('handoff receipt', () => {
  it('accepts only an exact bounded receipt and matches every transfer identity', () => {
    const parsed = parseHandoffReceipt(receipt)!;
    expect(parsed).toEqual(receipt);
    expect(matchesHandoffReceipt(parsed, receipt)).toBe(true);
    for (const change of [
      { transferNonce: otherNonce }, { sessionId: 'd0911cd0-e7c8-425c-861a-f6b7f2256313' },
      { provider: 'native' }, { requesterDeviceId: 'requester-2' }, { senderDeviceId: 'sender-2' },
    ]) {
      expect(matchesHandoffReceipt(parsed, { ...receipt, ...change } as typeof receipt)).toBe(false);
    }
    expect(parseHandoffReceipt({ ...receipt, provider: 'native', byteLength: MAX_SYNC_FILE_BYTES })).not.toBeNull();
  });

  it('rejects invalid version, provider, UUID nonce, path-unsafe identities, hash and length', () => {
    for (const change of [
      { v: 2 }, { v: '1' }, { provider: 'shell' }, { transferNonce: 'not-a-uuid' },
      { transferNonce: `${nonce}/../x` }, { sessionId: '../escape' }, { sessionId: 'CON' },
      { requesterDeviceId: '../escape' }, { senderDeviceId: 'a\\b' },
      { requesterDeviceId: '' }, { senderDeviceId: 'x'.repeat(101) },
      { sha256: 'g'.repeat(64) }, { sha256: 'A'.repeat(64) },
      { byteLength: -1 }, { byteLength: 0.5 }, { byteLength: MAX_SYNC_FILE_BYTES + 1 },
      { byteLength: '2' },
    ]) expect(parseHandoffReceipt({ ...receipt, ...change })).toBeNull();
    expect(parseHandoffReceipt(null)).toBeNull();
    expect(parseHandoffReceipt([])).toBeNull();
  });

  it('rejects extra fields rather than letting receipt metadata smuggle a path or authority', () => {
    expect(parseHandoffReceipt({ ...receipt, transcriptPath: '../../private' })).toBeNull();
    expect(parseHandoffReceipt({ ...receipt, requester: 'different' })).toBeNull();
    expect(parseHandoffReceipt({ ...receipt, path: '/tmp' })).toBeNull();
  });
});
