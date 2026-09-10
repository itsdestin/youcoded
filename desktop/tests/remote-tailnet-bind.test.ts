import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/main/remote-server.ts', import.meta.url), 'utf8');

/**
 * Contract row R10: other devices reach this computer only through Tailscale; its direct
 * home-network address no longer answers.
 *
 * Measured on this machine 2026-09-09 with a throwaway echo server: bound to the tailnet
 * address, the tailnet name answered in 8ms and the machine's 192.168.x address refused.
 * No Tailscale Serve, no certificate and no administrator password were involved — which is
 * why the default setup has none of those steps.
 */
describe('the listener is private by construction', () => {
  it('binds a named address rather than every interface', () => {
    expect(server).toContain('server.listen(this.config.port, this.bindAddress ?? undefined');
    expect(server).not.toMatch(/server\.listen\(this\.config\.port,\s*\(\)/);
  });

  it('refuses to start without a private address instead of falling back', () => {
    // The fallback IS the open listener this batch exists to remove: binding every
    // interface is what makes conversations readable by anything on the same wifi.
    expect(server).toContain('if (!ts.connected || !ts.ip)');
    expect(server).toContain('throw new Error(this.lastStartError)');
    expect(server).toContain('this.bindAddress = ts.ip;');
  });

  it('says which of the two Tailscale problems it is', () => {
    // "Not installed" and "installed but not connected" need different next steps, and
    // guessing between them is the invented-cause failure the standards forbid.
    expect(server).toContain('Tailscale is installed but not connected');
    expect(server).toContain('Tailscale is not installed');
  });
});
