// Pins the artifact-write security boundary (D5, resolved 2026-07-22). The
// fixture is SHARED with the Kotlin port (EditablePathPolicyTest.kt) so both
// platforms return identical verdicts — Android implements artifacts:save for
// real, so a TS-only policy would leave the same React UI calling an unguarded
// Kotlin write path.
import { describe, expect, it } from 'vitest';
import {
  editTier,
  protectedReadPath,
  looksBinary,
  isDotenvBasename,
  privateForRecordTrust,
} from '../../src/shared/artifacts/editable-path-policy';
import fixtures from '../../../shared-fixtures/artifacts/editable-path-policy-cases.json';

describe('editTier / protectedReadPath (shared fixture)', () => {
  for (const c of fixtures.cases) {
    it(`${c.path} → ${c.tier}${c.protectedRead ? ' (read-protected)' : ''}`, () => {
      expect(editTier(c.path)).toBe(c.tier);
      expect(protectedReadPath(c.path)).toBe(c.protectedRead);
    });
  }

  it('fixture covers every tier', () => {
    const tiers = new Set(fixtures.cases.map((c) => c.tier));
    expect(tiers).toEqual(new Set(['free', 'needs-confirm', 'denied']));
  });
});

describe('privateForRecordTrust (shared fixture)', () => {
  for (const c of fixtures.recordPrivate) {
    it(`${c.path} → ${c.private ? 'refused' : 'allowed'} as a recorded path`, () => {
      expect(privateForRecordTrust(c.path)).toBe(c.private);
    });
  }
  it('refuses everything editTier does not rate free', () => {
    for (const c of fixtures.cases) if (c.tier !== 'free') expect(privateForRecordTrust(c.path)).toBe(true);
  });
});

describe('isDotenvBasename', () => {
  it('matches the dotenv family and nothing else', () => {
    expect(isDotenvBasename('.env')).toBe(true);
    expect(isDotenvBasename('.envrc')).toBe(true);
    expect(isDotenvBasename('.env.local')).toBe(true);
    expect(isDotenvBasename('.environment')).toBe(false);
    expect(isDotenvBasename('env')).toBe(false);
  });
});

describe('looksBinary', () => {
  it('flags a NUL byte in the head slice', () => {
    expect(looksBinary(new Uint8Array([0x50, 0x4b, 0x00, 0x01]))).toBe(true);
    expect(looksBinary(new TextEncoder().encode('plain text\nwith lines\n'))).toBe(false);
    expect(looksBinary(new Uint8Array(0))).toBe(false);
  });
  it('only inspects the first 8KB', () => {
    const buf = new Uint8Array(10000).fill(0x61);
    buf[9000] = 0; // beyond the sniff window
    expect(looksBinary(buf)).toBe(false);
  });
});
