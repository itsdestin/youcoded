// Card #134 round 4: an integration's uninstall that tried to delete the plugin folder and left it must not clear the manifest
// and look done; a refused id or an already-missing folder still clears it, as before.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'integ-uninst-'));
vi.mock('os', async () => { const actual = await vi.importActual<typeof os>('os'); return { ...actual, default: { ...actual, homedir: () => tmpHome }, homedir: () => tmpHome }; });
const un = vi.hoisted(() => ({ uninstallPlugin: vi.fn(), installPlugin: vi.fn() }));
vi.mock('../src/main/plugin-installer', () => un);

const { IntegrationInstaller, IntegrationUninstallError } = await import('../src/main/integration-installer');

const entry = { slug: 'google-services', displayName: 'G', tagline: '', kind: 'plugin', status: 'available', setup: { type: 'plugin', pluginId: 'google-services' } } as any;
function make() {
  const i = new IntegrationInstaller();
  i.writeManifest({ 'google-services': { slug: 'google-services', installed: true, connected: true } });
  vi.spyOn(i, 'listCatalog').mockResolvedValue({ version: 't', integrations: [entry] });
  return i;
}
beforeEach(() => un.uninstallPlugin.mockReset());

describe('IntegrationInstaller.uninstall', () => {
  it('throws with the real reason and keeps the manifest when the folder could not be deleted', async () => {
    un.uninstallPlugin.mockResolvedValue({ ok: false, reason: 'delete-failed', unregistered: true, detail: 'EBUSY' });
    const i = make();
    await expect(i.uninstall('google-services')).rejects.toBeInstanceOf(IntegrationUninstallError);
    await expect(i.uninstall('google-services')).rejects.toThrow('EBUSY');
    expect(i.readManifest()['google-services']?.installed).toBe(true);
  });
  it('a refused id or a folder already gone still clears the manifest', async () => {
    const i = make();
    un.uninstallPlugin.mockResolvedValue({ ok: false, reason: 'id-refused' });
    expect(await i.uninstall('google-services')).toEqual({ slug: 'google-services', installed: false, connected: false });
    expect(i.readManifest()['google-services']).toBeUndefined();
    const j = make(); un.uninstallPlugin.mockResolvedValue({ ok: true });
    await j.uninstall('google-services');
    expect(j.readManifest()['google-services']).toBeUndefined();
  });
});
