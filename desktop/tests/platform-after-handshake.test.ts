// Pins the 2026-11-01 finding: the Android app must stay 'android' after its backend handshake.
import { describe, it, expect } from 'vitest';
import { platformAfterHandshake } from '../src/renderer/platform';

const base = { current: 'android', isFilePage: true, preserve: false, touchFirst: true, hostPlatform: 'desktop' };

describe('platformAfterHandshake', () => {
  it('Android app talking to its own phone backend stays android', () => {
    expect(platformAfterHandshake({ ...base, hostPlatform: 'android' })).toBe('android');
  });
  it('Android app paired to a computer stays android', () => {
    expect(platformAfterHandshake({ ...base, preserve: true, hostPlatform: 'electron' })).toBe('android');
  });
  it('a phone web browser becomes browser', () => {
    expect(platformAfterHandshake({ ...base, current: undefined, isFilePage: false })).toBe('browser');
  });
  it('a mouse-first browser takes the host answer', () => {
    expect(platformAfterHandshake({ ...base, current: undefined, isFilePage: false, touchFirst: false, hostPlatform: 'desktop' })).toBe('desktop');
  });
});
