// Pins that a just-installed item becomes votable WITHOUT relaunching the app
// (marketplace overhaul Task 18 fold-in; ROADMAP bug found by hand-testing).
//
// WHY this test exists: the app told the Worker about exactly one id — the one
// the user clicked. But installing a plugin also surfaces every skill inside it
// as its own marketplace page, and (after Task 18) the id the user clicks is
// routinely a MEMBER whose install actually lands the whole bundle. The Worker
// gates voting on "do you have this installed?", so those extra pages were
// refused a vote until the next launch re-ran the full reconcile. Reporting the
// real installed set right after the install closes that window.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';

const reconcileInstalls = vi.fn();
vi.mock('../src/main/install-reconcile', () => ({ reconcileInstalls: (...a: unknown[]) => reconcileInstalls(...a) }));

const postInstall = vi.fn();
vi.mock('../src/renderer/state/marketplace-api-client', () => ({
  MARKETPLACE_API_HOST: 'https://example.invalid',
  MarketplaceApiError: class extends Error { status = 0; },
  createMarketplaceApiClient: () => new Proxy({ postInstall }, {
    // Every other endpoint is irrelevant here; answer with a no-op so
    // registration doesn't need the full client surface.
    get: (t: Record<string, unknown>, k: string) => t[k] ?? (() => Promise.resolve(undefined)),
  }),
}));
vi.mock('../src/main/social-handlers', () => ({ notifySignedOut: vi.fn() }));

import { registerMarketplaceApiHandlers } from '../src/main/marketplace-api-handlers';

const handlers = new Map<string, (...a: any[]) => any>();

beforeEach(() => {
  handlers.clear();
  reconcileInstalls.mockReset();
  postInstall.mockReset().mockResolvedValue(undefined);
  (ipcMain.handle as any).mockReset?.();
  (ipcMain.handle as any).mockImplementation((ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn));
});

const store = { getToken: () => 'tok', setToken: vi.fn(), setSession: vi.fn(), getUser: () => null } as never;
const skills = { getInstalled: async () => [{ id: 'superpowers' }, { id: 'superpowers:brainstorming' }] };

describe('marketplace:install', () => {
  it('reports the full installed set after recording the clicked id', async () => {
    registerMarketplaceApiHandlers(store, skills);
    const res = await handlers.get('marketplace:install')!({}, 'superpowers/brainstorming');
    expect(res).toEqual({ ok: true, value: undefined });
    expect(postInstall).toHaveBeenCalledWith('superpowers/brainstorming');
    expect(reconcileInstalls).toHaveBeenCalledWith(store, skills);
  });

  it('does not reconcile when the install report itself failed', async () => {
    postInstall.mockRejectedValue(new Error('offline'));
    registerMarketplaceApiHandlers(store, skills);
    const res = await handlers.get('marketplace:install')!({}, 'x');
    expect(res).toMatchObject({ ok: false });
    expect(reconcileInstalls).not.toHaveBeenCalled();
  });
});
