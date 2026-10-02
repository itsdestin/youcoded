import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { officeAvailable, officeRoot } from '../../src/main/office/office-root';
import pin from '../../office-pin.json';

// Pins where the Office add-on bundle is found in each run mode, and how
// availability is decided — without touching the real ~104MB download.
describe('officeRoot', () => {
  it('resolves to the dev-fetched office-addon folder when unpackaged', () => {
    const root = officeRoot({ packaged: false, appPath: '/home/dev/youcoded/desktop' });
    expect(root.endsWith('office-addon')).toBe(true);
  });

  it('resolves inside resourcesPath/office when packaged', () => {
    const root = officeRoot({ packaged: true, resourcesPath: '/opt/YouCoded/resources' });
    expect(root).toBe(path.join('/opt/YouCoded/resources', 'office'));
  });
});

describe('officeAvailable', () => {
  it('is false when the root has no manifest.json', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'office-root-test-'));
    try {
      expect(await officeAvailable(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is true when manifest.json version matches the pinned version', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'office-root-test-'));
    try {
      await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ version: pin.version }));
      expect(await officeAvailable(dir)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is false when manifest.json version does not match the pinned version', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'office-root-test-'));
    try {
      await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ version: '0.0.1-stale' }));
      expect(await officeAvailable(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
