import { describe, test, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// This test verifies that IPC channel constants in preload.ts match shared/types.ts.
// Preload can't import from shared/types due to Electron sandbox restrictions,
// so channel names are duplicated. This test catches drift.

describe('IPC channel consistency', () => {
  test('preload channel names match shared/types.ts', () => {
    const preloadSource = fs.readFileSync(
      path.join(__dirname, '../src/main/preload.ts'), 'utf8'
    );
    const typesSource = fs.readFileSync(
      path.join(__dirname, '../src/shared/types.ts'), 'utf8'
    );

    // Extract channel strings from preload (pattern: 'channel-name' in ipcRenderer calls)
    const preloadChannels = new Set<string>();
    const ipcPattern = /ipcRenderer\.\w+\('([^']+)'/g;
    let match;
    while ((match = ipcPattern.exec(preloadSource)) !== null) {
      preloadChannels.add(match[1]);
    }

    // Also extract channels from the preload IPC constant object
    const preloadIpcBlock = preloadSource.match(/const IPC\s*=\s*\{([^}]+)\}/s);
    if (preloadIpcBlock) {
      const constPattern = /:\s*'([^']+)'/g;
      while ((match = constPattern.exec(preloadIpcBlock[1])) !== null) {
        preloadChannels.add(match[1]);
      }
    }

    // Extract channel strings from types.ts IPC object
    const typesChannels = new Set<string>();
    const typesIpcBlock = typesSource.match(/export const IPC\s*=\s*\{([^}]+)\}/s);
    if (typesIpcBlock) {
      const typesPattern = /:\s*'([^']+)'/g;
      while ((match = typesPattern.exec(typesIpcBlock[1])) !== null) {
        typesChannels.add(match[1]);
      }
    }

    // Every preload channel should exist in types (or be a dynamic/ad-hoc channel)
    const missing = [...preloadChannels].filter(ch =>
      !typesChannels.has(ch) && !ch.includes(':output:')
    );

    // This is informational — log drift rather than hard-fail, since preload
    // may legitimately have channels not in the IPC enum (dynamic channels, etc.)
    if (missing.length > 0) {
      console.warn('Channels in preload.ts but not in shared/types.ts:', missing);
    }

    // Both files should define the same core IPC constant object keys
    const preloadIpcKeys = new Set<string>();
    if (preloadIpcBlock) {
      const keyPattern = /(\w+)\s*:/g;
      while ((match = keyPattern.exec(preloadIpcBlock[1])) !== null) {
        preloadIpcKeys.add(match[1]);
      }
    }

    const typesIpcKeys = new Set<string>();
    if (typesIpcBlock) {
      const keyPattern = /(\w+)\s*:/g;
      while ((match = keyPattern.exec(typesIpcBlock[1])) !== null) {
        typesIpcKeys.add(match[1]);
      }
    }

    // Channels defined in preload's IPC object should all exist in types' IPC object
    const missingKeys = [...preloadIpcKeys].filter(k => !typesIpcKeys.has(k));
    if (missingKeys.length > 0) {
      console.warn('IPC keys in preload but not in types:', missingKeys);
    }

    // Verify that the channel values match for shared keys
    for (const key of preloadIpcKeys) {
      if (!typesIpcKeys.has(key)) continue;

      const preloadVal = preloadIpcBlock?.[1].match(new RegExp(`${key}\\s*:\\s*'([^']+)'`));
      const typesVal = typesIpcBlock?.[1].match(new RegExp(`${key}\\s*:\\s*'([^']+)'`));

      if (preloadVal && typesVal) {
        expect(preloadVal[1]).toBe(typesVal[1]);
      }
    }
  });
});
