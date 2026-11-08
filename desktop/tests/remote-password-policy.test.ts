import { describe, expect, it, vi } from 'vitest';
import { bindRemoteAdmin, remoteAdminChannels } from '../src/main/ipc/remote-admin';
import { IPC } from '../src/shared/backend-contract';
import { MIN_REMOTE_PASSWORD_LENGTH } from '../src/main/remote-config';

// Destin 2026-10-31: a NEW or CHANGED remote password must be at least 8 characters, enforced in the main
// process (not only the Settings box). Existing short passwords keep working.
describe('remote password minimum is enforced where the password is stored', () => {
  const entry = remoteAdminChannels.find((c) => c.name === IPC.REMOTE_SET_PASSWORD)!;
  const setup = () => {
    const config = { setPassword: vi.fn(async () => {}) };
    const server = { invalidateTokens: vi.fn() };
    bindRemoteAdmin({ config, server, applyKeepAwake: () => {} } as never);
    return { config, server };
  };
  const call = (pw: unknown) => (entry as unknown as { handler: (p: unknown, c: unknown) => Promise<boolean> }).handler(pw, {});

  it('refuses a password under 8 characters and changes nothing', async () => {
    const { config, server } = setup();
    expect(MIN_REMOTE_PASSWORD_LENGTH).toBe(8);
    expect(await call('1234567')).toBe(false);
    expect(await call(undefined)).toBe(false);
    expect(config.setPassword).not.toHaveBeenCalled();
    expect(server.invalidateTokens).not.toHaveBeenCalled();
  });

  it('accepts 8 characters', async () => {
    const { config } = setup();
    expect(await call('12345678')).toBe(true);
    expect(config.setPassword).toHaveBeenCalledWith('12345678');
  });
});
