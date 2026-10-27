import { describe, expect, it, vi } from 'vitest';
import { createKeychainWarmup } from '../src/main/providers/keychain-warmup';

describe('keychain warm-up', () => {
  it('pings both wallet services on the session bus, once, and ignores failures', async () => {
    const exec = vi.fn(async (_file: string, args: string[]) => { if (args.includes('org.kde.kwalletd6')) throw new Error('not here'); });
    const warm = createKeychainWarmup(exec as any, { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' });
    await warm(); await warm();
    const dests = exec.mock.calls.map((c) => c[1].join(' '));
    expect(exec).toHaveBeenCalledTimes(2);
    expect(dests.some((d) => d.includes('org.kde.kwalletd6') && d.includes('org.freedesktop.DBus.Peer Ping'))).toBe(true);
    expect(dests.some((d) => d.includes('org.freedesktop.secrets'))).toBe(true);
  });
  it('does nothing without a session bus', async () => {
    const exec = vi.fn(async () => undefined);
    await createKeychainWarmup(exec as any, {})();
    expect(exec).not.toHaveBeenCalled();
  });
});
