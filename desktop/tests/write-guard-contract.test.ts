import { describe, it, expect } from 'vitest';
import path from 'path';
import { readSource } from './helpers/guard-scope';

// Pins the write-guard PreToolUse BLOCKING contract discovered via issue #86:
// Claude Code only denies a tool call when a PreToolUse hook exits with code 2
// and puts its message on STDERR. An earlier version exited 1 with the message
// on stdout — CC treated that as non-blocking, so the same-machine concurrency
// guard was silently a no-op in every permission mode (verified empirically
// against CC v2.1.211, 2026-07-15; fixed in youcoded-core PR #119 and mirrored
// into both bundled copies here). These pins keep the contract from regressing
// and keep the two platform copies from drifting apart.

const desktopCopy = path.resolve(__dirname, '..', 'hook-scripts', 'write-guard.sh');
const androidCopy = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'write-guard.sh');

describe('bundled write-guard.sh blocking contract', () => {
  it('desktop and Android copies are byte-identical (bundled-hook parity)', () => {
    // WHY: both sides go through readSource, so the comparison stays valid —
    // normalising just one side would compare stripped bytes against raw ones.
    expect(readSource(desktopCopy)).toBe(readSource(androidCopy));
  });

  it('the block path exits 2 with the message on stderr (CC PreToolUse deny contract)', () => {
    const script = readSource(desktopCopy);
    // The user-facing WRITE BLOCKED line must go to stderr…
    expect(script).toMatch(/echo "WRITE BLOCKED: .*retry your edit\." >&2/);
    // …followed by exit 2 (the ONLY exit code CC treats as a block).
    expect(script).toMatch(/>&2\nexit 2/);
    // And no return to the old non-blocking shape.
    expect(script).not.toMatch(/\nexit 1\s*$/);
  });
});
