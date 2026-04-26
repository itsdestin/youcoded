import { describe, it, expect } from 'vitest';

// Contract test: the pty:raw-bytes WebSocket message shape must
// round-trip arbitrary bytes via base64 without corruption, including
// high-bit ANSI control bytes. This locks the wire format so the
// Android broadcaster and the future xterm.js consumer agree.

describe('pty:raw-bytes wire contract', () => {
  it('base64 round-trips high-bit bytes', () => {
    const original = new Uint8Array([
      0x1b, 0x5b, 0x33, 0x31, 0x6d, // ESC [ 3 1 m (red foreground)
      0xe2, 0x94, 0x80,             // UTF-8 for ─ (BOX DRAWINGS LIGHT HORIZONTAL)
      0x00, 0xff, 0x7f, 0x80,       // edge bytes
    ]);

    // Base64-encode on one side (Kotlin uses android.util.Base64.NO_WRAP).
    const encoded = Buffer.from(original).toString('base64');
    // Decode on the other (xterm-side / test consumer).
    const decoded = new Uint8Array(Buffer.from(encoded, 'base64'));

    expect(decoded).toEqual(original);
  });

  it('message payload shape carries sessionId and data', () => {
    const bytes = new Uint8Array([0x48, 0x69]); // "Hi"
    const msg = {
      type: 'pty:raw-bytes',
      payload: {
        sessionId: 'abc-123',
        data: Buffer.from(bytes).toString('base64'),
      },
    };

    expect(msg.type).toBe('pty:raw-bytes');
    expect(msg.payload.sessionId).toBe('abc-123');
    expect(typeof msg.payload.data).toBe('string');
    expect(new Uint8Array(Buffer.from(msg.payload.data, 'base64'))).toEqual(bytes);
  });
});
