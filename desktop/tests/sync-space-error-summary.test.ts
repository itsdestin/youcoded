// desktop/tests/sync-space-error-summary.test.ts
import { describe, it, expect } from 'vitest';
import { summarizeSpaceSyncError } from '../src/renderer/components/sync-space-error-summary';

describe('summarizeSpaceSyncError', () => {
  it('classifies a stale-lock / interrupted-write error as self-healing (no cause invented)', () => {
    const raw =
      "Sync merge could not complete for personal: fatal: Unable to create " +
      "'C:\\Users\\x\\.youcoded\\sync.git/index.lock': File exists. Another git " +
      "process seems to be running in this repository";
    const s = summarizeSpaceSyncError(raw);
    expect(s.interrupted).toBe(true);
    // Friendly + accurate (we KNOW the cause) + tells the user it self-heals.
    expect(s.summary.toLowerCase()).toContain('interrupted');
    expect(s.summary.toLowerCase()).toMatch(/on its own|automatically|few minutes/);
    // It must NOT dump the raw git text as the summary.
    expect(s.summary).not.toContain('index.lock');
  });

  it('classifies a bare ref-lock collision as interrupted too', () => {
    const s = summarizeSpaceSyncError("fatal: Unable to create '.../refs/heads/main.lock': File exists");
    expect(s.interrupted).toBe(true);
  });

  it('an unknown error stays non-committal and points to the report path (no invented cause)', () => {
    const s = summarizeSpaceSyncError('fatal: some transport explosion we have never seen');
    expect(s.interrupted).toBe(false);
    // General but non-committal — no guessed cause, and it surfaces where to report.
    expect(s.summary.toLowerCase()).toContain('help & feedback');
    expect(s.summary).not.toContain('transport explosion');
  });

  it('empty / missing input is treated as a generic unknown error', () => {
    expect(summarizeSpaceSyncError('').interrupted).toBe(false);
    expect(summarizeSpaceSyncError(null).interrupted).toBe(false);
    expect(summarizeSpaceSyncError(undefined).summary.length).toBeGreaterThan(0);
  });
});

// Phase 2 (2026-07-22): coded errors are already plain-language by contract —
// the summarizer must pass them through, not flatten "reconnect your GitHub
// account" into the generic "unexpected problem" line. Gated on the code,
// never on matching prose.
describe('summarizeSpaceSyncError github-auth pass-through', () => {
  it("passes a 'github-auth'-coded message through verbatim", () => {
    const msg = 'GitHub sign-in expired — reconnect your GitHub account in the Sync settings';
    expect(summarizeSpaceSyncError(msg, 'github-auth')).toEqual({ interrupted: false, summary: msg });
  });

  it('other codes / no code keep the existing classification', () => {
    expect(summarizeSpaceSyncError('something exploded', 'some-other-code').summary)
      .toContain('unexpected problem');
    expect(summarizeSpaceSyncError("Unable to create '/x/index.lock': File exists").interrupted).toBe(true);
  });
});

// PR #276 review: the summarizer mapped neither corruption-family code, so both
// fell to the generic "keep retrying automatically" line — actively WRONG copy,
// because corruption repair runs exactly ONCE per app launch (engine.ts
// healedSpaces guard): a surfaced repo-corrupt/repo-repair-failed error will
// NOT be retried until the app restarts. These pin the accurate copy.
describe('summarizeSpaceSyncError corruption-family codes', () => {
  it("'repo-corrupt' maps to plain-language copy: files safe, restart repairs", () => {
    const raw = 'Sync data for project:x needs repair (git push: fatal: bad object HEAD)';
    const s = summarizeSpaceSyncError(raw, 'repo-corrupt');
    expect(s.interrupted).toBe(false);
    expect(s.summary.toLowerCase()).toContain('your files are safe');
    expect(s.summary.toLowerCase()).toContain('restart');
    // Never the generic fallback's false promise, and never raw git jargon.
    expect(s.summary.toLowerCase()).not.toContain('keep retrying');
    expect(s.summary).not.toContain('bad object');
  });

  it("'repo-repair-failed' never claims retrying helps — the repair already failed", () => {
    const raw = 'Sync self-repair failed: no network for tier 2';
    const s = summarizeSpaceSyncError(raw, 'repo-repair-failed');
    expect(s.interrupted).toBe(false);
    // Accurate remedy (restart re-arms the once-per-launch repair) + the
    // standard report path — never "will keep retrying automatically".
    expect(s.summary.toLowerCase()).toContain('restart');
    expect(s.summary.toLowerCase()).toContain('help & feedback');
    expect(s.summary.toLowerCase()).not.toContain('keep retrying');
    expect(s.summary).not.toContain('no network for tier 2');
  });

  it('the coded branch wins even when the raw text contains an interrupted-lock marker', () => {
    // A corrupt repo's raw error can mention "Unable to create …" too — the
    // machine code must decide, never the prose.
    const s = summarizeSpaceSyncError("Sync data needs repair (git add: Unable to create '/x/index.lock')", 'repo-corrupt');
    expect(s.interrupted).toBe(false);
    expect(s.summary.toLowerCase()).toContain('restart');
  });
});
