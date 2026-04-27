import { describe, test, it, expect } from 'vitest';
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

// Regression net for the six dev:* IPC channels introduced by the
// Settings → Development feature. All three platforms must carry identical
// type strings. The Android assertion is intentionally expected to fail
// until Phase 6 (SessionService.kt dev:* handlers) lands.
describe('dev:* channel parity', () => {
  const NEW_TYPES = [
    'dev:log-tail',
    'dev:summarize-issue',
    'dev:submit-issue',
    'dev:install-workspace',
    'dev:install-progress',
    'dev:open-session-in',
  ];

  it('all six dev:* types are declared in preload.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.ts'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });

  it('all six dev:* types are referenced in remote-shim.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'remote-shim.ts'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });

  // WHY: This assertion is intentionally failing until Phase 6 adds SessionService.kt
  // handlers. It acts as the regression net — when Phase 6 lands, this turns green
  // and confirms Android parity is complete.
  it('all six dev:* types are handled by SessionService.kt (Android)', () => {
    const ktPath = path.join(
      __dirname, '..', '..', 'app', 'src', 'main', 'kotlin',
      'com', 'youcoded', 'app', 'runtime', 'SessionService.kt',
    );
    const src = fs.readFileSync(ktPath, 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`"${t}"`);
  });
});

// Regression net for terminal:get-screen-text, introduced by the
// android-terminal-data-parity plan (Task 7/9/10). All four surfaces
// (preload.ts, remote-shim.ts, ipc-handlers.ts, SessionService.kt) must
// carry identical type strings — drift would silently break the PTY
// buffer classifier on one platform.
describe('terminal:get-screen-text channel parity', () => {
  const CHANNEL = 'terminal:get-screen-text';

  it('terminal:get-screen-text is declared in preload.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.ts'), 'utf8');
    expect(src).toContain(`'${CHANNEL}'`);
  });

  it('terminal:get-screen-text is referenced in remote-shim.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'remote-shim.ts'), 'utf8');
    expect(src).toContain(`'${CHANNEL}'`);
  });

  it('terminal:get-screen-text is referenced in ipc-handlers.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc-handlers.ts'), 'utf8');
    expect(src).toContain(`'${CHANNEL}'`);
  });

  it('terminal:get-screen-text is handled by SessionService.kt (Android)', () => {
    const ktPath = path.join(
      __dirname, '..', '..', 'app', 'src', 'main', 'kotlin',
      'com', 'youcoded', 'app', 'runtime', 'SessionService.kt',
    );
    const src = fs.readFileSync(ktPath, 'utf8');
    expect(src).toContain(`"${CHANNEL}"`);
  });
});

// Regression net for pty:raw-bytes, introduced by the android-terminal-data-parity
// plan (Task 8). This is an Android-broadcast-only push event: SessionService.kt
// emits it; there is no desktop sender or consumer yet (Tier 2 xterm.js would be
// the consumer, not shipping in this plan). The desktop surfaces (preload, shim,
// ipc-handlers) intentionally do NOT declare this type — adding stubs would be
// dead code until Tier 2 lands.
//
// WHY only one assertion: this acts as a tombstone so the string is pinned and
// never silently renamed. When Tier 2 lands and desktop surfaces need it, add the
// three remaining assertions here and they will immediately catch drift.
describe('pty:raw-bytes channel parity (Android-broadcast-only)', () => {
  const CHANNEL = 'pty:raw-bytes';

  it('pty:raw-bytes is broadcast by SessionService.kt (Android)', () => {
    const ktPath = path.join(
      __dirname, '..', '..', 'app', 'src', 'main', 'kotlin',
      'com', 'youcoded', 'app', 'runtime', 'SessionService.kt',
    );
    const src = fs.readFileSync(ktPath, 'utf8');
    expect(src).toContain(`"${CHANNEL}"`);
  });
});

// Regression net for the update:changelog IPC channel introduced by the
// UpdatePanel popup feature. All three platforms must carry identical
// type strings — drift would silently break changelog fetch on one side.
describe('update:changelog channel parity', () => {
  const NEW_TYPES = [
    'update:changelog',
  ];

  it('update:changelog type is declared in preload.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.ts'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });

  it('update:changelog type is referenced in remote-shim.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'remote-shim.ts'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });

  it('update:changelog type is handled by SessionService.kt (Android)', () => {
    const ktPath = path.join(
      __dirname, '..', '..', 'app', 'src', 'main', 'kotlin',
      'com', 'youcoded', 'app', 'runtime', 'SessionService.kt',
    );
    const src = fs.readFileSync(ktPath, 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`"${t}"`);
  });
});

// Regression net for the analytics:* IPC channels introduced by the
// privacy-analytics plan (anonymous install + DAU/MAU telemetry opt-out).
// All three platforms must carry identical type strings. The Android
// assertion is intentionally expected to fail until Phase 7 (SessionService.kt
// analytics:* handlers) lands. Not a regression — the desktop IPC landing
// ahead of Android is the planned integration order.
describe('analytics:* channel parity', () => {
  const NEW_TYPES = [
    'analytics:get-opt-in',
    'analytics:set-opt-in',
  ];

  it('both analytics:* types are declared in preload.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.ts'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });

  it('both analytics:* types are referenced in remote-shim.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'remote-shim.ts'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });

  // WHY: This assertion is intentionally failing until Phase 7 adds the
  // SessionService.kt analytics:* handlers. It acts as the regression net —
  // when Phase 7 lands, this turns green and confirms Android parity is
  // complete.
  it('both analytics:* types are handled by SessionService.kt (Android)', () => {
    const ktPath = path.join(
      __dirname, '..', '..', 'app', 'src', 'main', 'kotlin',
      'com', 'youcoded', 'app', 'runtime', 'SessionService.kt',
    );
    const src = fs.readFileSync(ktPath, 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`"${t}"`);
  });
});

describe('performance:* and app:restart parity', () => {
  const channels = ['performance:get-config', 'performance:set-config', 'app:restart'];

  it('all three types are declared in preload.ts', () => {
    const preload = fs.readFileSync(
      path.join(__dirname, '../src/main/preload.ts'), 'utf8'
    );
    for (const ch of channels) {
      expect(preload, `${ch} missing from preload.ts`).toContain(`'${ch}'`);
    }
  });

  it('all three types are referenced in remote-shim.ts', () => {
    const shim = fs.readFileSync(
      path.join(__dirname, '../src/renderer/remote-shim.ts'), 'utf8'
    );
    for (const ch of channels) {
      expect(shim, `${ch} missing from remote-shim.ts`).toContain(`'${ch}'`);
    }
  });

  it('all three types are handled by SessionService.kt (Android)', () => {
    const kt = fs.readFileSync(
      path.join(__dirname, '../../app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt'),
      'utf8'
    );
    for (const ch of channels) {
      expect(kt, `${ch} missing from SessionService.kt`).toContain(`"${ch}"`);
    }
  });
});
