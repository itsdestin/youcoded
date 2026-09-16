import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { responseOutcome, REJECT_ON_NOT_OK } from '../src/renderer/remote-shim';

const SERVER = readFileSync(new URL('../src/main/remote-server.ts', import.meta.url), 'utf8');
// Two, not three: `remote:disconnect-client` is no longer answered here at all. It kept a
// refusing case so an un-upgraded client would be told no, but a shim only turns `{ok:false}`
// into an error for channels in its own REJECT_ON_NOT_OK, and none lists that one — so the
// refusal read as success. `default:` answers `{unsupported:true}`, which every shim rejects.
const ADMIN = ['remote:set-password', 'remote:set-config'];

describe('host administration does not travel over the remote socket', () => {
  it('refuses the administration channels, and not by comparing an address', () => {
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
    // The two device channels joined this list after a review found the same false success
    // on Unpair: the row vanished from the list while the device kept full access.
    for (const channel of [...ADMIN, 'remote:devices:rename', 'remote:devices:unpair']) {
      expect(REJECT_ON_NOT_OK.has(channel)).toBe(true);
      expect(responseOutcome(channel, { ok: false, error: 'x' })).toBe('failure');
    }
  });

  it('a phone cannot unpair a device', () => {
    // The other half of the row, and the half no test covered: the refusal being a
    // rejection is worth nothing if the button that triggers it is still offered. A
    // phone showed the row vanishing from the list while the device kept full access.
    for (const channel of ['remote:devices:rename', 'remote:devices:unpair']) {
      expect(SERVER).toContain(`case '${channel}':`);
      // Refused by the host, not performed and reported.
      const arm = SERVER.slice(SERVER.indexOf(`case '${channel}':`));
      expect(arm.slice(0, 200)).toContain('HOST_ADMIN_REFUSAL');
    }
    // And the control is not offered on a remote client at all, so nobody presses a
    // button whose only possible outcome is an error.
    // Anchored to the Unpair button itself. A bare `disabled={hostOnly}` search passed
    // while that exact prop had been deleted from this button — two other controls carry
    // it, so the assertion was true for the wrong reason. Checked by deleting it.
    const panel = readFileSync(new URL('../src/renderer/components/SettingsPanel.tsx', import.meta.url), 'utf8');
    expect(panel).toMatch(/disabled=\{hostOnly\} aria-label=\{`Unpair /);
    expect(panel).toMatch(/hostOnly \? `\$\{row\.online \? 'Online' : 'Offline'\} · unpair on the computer itself`/);
  });

  it('reading the configuration is still allowed', () => {
    // Only CHANGING the host is refused; a phone still shows you its state.
    expect(SERVER).toContain("case 'remote:get-config':");
    expect(responseOutcome('remote:get-config', { enabled: true })).toBe('value');
  });
});
