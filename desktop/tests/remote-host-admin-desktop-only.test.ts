import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { responseOutcome, REJECT_ON_NOT_OK } from '../src/renderer/remote-shim';

const SERVER = readFileSync(new URL('../src/main/remote-server.ts', import.meta.url), 'utf8');
const ADMIN = ['remote:set-password', 'remote:set-config', 'remote:disconnect-client'];

describe('host administration does not travel over the remote socket', () => {
  it('refuses all three channels, and not by comparing an address', () => {
    // WHY the address check had to go, not be fixed: it compared client.ip to 127.0.0.1.
    // Behind the loopback bind this is heading for, every remote device arrives as
    // 127.0.0.1, so it would have passed for all of them — any paired phone changing the
    // host password, which also throws every other device off.
    for (const channel of ADMIN) expect(SERVER).toContain(`case '${channel}':`);
    expect(SERVER).toContain("HOST_ADMIN_REFUSAL");
    expect(SERVER).not.toContain("client.ip === '127.0.0.1'");
    // The handler that actually performed a disconnect is gone, not merely unreachable.
    expect(SERVER).not.toContain('this.disconnectClient(payload.clientId');
  });

  it('the refusal reaches the caller as a failure, not as a success', () => {
    // Without this the phone showed the password field's success tick for a change the
    // host refused — a false success on the surface where it matters most.
    for (const channel of ADMIN) {
      expect(REJECT_ON_NOT_OK.has(channel)).toBe(true);
      expect(responseOutcome(channel, { ok: false, error: 'x' })).toBe('failure');
    }
  });

  it('reading the configuration is still allowed', () => {
    // Only CHANGING the host is refused; a phone still shows you its state.
    expect(SERVER).toContain("case 'remote:get-config':");
    expect(responseOutcome('remote:get-config', { enabled: true })).toBe('value');
  });
});
