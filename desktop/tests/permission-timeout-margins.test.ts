import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// A Claude Code permission ask is held by three clocks, each 30 minutes apart:
// the app's own hold (2h) < the relay's backstop (2h30m) < Claude Code's hook
// timeout (3h). If Claude Code's clock ever fires first it kills the hook with
// NO decision, and AskUserQuestion then waits forever — the silent wedge the old
// equal 5-minute values produced. This pins the SHIPPED LITERALS
// (reading source, because the relays also honour an env override
// that would make a runtime check pass vacuously).
const repoRoot = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

function literal(file: string, re: RegExp): number {
  const m = read(file).match(re);
  if (!m) throw new Error(`pattern ${re} not found in ${file}`);
  return parseInt(m[1].replace(/_/g, ''), 10);
}

const RELAY_RE = /CLAUDE_RELAY_TIMEOUT \|\| '(\d+)'/;
// Android clean rebuild (2026-10-14): the phone runs the desktop backend; its hold and relay are these same files.
const MARGIN_MS = 15 * 60 * 1000;

const desktopRelay = () => literal('desktop/hook-scripts/relay-blocking.js', RELAY_RE);
const desktopCcSeconds = () => literal('desktop/scripts/install-hooks.js', /command: expectedBlockingCmd, timeout: (\d+)/);
const desktopHold = () => literal('desktop/src/main/hook-relay.ts', /APP_HOLD_MS = ([\d_]+)/);

describe('permission-ask timeout tiers', () => {
  it('the app hold is 2h', () => {
    expect(desktopHold()).toBe(7_200_000);
  });

  it('the relay backstop is 2h30m', () => {
    expect(desktopRelay()).toBe(9_000_000);
  });

  it("Claude Code's hook timeout is 3h", () => {
    expect(desktopCcSeconds()).toBe(10_800);
  });

  it('each clock fires strictly before the next, with a real margin', () => {
    expect(desktopHold()).toBeLessThanOrEqual(desktopRelay() - MARGIN_MS);
    expect(desktopRelay()).toBeLessThanOrEqual(desktopCcSeconds() * 1000 - MARGIN_MS);
  });

  it('every value is under the 32-bit setTimeout ceiling (an overflow fires IMMEDIATELY)', () => {
    for (const v of [desktopHold(), desktopRelay(), desktopCcSeconds() * 1000]) {
      expect(v).toBeLessThan(2_147_483_647);
    }
  });

});
