import { describe, expect, it, vi } from 'vitest';
import { authorizeGoogleFiles } from '../src/renderer/components/google-files/google-files-auth';

describe('Google sign-in UI handoff', () => {
  it('waits for the real callback result rather than fabricating accounts', async () => {
    const account = { id: 'a', email: 'person@example.com', displayName: 'Person' };
    const api = { beginAuth: vi.fn(async () => ({ flowId: 'f' })), authState: vi.fn().mockResolvedValueOnce({ state: 'pending' }).mockResolvedValueOnce({ state: 'complete', account, files: [] }), cancelAuth: vi.fn(async () => {}) };
    const result = await authorizeGoogleFiles(api, undefined, new AbortController().signal, async () => {});
    expect(result.account).toEqual(account); expect(api.authState).toHaveBeenCalledTimes(2);
  });
  it('cancels the backend flow when the dialog is canceled', async () => {
    const controller = new AbortController();
    const api = { beginAuth: vi.fn(async () => ({ flowId: 'f' })), authState: vi.fn(async () => ({ state: 'pending' as const })), cancelAuth: vi.fn(async () => {}) };
    await expect(authorizeGoogleFiles(api, 'a', controller.signal, async () => { controller.abort(); })).rejects.toThrow();
    expect(api.cancelAuth).toHaveBeenCalledWith('f');
  });
});
