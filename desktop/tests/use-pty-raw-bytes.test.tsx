// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

import { usePtyRawBytes } from '../src/renderer/hooks/usePtyRawBytes';

// Helper: install a fake window.claude that captures the registered handler so
// tests can manually fire incoming messages.
function installClaudeMock(): { fire: (sessionId: string, base64: string) => void } {
  const handlers = new Map<string, (data: string) => void>();
  (globalThis as any).window.claude = {
    on: {
      ptyRawBytesForSession: (sessionId: string, cb: (data: string) => void) => {
        const ch = `pty:raw-bytes:${sessionId}`;
        handlers.set(ch, cb);
        return () => handlers.delete(ch);
      },
    },
  };
  return {
    fire: (sessionId, base64) => {
      const cb = handlers.get(`pty:raw-bytes:${sessionId}`);
      if (cb) cb(base64);
    },
  };
}

function HookProbe({ sessionId, onData }: { sessionId: string | null; onData: (b: Uint8Array) => void }) {
  usePtyRawBytes(sessionId, onData);
  return null;
}

describe('usePtyRawBytes', () => {
  beforeEach(() => {
    (globalThis as any).window = (globalThis as any).window ?? {};
  });
  afterEach(() => {
    cleanup();
    delete (globalThis as any).window.claude;
  });

  it('decodes base64 payload to Uint8Array and invokes callback', () => {
    const { fire } = installClaudeMock();
    const onData = vi.fn();
    render(<HookProbe sessionId="sess-1" onData={onData} />);

    // "Hello" in base64
    act(() => {
      fire('sess-1', 'SGVsbG8=');
    });

    expect(onData).toHaveBeenCalledTimes(1);
    const bytes = onData.mock.calls[0][0] as Uint8Array;
    expect(Array.from(bytes)).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  });

  it('round-trips high-bit ANSI bytes (e.g. ESC sequences)', () => {
    const { fire } = installClaudeMock();
    const onData = vi.fn();
    render(<HookProbe sessionId="sess-1" onData={onData} />);

    // ESC [ 3 1 m  +  UTF-8 box-drawing  +  edge bytes (0x00, 0xff, 0x7f, 0x80)
    const original = new Uint8Array([
      0x1b, 0x5b, 0x33, 0x31, 0x6d,
      0xe2, 0x94, 0x80,
      0x00, 0xff, 0x7f, 0x80,
    ]);
    const base64 = btoa(String.fromCharCode(...original));

    act(() => {
      fire('sess-1', base64);
    });

    expect(onData).toHaveBeenCalledTimes(1);
    expect(Array.from(onData.mock.calls[0][0] as Uint8Array)).toEqual(Array.from(original));
  });

  it('silently ignores malformed base64 (does not throw, does not invoke callback)', () => {
    const { fire } = installClaudeMock();
    const onData = vi.fn();
    render(<HookProbe sessionId="sess-1" onData={onData} />);

    // '!!!' is not valid base64
    act(() => {
      fire('sess-1', '!!!');
    });

    expect(onData).not.toHaveBeenCalled();
  });

  it('does nothing when sessionId is null', () => {
    installClaudeMock();
    const onData = vi.fn();
    // Should not throw on mount
    render(<HookProbe sessionId={null} onData={onData} />);
    expect(onData).not.toHaveBeenCalled();
  });

  it('uses the latest callback after re-render (via cbRef pattern)', () => {
    const { fire } = installClaudeMock();
    const first = vi.fn();
    const second = vi.fn();

    const { rerender } = render(<HookProbe sessionId="sess-1" onData={first} />);

    rerender(<HookProbe sessionId="sess-1" onData={second} />);

    act(() => {
      fire('sess-1', 'SGk='); // "Hi"
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
