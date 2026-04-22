import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// IntegrationInstaller resolves MANIFEST_PATH at module-load time using
// os.homedir(), so we must stub homedir BEFORE importing the module.
// vi.hoisted ensures the stub is created before the top-level imports run.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-test-home-'));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof os>('os');
  return {
    ...actual,
    default: { ...actual, homedir: () => tmpHome },
    homedir: () => tmpHome,
  };
});

// Import AFTER the mock is wired.
const { IntegrationInstaller } = await import('../src/main/integration-installer');

beforeEach(() => {
  // Reset manifest between tests so Test 1's state doesn't leak into Test 2.
  const manifestPath = path.join(tmpHome, '.claude', 'integrations.json');
  try { fs.rmSync(manifestPath, { force: true }); } catch {}
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IntegrationInstaller.connect', () => {
  test('returns postInstallCommand for installed integration with one', async () => {
    const installer = new IntegrationInstaller();

    // Seed the manifest with an installed entry.
    installer.writeManifest({
      'google-services': { slug: 'google-services', installed: true, connected: false },
    });

    // Stub listCatalog so we don't hit the network.
    vi.spyOn(installer, 'listCatalog').mockResolvedValue({
      version: 'test',
      integrations: [{
        slug: 'google-services',
        displayName: 'Google Services',
        tagline: '',
        kind: 'plugin' as any,
        setup: {
          type: 'plugin',
          pluginId: 'google-services',
          postInstallCommand: '/google-services-setup',
          requiresOAuth: true,
        } as any,
        status: 'available',
      }],
    });

    const result = await installer.connect('google-services');

    expect(result.error).toBeUndefined();
    expect(result.installed).toBe(true);
    expect(result.postInstallCommand).toBe('/google-services-setup');
  });

  test('returns error when integration is not installed', async () => {
    const installer = new IntegrationInstaller();

    vi.spyOn(installer, 'listCatalog').mockResolvedValue({
      version: 'test',
      integrations: [{
        slug: 'google-services',
        displayName: 'Google Services',
        tagline: '',
        kind: 'plugin' as any,
        setup: {
          type: 'plugin',
          pluginId: 'google-services',
          postInstallCommand: '/google-services-setup',
          requiresOAuth: true,
        } as any,
        status: 'available',
      }],
    });

    const result = await installer.connect('google-services');

    expect(result.error).toContain('not installed');
    expect(result.installed).toBe(false);
  });

  test('returns error when entry has no postInstallCommand', async () => {
    const installer = new IntegrationInstaller();
    installer.writeManifest({
      'todoist': { slug: 'todoist', installed: true, connected: false },
    });

    vi.spyOn(installer, 'listCatalog').mockResolvedValue({
      version: 'test',
      integrations: [{
        slug: 'todoist',
        displayName: 'Todoist',
        tagline: '',
        kind: 'mcp' as any,
        setup: { type: 'api-key', keyName: 'TODOIST_API_KEY', requiresOAuth: false } as any,
        status: 'available',
      }],
    });

    const result = await installer.connect('todoist');

    expect(result.error).toContain('no connect flow');
  });
});
