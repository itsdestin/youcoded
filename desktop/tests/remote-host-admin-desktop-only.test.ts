import { describe, expect, it } from 'vitest';
import { responseOutcome, REJECT_ON_NOT_OK } from '../src/renderer/remote-shim';

// Two, not three: `remote:disconnect-client` is no longer answered here at all. It kept a
// refusing case so an un-upgraded client would be told no, but a shim only turns `{ok:false}`
// into an error for channels in its own REJECT_ON_NOT_OK, and none lists that one — so the
// refusal read as success. `default:` answers `{unsupported:true}`, which every shim rejects.
const ADMIN = ['remote:set-password', 'remote:set-config'];

// WHY no source reads here any more (Plan B, 2026-09-16): that the server keeps a refusing
// case for each admin channel, never compares client.ip to 127.0.0.1, still answers
// remote:get-config, and that SettingsPanel's Unpair button carries disabled={hostOnly} are
// the ast-grep rules remote-admin-case-refuses and unpair-button-disabled-on-remote.
describe('host administration does not travel over the remote socket', () => {
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

  it('reading the configuration is still allowed', () => {
    // Only CHANGING the host is refused; a phone still shows you its state.
    expect(responseOutcome('remote:get-config', { enabled: true })).toBe('value');
  });
});
