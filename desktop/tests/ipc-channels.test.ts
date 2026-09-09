import { describe, test, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// This test verifies that IPC channel constants in preload.ts match shared/types.ts.
// Preload can't import from shared/types due to Electron sandbox restrictions,
// so channel names are duplicated. This test catches drift.

// The two IPC constant maps and how they are compared.
//
// preload.ts cannot import shared/types.ts (Electron's sandbox), so the channel
// map is written out TWICE and the two copies are kept identical by this file.
//
// Fixed 2026-09-04 (linux-buddy-helper design §11): this test used to
// console.warn when a constant was in one map and not the other, which means it
// could not catch the mistake it exists to catch — a channel added to one copy
// and forgotten in the other. It now FAILS, against a recorded baseline of the
// drift that already existed on the day the check was tightened. Adding to that
// baseline is not the way to make a new failure go away: add the constant to the
// other map.
const readSource = (...parts: string[]) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

/**
 * NAME → channel string for one map.
 *
 * Anchored to the start of a line and to a CONSTANT-shaped name, because the old
 * `(\w+)\s*:` pattern also matched ordinary words inside the maps' comments
 * ("Task 1:", "push:"), which put ~30 non-existent constants into the comparison
 * and is part of why it could never have been made to fail.
 */
function ipcConstants(source: string, decl: RegExp): Map<string, string> {
  // Anchored to the block's `} as const;` terminator at line start: a `[^}]+`
  // body stops at the FIRST `}`, which occurs inside a mid-block comment
  // ("Caller passes a {x,y} offset") and silently truncated the map to a third
  // of its keys.
  const block = source.match(decl);
  const out = new Map<string, string>();
  if (!block) return out;
  const entry = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*'([^']+)'/gm;
  let m: RegExpExecArray | null;
  while ((m = entry.exec(block[1])) !== null) out.set(m[1], m[2]);
  return out;
}

// The drift that already existed on 2026-09-04, measured, not guessed. Every
// name here is a constant one map carries and the other does not. Most are
// namespaces preload owns end-to-end (account:, social:, marketplace:) or that
// main owns end-to-end (specialists:, permissions:, search:).
const PRELOAD_ONLY_ON_2026_09_04 = [
  'ACCOUNT_DELETE', 'ACCOUNT_EXPORT', 'ACCOUNT_POLL', 'ACCOUNT_REFRESH', 'ACCOUNT_SET_HANDLE',
  'ACCOUNT_SIGNED_IN', 'ACCOUNT_SIGN_OUT', 'ACCOUNT_START', 'ACCOUNT_UPDATE_PROFILE',
  'ACCOUNT_USER', 'ANALYTICS_GET_OPT_IN', 'ANALYTICS_SET_OPT_IN', 'APPEARANCE_GET',
  'APPEARANCE_SET', 'CHAT_EXPORT_SNAPSHOT', 'CHAT_SNAPSHOT_RESPONSE', 'DEFAULTS_GET',
  'DEFAULTS_SET', 'MARKETPLACE_COMMENT', 'MARKETPLACE_INSTALL', 'MARKETPLACE_RATE',
  'MARKETPLACE_RATE_DELETE', 'MARKETPLACE_REPORT', 'MARKETPLACE_THEME_LIKE',
  'MARKETPLACE_THUMB', 'MARKETPLACE_THUMB_GET', 'MODEL_GET_PREFERENCE', 'MODEL_READ_LAST',
  'MODEL_SET_PREFERENCE', 'MODES_GET', 'MODES_SET', 'PTY_RAW_BYTES',
  'REMOTE_ATTENTION_CHANGED', 'SETTINGS_GET', 'SETTINGS_SET', 'SOCIAL_ACCEPT_REQUEST',
  'SOCIAL_BLOCK', 'SOCIAL_CANCEL_REQUEST', 'SOCIAL_DECLINE_REQUEST', 'SOCIAL_LIST_BLOCKS',
  'SOCIAL_LIST_FRIENDS', 'SOCIAL_LIST_REQUESTS', 'SOCIAL_LOOKUP_HANDLE',
  'SOCIAL_PRESENCE_CONNECT', 'SOCIAL_PRESENCE_DISCONNECT', 'SOCIAL_PRESENCE_EVENT',
  'SOCIAL_PRESENCE_SEND', 'SOCIAL_SEND_REQUEST', 'SOCIAL_UNBLOCK', 'SOCIAL_UNFRIEND',
];
const TYPES_ONLY_ON_2026_09_04 = [
  'FS_READ_HEAD', 'NATIVE_SUPPORTED', 'PERMISSIONS_LIST', 'PERMISSIONS_REMOVE',
  'PERMISSIONS_REMOVE_PROJECT', 'SEARCH_LIST', 'SEARCH_REMOVE_KEY', 'SEARCH_SET_KEY',
  'SEARCH_TEST', 'SPECIALISTS_DELEGATED_GET', 'SPECIALISTS_DELEGATED_SET',
  'SPECIALISTS_EVENT', 'SPECIALISTS_INTERRUPT', 'SPECIALISTS_LIST', 'SPECIALISTS_STEER',
];

describe('IPC channel consistency', () => {
  const preloadSource = readSource('src', 'main', 'preload.ts');
  const typesSource = readSource('src', 'shared', 'types.ts');
  const preloadIpc = ipcConstants(preloadSource, /const IPC\s*=\s*\{([\s\S]*?)\n\} as const;/);
  const typesIpc = ipcConstants(typesSource, /export const IPC\s*=\s*\{([\s\S]*?)\n\} as const;/);

  // Without this, every assertion below passes vacuously the moment one of the
  // two extractions stops matching — which has happened here before.
  test('both IPC maps were actually parsed', () => {
    expect(preloadIpc.size).toBeGreaterThan(250);
    expect(typesIpc.size).toBeGreaterThan(250);
    expect(preloadIpc.get('BUDDY_SHOW')).toBe('buddy:show');
    expect(typesIpc.get('BUDDY_SHOW')).toBe('buddy:show');
  });

  test('a constant in both maps has the same channel string in both', () => {
    const mismatched = [...preloadIpc]
      .filter(([name, value]) => typesIpc.has(name) && typesIpc.get(name) !== value)
      .map(([name, value]) => `${name}: preload '${value}' vs types '${typesIpc.get(name)}'`);
    expect(mismatched).toEqual([]);
  });

  test('no constant is added to one map and forgotten in the other', () => {
    const preloadOnly = [...preloadIpc.keys()].filter((n) => !typesIpc.has(n)).sort();
    const typesOnly = [...typesIpc.keys()].filter((n) => !preloadIpc.has(n)).sort();
    // Compared as ARRAYS so a failure names the exact constant that drifted.
    // SUBSET-PLUS-CAP, not equality (B4 review, F4). Equality pins BOTH
    // directions: fixing a legitimate piece of drift — adding one of the
    // types-only constants to preload — would turn this red until someone
    // hand-edited the baseline, and the failure would be a raw array diff that
    // does not say which direction is the good one. This way a fix passes
    // silently, a NEW one-sided constant fails and names itself, and quietly
    // appending to the baseline no longer works: the count is a hard number that
    // has to be edited too, which is a visible change in review.
    const strays = preloadOnly.filter((n) => !PRELOAD_ONLY_ON_2026_09_04.includes(n));
    expect(strays, 'new preload-only channel constant(s); add them to shared/types.ts too').toEqual([]);
    expect(preloadOnly.length).toBeLessThanOrEqual(PRELOAD_ONLY_ON_2026_09_04.length);
    const typesStrays = typesOnly.filter((n) => !TYPES_ONLY_ON_2026_09_04.includes(n));
    expect(typesStrays, 'new types-only channel constant(s); add them to preload.ts too').toEqual([]);
    expect(typesOnly.length).toBeLessThanOrEqual(TYPES_ONLY_ON_2026_09_04.length);
  });

  // Channel strings preload passes to ipcRenderer directly, without going
  // through its map at all. Measured 2026-09-04: 59 of these exist and are
  // legitimate (artifacts:*, git:*, project:*, sync:* are reached this way), so
  // this stays a report rather than an assertion — the constant-map checks
  // above are the ones that had to become real.
  test('inline ipcRenderer channel strings are reported, not asserted', () => {
    const inline = new Set<string>();
    const pattern = /ipcRenderer\.\w+\('([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(preloadSource)) !== null) inline.add(m[1]);
    const known = new Set([...typesIpc.values(), ...preloadIpc.values()]);
    const unlisted = [...inline].filter((ch) => !known.has(ch) && !ch.includes(':output:'));
    if (unlisted.length > 0) {
      console.warn('preload.ts calls these channels without a map entry:', unlisted);
    }
    expect(inline.size).toBeGreaterThan(0);
  });
});

// Regression net for the dev:* IPC channels introduced by the
// Settings → Development feature. All three platforms must carry identical
// type strings.
describe('dev:* channel parity', () => {
  const NEW_TYPES = [
    'dev:log-tail',
    'dev:diagnostics',
    'dev:summarize-issue',
    'dev:submit-issue',
    'dev:install-workspace',
    'dev:install-progress',
    'dev:open-session-in',
  ];

  it('all dev:* types are declared in preload.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.ts'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });

  it('all dev:* types are referenced in remote-shim.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'remote-shim.ts'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });

  it('all dev:* types are handled by SessionService.kt (Android)', () => {
    const ktPath = path.join(
      __dirname, '..', '..', 'app', 'src', 'main', 'kotlin',
      'com', 'youcoded', 'app', 'runtime', 'SessionService.kt',
    );
    const src = fs.readFileSync(ktPath, 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`"${t}"`);
  });
});

// Regression net for the account:* IPC channels introduced by the
// Accounts Phase 1 (client account surface) plan. All four surfaces must
// carry identical type strings — drift would silently break sign-in / profile
// on one platform. Also guards against any leftover marketplace:auth:* strings
// (the pre-rename prefix) in the three desktop TS sources.
// shell:open-external now has to work on THREE surfaces, not two. Desktop has
// always had it; Android grew a handler when link deliverables (SendUserLink /
// mcp__youcoded__SendUserLink) started drawing clickable tiles in the chat —
// React runs under file:// there, so the shim's window.open fallback silently
// does nothing and the tile would be a dead button.
describe('shell:open-external channel parity', () => {
  const readFrom = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  it('is declared in preload.ts and invoked by remote-shim.ts', () => {
    expect(readFrom('src', 'main', 'preload.ts')).toContain("'shell:open-external'");
    expect(readFrom('src', 'renderer', 'remote-shim.ts')).toContain("invoke('shell:open-external'");
  });

  it('is handled by SessionService.kt (Android)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    expect(src).toContain('"shell:open-external" ->');
  });

  it('every surface gates on the SCHEME, http/https only', () => {
    // The scheme check is the actual security boundary for a URL the model
    // chose — the tile is only ever opened by a user click, but file:,
    // intent: and javascript: must never reach an opener on any platform.
    expect(readFrom('src', 'main', 'ipc-handlers.ts')).toMatch(/\^https\?:\\\/\\\//);
    const kt = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    expect(kt).toContain('url.startsWith("http://") || url.startsWith("https://")');
  });
});

describe('account:* channel parity', () => {
  const NEW_TYPES = [
    'account:start', 'account:poll', 'account:signed-in', 'account:user',
    'account:refresh', 'account:sign-out', 'account:update-profile', 'account:set-handle', 'account:delete',
    // Accounts Phase 2 — data export lives in the account group across all four surfaces.
    'account:export',
  ];
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  it('all account:* types are declared in preload.ts', () => {
    const src = read('src', 'main', 'preload.ts');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });
  it('all account:* types are referenced in remote-shim.ts', () => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });
  it('all account:* types are handled in marketplace-api-handlers.ts', () => {
    const src = read('src', 'main', 'marketplace-api-handlers.ts');
    for (const t of NEW_TYPES) expect(src).toContain(`"${t}"`);
  });
  it('all account:* types are handled by SessionService.kt (Android)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`"${t}"`);
  });
  it('no marketplace:auth:* strings remain anywhere', () => {
    for (const p of [['src','main','preload.ts'],['src','renderer','remote-shim.ts'],['src','main','marketplace-api-handlers.ts']] as const) {
      expect(read(...p)).not.toContain('marketplace:auth:');
    }
  });
});

// Regression net for the social:* IPC channels introduced by the Accounts
// Phase 2 (client social graph) plan — friends, requests, blocks. All four
// surfaces must carry identical type strings; drift would silently break the
// friends UI on one platform. The channel strings are asserted in preload.ts +
// remote-shim.ts (single-quoted) and social-handlers.ts + SessionService.kt
// (double-quoted). account:export is NOT here — it rides the account:* describe.
describe('social:* channel parity', () => {
  const NEW_TYPES = [
    'social:lookup-handle', 'social:send-request', 'social:list-requests',
    'social:accept-request', 'social:decline-request', 'social:cancel-request',
    'social:list-friends', 'social:unfriend', 'social:block', 'social:unblock',
    'social:list-blocks',
    // Presence socket (Task 6). The three invoke channels + the one push channel.
    // social:presence-event's desktop-main surface is social-handlers.ts (the
    // broadcaster), so the standard four-file assertion holds for all four.
    'social:presence-connect', 'social:presence-disconnect', 'social:presence-send',
    'social:presence-event',
  ];
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  it('all social:* types are declared in preload.ts', () => {
    const src = read('src', 'main', 'preload.ts');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });
  it('all social:* types are referenced in remote-shim.ts', () => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });
  it('all social:* types are handled in social-handlers.ts', () => {
    const src = read('src', 'main', 'social-handlers.ts');
    for (const t of NEW_TYPES) expect(src).toContain(`"${t}"`);
  });
  it('all social:* types are handled by SessionService.kt (Android)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
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

// Regression net for native:retry (stalled-turn design, 2026-08-16). Five
// surfaces must carry identical type strings — drift would leave the stalled
// card's Retry button dead on one platform, and a dead Retry on a red card is
// worse than no card at all.
describe('native:retry channel parity', () => {
  const CHANNEL = 'native:retry';
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  it('is declared in shared/types.ts', () => {
    expect(read('src', 'shared', 'types.ts')).toContain(`'${CHANNEL}'`);
  });
  it('is declared in preload.ts', () => {
    expect(read('src', 'main', 'preload.ts')).toContain(`'${CHANNEL}'`);
  });
  it('is handled in ipc-handlers.ts', () => {
    expect(read('src', 'main', 'ipc-handlers.ts')).toContain('NATIVE_RETRY');
  });
  it('is referenced in remote-shim.ts', () => {
    expect(read('src', 'renderer', 'remote-shim.ts')).toContain(`'${CHANNEL}'`);
  });
  it('is handled in remote-server.ts', () => {
    expect(read('src', 'main', 'remote-server.ts')).toContain(`'${CHANNEL}'`);
  });
  it('is answered not-implemented by SessionService.kt (Android)', () => {
    const src = fs.readFileSync(path.join(
      __dirname, '..', '..', 'app', 'src', 'main', 'kotlin',
      'com', 'youcoded', 'app', 'runtime', 'SessionService.kt',
    ), 'utf8');
    expect(src).toContain(`"${CHANNEL}"`);
  });
});

// Regression net for pty:raw-bytes. Tier 1 introduced the Android broadcaster;
// Tier 2 (xterm-in-WebView) added the desktop-side consumer surfaces. Three
// surfaces must carry identical type strings — drift would silently break the
// xterm-on-Android renderer. ipc-handlers.ts is intentionally NOT in this list:
// pty:raw-bytes is a push event from Android via WebSocket, not a request-
// response handler, and there is no desktop sender (Electron PTY emits
// pty:output strings instead).
describe('pty:raw-bytes channel parity', () => {
  const CHANNEL = 'pty:raw-bytes';

  it('pty:raw-bytes is declared in preload.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.ts'), 'utf8');
    expect(src).toContain(`'${CHANNEL}'`);
  });

  it('pty:raw-bytes is referenced in remote-shim.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'remote-shim.ts'), 'utf8');
    expect(src).toContain(`'${CHANNEL}'`);
  });

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

// Regression net for system:back and system:notify-stack-state introduced by the
// android-back-button implementation. system:notify-stack-state flows React → Android
// (via SessionService.handleBridgeMessage). system:back flows Android → React
// (broadcast by MainActivity, subscribed in remote-shim). Both channel names must
// appear literally in their respective files — drift would silently break back-button
// support on one platform.
describe('system:back and system:notify-stack-state parity', () => {
  test('system:notify-stack-state appears in preload.ts, types.ts, remote-shim.ts, SessionService.kt', () => {
    const stackStateSites = {
      'preload.ts': fs.readFileSync(path.join(__dirname, '../src/main/preload.ts'), 'utf8'),
      'types.ts': fs.readFileSync(path.join(__dirname, '../src/shared/types.ts'), 'utf8'),
      'remote-shim.ts': fs.readFileSync(path.join(__dirname, '../src/renderer/remote-shim.ts'), 'utf8'),
      'SessionService.kt': fs.readFileSync(
        path.join(__dirname, '../../app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt'),
        'utf8',
      ),
    };

    const channel = 'system:notify-stack-state';
    for (const [siteName, source] of Object.entries(stackStateSites)) {
      expect(source, `expected '${channel}' to appear in ${siteName}`).toContain(channel);
    }
  });

  test('system:back appears in preload.ts, types.ts, remote-shim.ts, MainActivity.kt', () => {
    const backSites = {
      'preload.ts': fs.readFileSync(path.join(__dirname, '../src/main/preload.ts'), 'utf8'),
      'types.ts': fs.readFileSync(path.join(__dirname, '../src/shared/types.ts'), 'utf8'),
      'remote-shim.ts': fs.readFileSync(path.join(__dirname, '../src/renderer/remote-shim.ts'), 'utf8'),
      'MainActivity.kt': fs.readFileSync(
        path.join(__dirname, '../../app/src/main/kotlin/com/youcoded/app/MainActivity.kt'),
        'utf8',
      ),
    };

    const channel = 'system:back';
    for (const [siteName, source] of Object.entries(backSites)) {
      expect(source, `expected '${channel}' to appear in ${siteName}`).toContain(channel);
    }
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

// Regression net for artifact:* IPC channels introduced by the artifact-viewer
// subsystem (Phase 2). All four surfaces (preload.ts, remote-shim.ts,
// ipc-handlers.ts, SessionService.kt) must carry identical type strings for
// request-response channels. The push event 'artifacts:changed' does NOT need
// an ipcMain.handle — it broadcasts from main to renderer only. Phase 8 will
// add SessionService.kt handlers; until then, those assertions are expected to
// fail as a tracker for when Android parity lands.
describe('artifact IPC parity', () => {
  // Dynamically read the ipc-channels.ts file and extract the channel values
  const ipcChannelsSource = fs.readFileSync(
    path.join(__dirname, '../src/main/artifacts/ipc-channels.ts'), 'utf8'
  );
  // Extract all string values from ARTIFACT_IPC object (pattern: : 'channel-name')
  const channelMatches = [...ipcChannelsSource.matchAll(/'([^']+)'/g)];
  const channels = channelMatches
    .map(m => m[1])
    .filter((v, i, a) => a.indexOf(v) === i); // deduplicate

  // Build a reverse lookup mapping channel string → constant name
  // for recognizing constant references (e.g., ARTIFACT_IPC.LIST_SESSION) in ipc-handlers.ts
  const CHANNEL_TO_CONST = Object.entries({
    LIST_SESSION: 'artifacts:list-session',
    LIST_PROJECT: 'artifacts:list-project',
    LIST_ALL_FILES: 'artifacts:list-all-files',
    LIST_PROJECTS_INDEX: 'artifacts:list-projects-index',
    GET: 'artifacts:get',
    READ_BINARY: 'artifacts:read-binary',
    SAVE: 'artifacts:save',
    // Fix: data-flow gap — new channel that wires renderer Tracker → central index
    APPEND_VERSION: 'artifacts:append-version',
    // Copy/move a picked file into the project (import-file.ts). Was missing
    // from this map, which made the constForm check below vacuous for this
    // channel (see the CHANNEL_TO_CONST-coverage test just below this map).
    IMPORT_FILE: 'artifacts:import-file',
    INCLUDE_EXTERNAL: 'artifacts:include-external',
    EXCLUDE: 'artifacts:exclude',
    CHANGED: 'artifacts:changed',
    // Task 7.3: project deletion
    DELETE_PROJECT: 'artifacts:delete-project',
    // Existence check folds "file not on disk" into the deleted UI state.
    CHECK_EXISTENCE: 'artifacts:check-existence',
    // Rename a file on disk + update the sidecar record.
    RENAME: 'artifacts:rename',
    // Was missing (registered only via its literal form) — a handler switched to
    // the constant would have failed the suite for the wrong reason.
    REMOVE_RECORD: 'artifacts:remove-record',
    // External-change watcher subscribe/unsubscribe (project-watcher.ts).
    WATCH_PROJECT: 'artifacts:watch-project',
    UNWATCH_PROJECT: 'artifacts:unwatch-project',
    SEARCH_CONTENT: 'artifacts:search-content',
  }).reduce<Record<string, string>>((acc, [name, value]) => {
    acc[value] = `ARTIFACT_IPC.${name}`;
    return acc;
  }, {});

  // Resolve paths relative to the desktop directory (where vitest is invoked from)
  const preload = fs.readFileSync('src/main/preload.ts', 'utf8');
  const shim = fs.readFileSync('src/renderer/remote-shim.ts', 'utf8');
  const handlers = fs.readFileSync('src/main/ipc-handlers.ts', 'utf8');

  // Kotlin file lives in the sibling app/ directory of the youcoded sub-repo
  const kotlinPath = path.join(__dirname, '../../app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt');
  const kotlinExists = fs.existsSync(kotlinPath);
  const kotlin = kotlinExists ? fs.readFileSync(kotlinPath, 'utf8') : '';

  for (const channel of channels) {
    it(`channel ${channel} is referenced in preload.ts`, () => {
      expect(preload, `${channel} missing from preload.ts`).toContain(channel);
    });

    it(`channel ${channel} is referenced in remote-shim.ts`, () => {
      expect(shim, `${channel} missing from remote-shim.ts`).toContain(channel);
    });

    if (channel !== 'artifacts:changed') {
      // Push events don't need an ipcMain.handle — only request/response channels do
      it(`channel ${channel} is registered in ipc-handlers.ts`, () => {
        // ipc-handlers.ts may use the channel as a literal string OR as a constant reference
        // (e.g., ARTIFACT_IPC.LIST_SESSION), so accept either form
        const literalForm = handlers.includes(channel);
        const constName = CHANNEL_TO_CONST[channel];
        // Fix: a channel missing from CHANNEL_TO_CONST made constName
        // `undefined`, and handlers.includes(undefined) coerces its argument
        // to the string "undefined" — which ipc-handlers.ts contains many
        // times in ordinary type annotations, so this assertion passed
        // regardless of whether the handler was registered. Fail loudly
        // instead of letting a missing map entry silently pass.
        expect(constName, `${channel} has no CHANNEL_TO_CONST entry — add one, do not rely on the constant-form check`).toBeDefined();
        const constForm = handlers.includes(constName as string);
        expect(literalForm || constForm, `${channel} missing from ipc-handlers.ts`).toBe(true);
      });
    }

    // Phase 8: Expected to fail until Android handlers land; left in place as a tracker
    it(`channel ${channel} is registered in SessionService.kt`, () => {
      if (kotlinExists) {
        expect(kotlin, `${channel} missing from SessionService.kt`).toContain(channel);
      } else {
        // App directory not present in this worktree yet (Phase 8 pending)
        console.warn(`SessionService.kt not found at ${kotlinPath} — skipping Android parity check`);
      }
    });
  }
});

// Regression net for the project:* IPC channels (Project View redesign).
// Desktop is authoritative in v1; SessionService.kt carries stub cases so the
// type strings stay in parity (handlers return not-implemented-on-mobile).
// ipc-handlers.ts references PROJECT_IPC.* constants rather than literal
// strings (same convention as ARTIFACT_IPC), so that assertion accepts either.
describe('project:* channel parity', () => {
  const CHANNEL_TO_CONST: Record<string, string> = {
    'project:list-conversations': 'PROJECT_IPC.LIST_CONVERSATIONS',
    'project:conversation-history': 'PROJECT_IPC.CONVERSATION_HISTORY',
    'project:repo-info': 'PROJECT_IPC.REPO_INFO',
    'project:list-context': 'PROJECT_IPC.LIST_CONTEXT',
    'project:read-context-file': 'PROJECT_IPC.READ_CONTEXT_FILE',
    'project:write-context-file': 'PROJECT_IPC.WRITE_CONTEXT_FILE',
  };
  const NEW_TYPES = Object.keys(CHANNEL_TO_CONST);

  it('declared in preload.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.ts'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });
  it('referenced in remote-shim.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'remote-shim.ts'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });
  it('registered in ipc-handlers.ts (literal or PROJECT_IPC constant)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc-handlers.ts'), 'utf8');
    for (const t of NEW_TYPES) {
      const literal = src.includes(`'${t}'`);
      const constRef = src.includes(CHANNEL_TO_CONST[t]);
      expect(literal || constRef, `${t} missing from ipc-handlers.ts`).toBe(true);
    }
  });
  it('stubbed in SessionService.kt (Android)', () => {
    const kt = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    for (const t of NEW_TYPES) expect(kt).toContain(`"${t}"`);
  });
});

// Session references (spec 2026-08-10). FIVE surfaces, like project:* — the two
// channels are NOT gated on native.supported, because a phone must still be
// able to ask and get the clean not-implemented answer that makes the shared UI
// fall back to plain shell output.
describe('chatsearch:* channel parity', () => {
  const CHANNEL_TO_CONST: Record<string, string> = {
    'chatsearch:resolve': 'CHATSEARCH_IPC.RESOLVE',
    'chatsearch:read': 'CHATSEARCH_IPC.READ',
  };
  const NEW_TYPES = Object.keys(CHANNEL_TO_CONST);

  it('declared in preload.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.ts'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });
  it('referenced in remote-shim.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'remote-shim.ts'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });
  it('registered in ipc-handlers.ts (literal or CHATSEARCH_IPC constant)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc-handlers.ts'), 'utf8');
    for (const t of NEW_TYPES) {
      const literal = src.includes(`'${t}'`);
      const constRef = src.includes(CHANNEL_TO_CONST[t]);
      expect(literal || constRef, `${t} missing from ipc-handlers.ts`).toBe(true);
    }
  });
  it('handled in remote-server.ts (the remote browser and the phone both ride this)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'remote-server.ts'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`case '${t}'`);
  });
  it('stubbed in SessionService.kt (Android)', () => {
    const kt = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    for (const t of NEW_TYPES) expect(kt).toContain(`"${t}"`);
  });
});

// Cross-device sync spaces (spec 2026-07-03). Desktop-only in Phase 1a — no
// Android surface yet — so parity is asserted across the four DESKTOP surfaces:
// preload.ts, remote-shim.ts, ipc-handlers.ts, and remote-server.ts. preload
// (inlined IPC object), remote-shim (invoke literal), and remote-server (switch
// case) carry the literal string; ipc-handlers registers via the IPC.* constant
// (matching the existing sync:* handlers), so its check maps to the constant
// name — same "accepts the constant form" pattern as the artifact parity test.
describe('syncspaces:* channel parity (desktop surfaces)', () => {
  const channels: Array<[string, string]> = [
    ['syncspaces:status', 'IPC.SYNC_SPACES_STATUS'],
    ['syncspaces:enable', 'IPC.SYNC_SPACES_ENABLE'],
    ['syncspaces:sync-now', 'IPC.SYNC_SPACES_SYNC_NOW'],
    ['syncspaces:create-project', 'IPC.SYNC_SPACES_CREATE_PROJECT'],
    ['syncspaces:import-project', 'IPC.SYNC_SPACES_IMPORT_PROJECT'],
    ['syncspaces:rename-project', 'IPC.SYNC_SPACES_RENAME_PROJECT'],
    ['syncspaces:set-project-description', 'IPC.SYNC_SPACES_SET_PROJECT_DESCRIPTION'],
    ['syncspaces:stop-project', 'IPC.SYNC_SPACES_STOP_PROJECT'],
    // Plan 2b Task 11 — conversation leases + device registry. Full four-surface
    // desktop parity (preload / remote-shim / ipc-handlers constant / remote-server).
    ['syncspaces:lease-query', 'IPC.SYNC_SPACES_LEASE_QUERY'],
    ['syncspaces:lease-takeover', 'IPC.SYNC_SPACES_LEASE_TAKEOVER'],
    ['syncspaces:lease-force', 'IPC.SYNC_SPACES_LEASE_FORCE'],
    ['syncspaces:list-devices', 'IPC.SYNC_SPACES_LIST_DEVICES'],
    ['syncspaces:rename-device', 'IPC.SYNC_SPACES_RENAME_DEVICE'],
    ['syncspaces:remove-device', 'IPC.SYNC_SPACES_REMOVE_DEVICE'],
  ];
  const preload = fs.readFileSync(path.join(__dirname, '../src/main/preload.ts'), 'utf8');
  const shim = fs.readFileSync(path.join(__dirname, '../src/renderer/remote-shim.ts'), 'utf8');
  const handlers = fs.readFileSync(path.join(__dirname, '../src/main/ipc-handlers.ts'), 'utf8');
  const remoteServer = fs.readFileSync(path.join(__dirname, '../src/main/remote-server.ts'), 'utf8');
  for (const [ch, constant] of channels) {
    it(`${ch} present in preload, remote-shim, ipc-handlers, remote-server`, () => {
      expect(preload).toContain(ch);
      expect(shim).toContain(ch);
      expect(handlers).toContain(constant);
      expect(remoteServer).toContain(ch);
    });
  }
  it('syncspaces:event push channel present in preload + remote-shim', () => {
    expect(preload).toContain('syncspaces:event');
    expect(shim).toContain('syncspaces:event');
  });

  // Plan 2b Task 11 — the five lease/device REQUEST channels also have an Android
  // stub (SessionService.kt returns not-implemented-on-mobile) so a mobile invoke
  // rejects fast instead of 30s-timing-out. Assert the Kotlin stub covers all five.
  const kotlinPath = path.join(__dirname, '../../app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt');
  const leaseDeviceRequestChannels = [
    'syncspaces:lease-query',
    'syncspaces:lease-takeover',
    'syncspaces:lease-force',
    'syncspaces:list-devices',
    'syncspaces:rename-device',
    'syncspaces:remove-device',
    // Synced project description (project-description spec, Task 3). Desktop-only
    // for now, so it rides the SAME not-implemented-on-mobile stub arm. Without
    // it the phone's description editor waits ~30s for a response that never
    // arrives instead of rejecting immediately — delete the Kotlin arm and this
    // assertion is the only thing that notices.
    'syncspaces:set-project-description',
  ];
  if (fs.existsSync(kotlinPath)) {
    const kotlin = fs.readFileSync(kotlinPath, 'utf8');
    for (const ch of leaseDeviceRequestChannels) {
      it(`${ch} has an Android not-implemented-on-mobile stub in SessionService.kt`, () => {
        expect(kotlin).toContain(`"${ch}"`);
      });
    }
  } else {
    it.skip('SessionService.kt not found — skipping Android lease/device stub check', () => {});
  }

  // session:moved is a PUSH event (Task 8 broadcasts it), NOT a request — so it
  // has no ipc-handlers/Kotlin request handler. Assert only the two surfaces that
  // CONSUME it: preload (ipcRenderer.on) + remote-shim (addListener push routing).
  it('session:moved push channel present in preload + remote-shim', () => {
    expect(preload).toContain('session:moved');
    expect(shim).toContain('session:moved');
  });
});

// Local-folder description (project-description spec, Task 4). Saved folders are
// local-only — no sync surface — so parity is desktop-only, same four surfaces and
// same "ipc-handlers carries the constant, everyone else carries the literal"
// pattern as the syncspaces:* block above. NOTE: there was no pre-existing
// folders:* parity block to add a row to (unlike syncspaces:*) — folders:list/
// add/remove/rename were never covered here, so this new describe block is
// scoped to the one channel this task adds rather than backfilling the rest.
describe('folders:set-description channel parity (desktop surfaces)', () => {
  const channels: Array<[string, string]> = [
    ['folders:set-description', 'IPC.FOLDERS_SET_DESCRIPTION'],
  ];
  const preload = fs.readFileSync(path.join(__dirname, '../src/main/preload.ts'), 'utf8');
  const shim = fs.readFileSync(path.join(__dirname, '../src/renderer/remote-shim.ts'), 'utf8');
  const handlers = fs.readFileSync(path.join(__dirname, '../src/main/ipc-handlers.ts'), 'utf8');
  const remoteServer = fs.readFileSync(path.join(__dirname, '../src/main/remote-server.ts'), 'utf8');
  for (const [ch, constant] of channels) {
    it(`${ch} present in preload, remote-shim, ipc-handlers, remote-server`, () => {
      expect(preload).toContain(ch);
      expect(shim).toContain(ch);
      expect(handlers).toContain(constant);
      expect(remoteServer).toContain(ch);
    });
  }

  // Android carries a REAL handler for this one (not a stub): folders:rename
  // already has a native implementation, so its description sibling needs one
  // too — without the `"folders:set-description" ->` arm the phone silently
  // no-ops, the card refreshes, and the user's text is gone with no error.
  // Guarded by existsSync so a moved Kotlin path degrades to a skip rather
  // than exploding, same as the syncspaces stub block above.
  const kotlinFolderPath = path.join(__dirname, '../../app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt');
  if (fs.existsSync(kotlinFolderPath)) {
    const kotlin = fs.readFileSync(kotlinFolderPath, 'utf8');
    it('folders:set-description has a real Android handler arm in SessionService.kt', () => {
      expect(kotlin).toContain('"folders:set-description" ->');
    });
  } else {
    it.skip('SessionService.kt not found — skipping Android folders:set-description check', () => {});
  }
});

// Connect-GitHub modal (device-flow auth, 2026-07-14). The four REQUEST channels
// have full four-surface desktop parity (preload inlined literal / remote-shim
// invoke literal / ipc-handlers IPC.* constant / remote-server switch case) plus
// an Android not-implemented-on-mobile stub so a mobile invoke rejects fast. The
// github:connect-done PUSH event is asserted only where it's CONSUMED (preload +
// remote-shim) — same treatment as session:moved.
describe('github:* channel parity (desktop surfaces)', () => {
  const channels: Array<[string, string]> = [
    ['github:status', 'IPC.GITHUB_STATUS'],
    ['github:connect-start', 'IPC.GITHUB_CONNECT_START'],
    ['github:connect-cancel', 'IPC.GITHUB_CONNECT_CANCEL'],
    ['github:install-gh', 'IPC.GITHUB_INSTALL_GH'],
    // Connected accounts (Phase 3, 2026-07-22): deletes the app's stored token.
    ['github:disconnect', 'IPC.GITHUB_DISCONNECT'],
  ];
  const preload = fs.readFileSync(path.join(__dirname, '../src/main/preload.ts'), 'utf8');
  const shim = fs.readFileSync(path.join(__dirname, '../src/renderer/remote-shim.ts'), 'utf8');
  const handlers = fs.readFileSync(path.join(__dirname, '../src/main/ipc-handlers.ts'), 'utf8');
  const remoteServer = fs.readFileSync(path.join(__dirname, '../src/main/remote-server.ts'), 'utf8');
  for (const [ch, constant] of channels) {
    it(`${ch} present in preload, remote-shim, ipc-handlers, remote-server`, () => {
      expect(preload).toContain(ch);
      expect(shim).toContain(ch);
      expect(handlers).toContain(constant);
      expect(remoteServer).toContain(ch);
    });
  }

  // The four request channels also carry an Android stub (SessionService.kt
  // returns not-implemented-on-mobile) so a mobile invoke rejects fast.
  const kotlinPath = path.join(__dirname, '../../app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt');
  if (fs.existsSync(kotlinPath)) {
    const kotlin = fs.readFileSync(kotlinPath, 'utf8');
    for (const [ch] of channels) {
      it(`${ch} has an Android not-implemented-on-mobile stub in SessionService.kt`, () => {
        expect(kotlin).toContain(`"${ch}"`);
      });
    }
  } else {
    it.skip('SessionService.kt not found — skipping Android github stub check', () => {});
  }

  // github:connect-done is a PUSH event (main broadcasts it when the flow settles),
  // NOT a request — no Kotlin/ipc-handlers request handler. Assert only the two
  // surfaces that CONSUME it: preload (ipcRenderer.on) + remote-shim (dispatch).
  it('github:connect-done push channel present in preload + remote-shim', () => {
    expect(preload).toContain('github:connect-done');
    expect(shim).toContain('github:connect-done');
  });
});

// Native runtime capability flag (platform roadmap Phase 0 seam).
// preload and remote-shim must both expose window.claude.native.supported —
// the renderer gates the runtime selector on it without platform branching.
// It is a plain boolean (no IPC round-trip), so there is no ipc-handlers or
// SessionService.kt row — this describe pins shape parity only.
describe('native runtime capability parity', () => {
  it('preload.ts exposes native.supported', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/main/preload.ts'), 'utf8');
    expect(src).toMatch(/native:\s*\{/);
    expect(src).toMatch(/supported:/);
  });
  it('remote-shim.ts exposes native.supported: false', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/renderer/remote-shim.ts'), 'utf8');
    expect(src).toMatch(/native:\s*\{/);
    expect(src).toMatch(/supported:\s*false/);
  });
});

describe('native:*/provider:* channel parity', () => {
  const NEW_TYPES = [
    'native:send', 'native:interrupt', 'native:set-binding', 'native:set-permission-mode',
    // Task 14 — read-side mode fetch that seeds the chip on create/resume.
    'native:get-permission-mode', 'native:get-step-guard', 'native:set-step-guard', 'native:sessions-list',
    // Task 11 — cancel/edit a queued-but-not-yet-sent message.
    'native:queue-remove',
    // M3 item 2 — user-initiated /compact for a native session.
    'native:compact', 'native:clear',
    'provider:list', 'provider:upsert', 'provider:remove', 'provider:test', 'provider:set-key', 'provider:catalog',
  ];
  const CHANNEL_TO_CONST: Record<string, string> = {
    'native:send': 'IPC.NATIVE_SEND', 'native:interrupt': 'IPC.NATIVE_INTERRUPT',
    'native:set-binding': 'IPC.NATIVE_SET_BINDING', 'native:set-permission-mode': 'IPC.NATIVE_SET_PERMISSION_MODE',
    'native:get-permission-mode': 'IPC.NATIVE_GET_PERMISSION_MODE',
    'native:get-step-guard': 'IPC.NATIVE_GET_STEP_GUARD',
    'native:set-step-guard': 'IPC.NATIVE_SET_STEP_GUARD',
    'native:sessions-list': 'IPC.NATIVE_SESSIONS_LIST',
    'native:queue-remove': 'IPC.NATIVE_QUEUE_REMOVE',
    'native:compact': 'IPC.NATIVE_COMPACT',
    'native:clear': 'IPC.NATIVE_CLEAR',
    'provider:list': 'IPC.PROVIDER_LIST', 'provider:upsert': 'IPC.PROVIDER_UPSERT',
    'provider:remove': 'IPC.PROVIDER_REMOVE', 'provider:test': 'IPC.PROVIDER_TEST',
    'provider:set-key': 'IPC.PROVIDER_SET_KEY', 'provider:catalog': 'IPC.PROVIDER_CATALOG',
  };
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  it('exposed in preload.ts', () => {
    const src = read('src', 'main', 'preload.ts');
    for (const t of NEW_TYPES) expect(src.includes(`'${t}'`) || src.includes(CHANNEL_TO_CONST[t]), `${t} missing from preload.ts`).toBe(true);
  });
  it('exposed in remote-shim.ts', () => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const t of NEW_TYPES) expect(src, `${t} missing from remote-shim.ts`).toContain(`'${t}'`);
  });
  it('registered in ipc-handlers.ts (literal or IPC constant)', () => {
    const src = read('src', 'main', 'ipc-handlers.ts');
    for (const t of NEW_TYPES) expect(src.includes(`'${t}'`) || src.includes(CHANNEL_TO_CONST[t]), `${t} missing from ipc-handlers.ts`).toBe(true);
  });
  it('stubbed in SessionService.kt (Android)', () => {
    const kt = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    for (const t of NEW_TYPES) expect(kt, `${t} missing from SessionService.kt`).toContain(`"${t}"`);
  });
  // native:get-permission-mode is the one native channel with a remote-server WS
  // case (Task 14 — the chip must seed over remote too); assert that fifth surface.
  it('native:get-permission-mode handled by remote-server.ts (WS case)', () => {
    const src = read('src', 'main', 'remote-server.ts');
    expect(src, "native:get-permission-mode missing from remote-server.ts").toContain(`'native:get-permission-mode'`);
  });
  it.each(['native:get-step-guard', 'native:set-step-guard'])('%s is answered by remote-server', (channel) => {
    const src = read('src', 'main', 'remote-server.ts');
    const caseBlock = src.slice(src.indexOf(`case '${channel}'`));
    expect(caseBlock.slice(0, 500), `${channel} must send a response`).toContain('this.respond(');
  });
  it('native:send is answered by remote-server (request/response, not fire-and-forget)', () => {
    const src = read('src', 'main', 'remote-server.ts');
    const caseBlock = src.slice(src.indexOf(`case 'native:send'`));
    expect(caseBlock.slice(0, 400)).toContain('this.respond(');
  });
  // Task 11's queue-remove is also request/response (the renderer needs the
  // true/false result) — same fifth-surface + shape checks as native:send above.
  it('native:queue-remove handled by remote-server.ts (WS case, request/response)', () => {
    const src = read('src', 'main', 'remote-server.ts');
    expect(src, "native:queue-remove missing from remote-server.ts").toContain(`'native:queue-remove'`);
    const caseBlock = src.slice(src.indexOf(`case 'native:queue-remove'`));
    expect(caseBlock.slice(0, 400)).toContain('this.respond(');
  });
});

// Regression net for the search:* IPC channels (Phase 2 Plan B — keyed Tavily/
// Exa WebSearch upgrades). Full four-surface parity: preload.ts (inlined
// literal) / remote-shim.ts (invoke literal) / ipc-handlers.ts (IPC.* constant) /
// SessionService.kt (not-implemented-on-mobile stub). Drift would silently break
// the Search provider settings on one platform.
describe('search:* channel parity', () => {
  const NEW_TYPES = [
    'search:list', 'search:set-key', 'search:remove-key', 'search:test',
  ];
  const CHANNEL_TO_CONST: Record<string, string> = {
    'search:list': 'IPC.SEARCH_LIST',
    'search:set-key': 'IPC.SEARCH_SET_KEY',
    'search:remove-key': 'IPC.SEARCH_REMOVE_KEY',
    'search:test': 'IPC.SEARCH_TEST',
  };
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  it('exposed in preload.ts', () => {
    const src = read('src', 'main', 'preload.ts');
    for (const t of NEW_TYPES) expect(src, `${t} missing from preload.ts`).toContain(`'${t}'`);
  });
  it('exposed in remote-shim.ts', () => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const t of NEW_TYPES) expect(src, `${t} missing from remote-shim.ts`).toContain(`'${t}'`);
  });
  it('registered in ipc-handlers.ts (literal or IPC constant)', () => {
    const src = read('src', 'main', 'ipc-handlers.ts');
    for (const t of NEW_TYPES) expect(src.includes(`'${t}'`) || src.includes(CHANNEL_TO_CONST[t]), `${t} missing from ipc-handlers.ts`).toBe(true);
  });
  it('handled by remote-server.ts (WS case)', () => {
    const src = read('src', 'main', 'remote-server.ts');
    for (const t of NEW_TYPES) expect(src, `${t} missing from remote-server.ts`).toContain(`'${t}'`);
  });
  it('stubbed in SessionService.kt (Android)', () => {
    const kt = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    for (const t of NEW_TYPES) expect(kt, `${t} missing from SessionService.kt`).toContain(`"${t}"`);
  });
});

// Custom tags + per-session notes (session-tags feature).
// The channels must exist across all three parity surfaces so the shared
// React UI works identically on desktop (preload/Electron IPC), remote
// browsers (remote-shim/WebSocket), and Android (SessionService.kt).
describe('custom tags + notes channel parity', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
  const preload = read('../src/main/preload.ts');
  const remoteShim = read('../src/renderer/remote-shim.ts');
  const sessionService = read('../../app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt');
  const channels = [
    'session:set-tag', 'session:set-note', 'session:get-meta',
    'tags:list', 'tags:create', 'tags:update', 'tags:delete',
  ];
  for (const ch of channels) {
    test(`${ch} present in preload, remote-shim, and SessionService.kt`, () => {
      expect(preload).toContain(ch);
      expect(remoteShim).toContain(ch);
      expect(sessionService).toContain(ch);
    });
  }
});

// Local llama.cpp engine (Plan B, Task 9). The engine:* IPC surface must carry
// identical channel strings across all four parity files. ipc-handlers.ts
// references the IPC.ENGINE_* CONSTANTS (not literal strings), so its assertion
// checks the constant identifiers. The two push channels are broadcast-only —
// no Kotlin handler, so SessionService.kt only stubs the request-response ones.
describe('engine:* channel parity (Plan B)', () => {
  const channels = ['engine:status', 'engine:install', 'engine:restart'];
  const pushChannels = ['engine:install-progress', 'engine:status-changed'];
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  it('preload exposes every engine channel (request + push)', () => {
    const src = read('src', 'main', 'preload.ts');
    for (const ch of [...channels, ...pushChannels]) expect(src).toContain(`'${ch}'`);
  });
  it('remote-shim exposes every engine channel (request + push)', () => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const ch of [...channels, ...pushChannels]) expect(src).toContain(`'${ch}'`);
  });
  it('ipc-handlers registers every request-response engine channel', () => {
    const src = read('src', 'main', 'ipc-handlers.ts');
    for (const c of ['ENGINE_STATUS', 'ENGINE_INSTALL', 'ENGINE_RESTART']) expect(src).toContain(`IPC.${c}`);
  });
  it('SessionService.kt stubs every request-response engine channel', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    for (const ch of channels) expect(src).toContain(`"${ch}"`);
  });
});

// Self-contained like the engine:* describe (Amendment 2026-07-14 I): each test
// reads its own source. ipc-handlers uses the IPC.* CONSTANTS, so its check
// asserts the constant identifier — NOT the literal 'models:*' string, which
// never appears there and would always fail. Task 9 EXTENDS this `channels`
// array with ['engine:set-context','ENGINE_SET_CONTEXT'] when it wires the knob.
describe('models:* + engine:set-* channel parity (Plan C)', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const channels: Array<[string, string]> = [
    ['engine:set-backend', 'ENGINE_SET_BACKEND'],
    ['engine:set-context', 'ENGINE_SET_CONTEXT'],
    // One write for every engine-wide setting (2026-09-05 local-engine upgrades §B).
    // set-context above stays as its alias, so BOTH must be on every surface: a
    // caller wired to the old channel keeps working, new UI uses the new one.
    ['engine:set-config', 'ENGINE_SET_CONFIG'],
    // Faster-engine prerequisites (2026-09-05 local-engine upgrades §A5).
    ['engine:prereqs', 'ENGINE_PREREQS'],
    // "Run in terminal" (2026-09-05 §A5/§F): opens a plain-shell session and
    // types the set-up command onto its prompt. The remote client rides it too
    // — the shell runs on the HOST — so it is on every surface, Android's stub
    // included.
    ['engine:run-in-terminal', 'ENGINE_RUN_IN_TERMINAL'],
    ['models:curated', 'MODELS_CURATED'],
    ['models:search', 'MODELS_SEARCH'],
    ['models:quants', 'MODELS_QUANTS'],
    ['models:download', 'MODELS_DOWNLOAD'],
    ['models:download-cancel', 'MODELS_DOWNLOAD_CANCEL'],
    ['models:delete', 'MODELS_DELETE'],
    ['models:installed', 'MODELS_INSTALLED'],
    // Resume an interrupted download from its manifest (2026-08-26). Replaced
    // models:orphaned-partials, whose listing folded into models:installed —
    // two lists over one directory could disagree, which was the bug.
    ['models:resume', 'MODELS_RESUME'],
    // Per-model settings + vision (2026-09-05 local-engine upgrades §C/§E4).
    // These read and write the HOST's engine config and model folder, so a
    // remote browser gets the real answer and a phone gets a fast "desktop
    // only" instead of a 30-second wait.
    ['models:settings', 'MODELS_SETTINGS'],
    ['models:set-settings', 'MODELS_SET_SETTINGS'],
    ['models:add-vision', 'MODELS_ADD_VISION'],
    ['endpoints:detect', 'ENDPOINTS_DETECT'],
  ];
  const pushChannels = ['models:download-progress'];

  // Both halves, deliberately: the channel NAME has to be declared, and the
  // constant has to be USED. Checking the name alone passes on a constant
  // nobody wired to a method, which is a channel the renderer cannot call —
  // exactly the drift this file exists to catch.
  it('preload declares AND wires every request-response channel', () => {
    const src = read('src', 'main', 'preload.ts');
    for (const [ch, konst] of channels) {
      expect(src).toContain(`'${ch}'`);
      expect(src).toContain(`IPC.${konst}`);
    }
    for (const ch of pushChannels) expect(src).toContain(`'${ch}'`);
  });
  // `invoke('name'`, not the bare name: every one of these is a request the
  // remote client makes, and the bare name also matches a mention in a list
  // (REJECT_ON_NOT_OK names three of them), which would keep this green with the
  // method itself deleted.
  it('remote-shim invokes every request-response channel', () => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const [ch] of channels) expect(src).toContain(`invoke('${ch}'`);
    for (const ch of pushChannels) expect(src).toContain(`'${ch}'`);
  });
  // `ipcMain.handle(IPC.X`, not the bare constant: this is the surface where
  // "registered" decides whether the feature works at all, and the bare name
  // also matches a COMMENT. Proven, not assumed — replacing the whole
  // add-vision handler with `// FIXME reinstate the IPC.MODELS_ADD_VISION
  // handler` kept this test green until the call shape was required.
  it('ipc-handlers registers every request-response channel via ipcMain.handle', () => {
    const src = read('src', 'main', 'ipc-handlers.ts');
    for (const [, konst] of channels) expect(src).toContain(`ipcMain.handle(IPC.${konst}`);
  });
  // On a line that is NOT commented out, for the same reason: commenting the
  // Kotlin string leaves it in the file, so a bare text scan stays green while
  // the phone falls through to "Unknown message" and the shared UI waits.
  it('SessionService.kt stubs every request-response channel', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    const live = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    for (const [ch] of channels) expect(live).toContain(`"${ch}"`);
  });
  // A dropped SECOND argument is invisible everywhere else: main receives an
  // empty patch, changes nothing, returns the settings unchanged, and the dialog
  // renders that as a save that worked — the user toggles "Keep loaded" on,
  // reopens, and it is off again with no error. preload cannot be imported (it
  // calls contextBridge at load), so the call shape is pinned as text.
  it('preload forwards every argument of the two-argument channels', () => {
    const src = read('src', 'main', 'preload.ts');
    expect(src).toContain('ipcRenderer.invoke(IPC.MODELS_SET_SETTINGS, modelId, patch)');
    expect(src).toContain('ipcRenderer.invoke(IPC.MODELS_DOWNLOAD, repo, quant)');
  });
  // Android answers these six — and ONLY these six — with `unsupported`, not the
  // plain not-implemented error every other desktop-only channel sends.
  //
  // WHY the set has to be checked for EQUALITY and not just for presence: a
  // Kotlin `when` branch runs from its FIRST comma-separated value down to the
  // one carrying the `-> {`. Written into the middle of the long
  // not-implemented list, this branch's `-> {` silently swallowed the eighteen
  // native:* / provider:* channels above it — `provider:list` runs every time
  // the model picker opens, so a phone doing no remote access started popping
  // "provider:list isn't available via remote access yet." A presence-only
  // check called that green, because the six were all still present.
  it('SessionService.kt marks exactly the six local-engine channels unsupported', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');

    // Walk the `when` the way Kotlin does: labels accumulate until a line
    // carries `->`, and everything accumulated belongs to THAT branch.
    const armOf = new Map<string, string>();
    let pending: string[] = [];
    for (const line of src.split('\n')) {
      const t = line.trim();
      if (t.startsWith('//')) continue;
      const labels = [...t.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      if (labels.length === 0) continue;
      if (t.includes('->')) {
        const terminator = labels[labels.length - 1];
        for (const l of [...pending, ...labels]) if (!armOf.has(l)) armOf.set(l, terminator);
        pending = [];
      } else if (/^("[^"]+",\s*)+$/.test(t)) {
        pending.push(...labels);
      }
    }

    // Sanity: if the walk found nothing the equality below would pass vacuously.
    expect(armOf.get('provider:list')).toBe('github:disconnect');

    const six = [
      'engine:prereqs', 'engine:run-in-terminal', 'engine:set-config',
      'models:add-vision', 'models:set-settings', 'models:settings',
    ];
    const inTheArm = [...armOf.entries()]
      .filter(([, terminator]) => terminator === 'models:add-vision')
      .map(([ch]) => ch).sort();
    expect(inTheArm).toEqual(six);

    // …and the branch actually answers `unsupported`.
    const arrow = src.indexOf('"models:add-vision" -> {');
    expect(src.slice(arrow, arrow + 400)).toContain('.put("unsupported", true)');
  });

  // The FIFTH surface. remote-server.ts is where a remote browser's request
  // actually lands, and it is the one surface the original four-surface check
  // never looked at — a channel missing here answers nothing at all over the
  // remote link, and nothing else in the suite would notice. Every channel in
  // the list above is served here today, so there are no exemptions.
  it('remote-server.ts answers every request-response channel (the fifth surface)', () => {
    const src = read('src', 'main', 'remote-server.ts');
    const missing = channels.map(([ch]) => ch).filter((ch) => !src.includes(`case '${ch}':`));
    expect(missing).toEqual([]);
  });
});

// (The native:usage-report channel + its four-surface parity net were removed in
// the Phase 2 Plan C whole-branch review: the renderer→main usage cache
// (nativeUsageMap) was dead — nothing read it. Native StatusBar chips are sourced
// from the reducer's turn-complete usage via selectNativeStatusChips instead.)

// Model memory lifecycle (2026-07-14): per-model residency push + memory guard
// + [Reload Model]. Same self-contained parity shape as the Plan B/C describes.
describe('model memory lifecycle channel parity (2026-07-14)', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const invokeChannels: Array<[string, string]> = [
    ['engine:models', 'ENGINE_MODELS'],
    ['models:memory-check', 'MODELS_MEMORY_CHECK'],
    ['models:load', 'MODELS_LOAD'],
  ];
  const pushChannels = ['engine:models-changed', 'native:model-state'];

  it('preload exposes every channel (request + push)', () => {
    const src = read('src', 'main', 'preload.ts');
    for (const [ch] of invokeChannels) expect(src).toContain(`'${ch}'`);
    for (const ch of pushChannels) expect(src).toContain(`'${ch}'`);
  });
  it('remote-shim exposes every channel (request + push)', () => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const [ch] of invokeChannels) expect(src).toContain(`'${ch}'`);
    for (const ch of pushChannels) expect(src).toContain(`'${ch}'`);
  });
  it('ipc-handlers registers every request-response channel via its IPC.* constant', () => {
    const src = read('src', 'main', 'ipc-handlers.ts');
    for (const [, konst] of invokeChannels) expect(src).toContain(`IPC.${konst}`);
  });
  it('SessionService.kt stubs every request-response channel', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    for (const [ch] of invokeChannels) expect(src).toContain(`"${ch}"`);
  });
});

describe('git:* IPC parity (git surface, spec 2026-07-22)', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../src/main/preload.ts'), 'utf8');
  const shim = fs.readFileSync(path.join(__dirname, '../src/renderer/remote-shim.ts'), 'utf8');
  const handlers = fs.readFileSync(path.join(__dirname, '../src/main/ipc-handlers.ts'), 'utf8');
  const kotlinPath = path.join(__dirname, '../../app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt');
  const kotlin = fs.existsSync(kotlinPath) ? fs.readFileSync(kotlinPath, 'utf8') : null;

  const channels: Array<[string, string]> = [
    ['git:file-status', 'GIT_IPC.FILE_STATUS'],
    ['git:file-review', 'GIT_IPC.FILE_REVIEW'],
    ['git:commit-file-diff', 'GIT_IPC.COMMIT_FILE_DIFF'],
    ['git:stage', 'GIT_IPC.STAGE'],
    ['git:unstage', 'GIT_IPC.UNSTAGE'],
    ['git:commit', 'GIT_IPC.COMMIT'],
    ['git:discard', 'GIT_IPC.DISCARD'],
    ['git:watch', 'GIT_IPC.WATCH'],
    ['git:unwatch', 'GIT_IPC.UNWATCH'],
  ];

  for (const [ch, constant] of channels) {
    it(`${ch} present in preload + remote-shim + ipc-handlers`, () => {
      expect(preload).toContain(`'${ch}'`);
      expect(shim).toContain(`'${ch}'`);
      expect(handlers.includes(`'${ch}'`) || handlers.includes(constant)).toBe(true);
    });
    it(`${ch} has an Android not-implemented-on-mobile stub`, () => {
      if (kotlin) expect(kotlin).toContain(`"${ch}"`);
    });
  }

  it('git:changed push channel present in preload + remote-shim', () => {
    expect(preload).toContain(`'git:changed'`);
    expect(shim).toContain(`'git:changed'`);
  });
});

// Four-surface parity for the native:* channels.
//
// GAP THIS CLOSES (found 2026-07-28): shim/Android coverage in this file is
// per-PREFIX — dev:* and account:* each got their own block, and native:* never
// did. So "four-surface parity, pinned by ipc-channels.test.ts" (workspace
// CLAUDE.md, M3 handoff §2.7) was only two-thirds true for the native runtime:
// preload↔types drift was caught, but a channel missing from remote-shim.ts or
// SessionService.kt passed silently. Verified by deleting the native:invoke-skill
// line from remote-shim.ts — the whole file still went green.
//
// The consequence that matters: a native command that works on desktop and dies
// on the remote web client is exactly what program §9 exit criterion (c) forbids,
// and nothing would have told us.
describe('native:* channel parity', () => {
  const NATIVE_CHANNELS = [
    'native:send',
    'native:queue-remove',
    'native:interrupt',
    'native:compact',
    'native:clear',
    'native:invoke-skill',
    'native:set-binding',
    'native:set-permission-mode',
    'native:get-permission-mode',
    'native:sessions-list',
    'native:kill-shell',
  ];

  it('every native:* channel is declared in preload.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.ts'), 'utf8');
    for (const t of NATIVE_CHANNELS) expect(src, t).toContain(`'${t}'`);
  });

  it('every native:* channel is referenced in remote-shim.ts', () => {
    // The remote web client is in scope for every milestone (program §9 (c)).
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'remote-shim.ts'), 'utf8');
    for (const t of NATIVE_CHANNELS) expect(src, t).toContain(`'${t}'`);
  });

  it('every native:* channel is answered by SessionService.kt (Android)', () => {
    // Android's native runtime is M8, so these are honest not-implemented
    // replies rather than implementations — but a channel absent from the list
    // gets NO reply at all, which hangs the shared React UI instead of degrading it.
    const src = fs.readFileSync(path.join(
      __dirname, '..', '..', 'app', 'src', 'main', 'kotlin',
      'com', 'youcoded', 'app', 'runtime', 'SessionService.kt',
    ), 'utf8');
    for (const t of NATIVE_CHANNELS) expect(src, t).toContain(`"${t}"`);
  });
});

// Five-surface parity for the permissions management UI (M5 2a). A channel
// missing from remote-shim.ts or SessionService.kt would silently break the
// screen on remote or Android — the exact gap native:* had until 2026-07-28.
describe('permissions:* channel parity', () => {
  const NEW_TYPES = ['permissions:list', 'permissions:remove', 'permissions:remove-project'];
  const CHANNEL_TO_CONST: Record<string, string> = {
    'permissions:list': 'IPC.PERMISSIONS_LIST',
    'permissions:remove': 'IPC.PERMISSIONS_REMOVE',
    'permissions:remove-project': 'IPC.PERMISSIONS_REMOVE_PROJECT',
  };
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  it('exposed in preload.ts', () => {
    const src = read('src', 'main', 'preload.ts');
    for (const t of NEW_TYPES) expect(src, `${t} missing from preload.ts`).toContain(`'${t}'`);
  });
  it('exposed in remote-shim.ts', () => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const t of NEW_TYPES) expect(src, `${t} missing from remote-shim.ts`).toContain(`'${t}'`);
  });
  it('registered in ipc-handlers.ts', () => {
    const src = read('src', 'main', 'ipc-handlers.ts');
    for (const t of NEW_TYPES) expect(src.includes(`'${t}'`) || src.includes(CHANNEL_TO_CONST[t]), `${t} missing from ipc-handlers.ts`).toBe(true);
  });
  it('handled by remote-server.ts (WS case)', () => {
    const src = read('src', 'main', 'remote-server.ts');
    for (const t of NEW_TYPES) expect(src, `${t} missing from remote-server.ts`).toContain(`'${t}'`);
  });
  it('stubbed in SessionService.kt (Android)', () => {
    const kt = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    for (const t of NEW_TYPES) expect(kt, `${t} missing from SessionService.kt`).toContain(`"${t}"`);
  });
});

// Five-surface parity for the specialists roster/tier/card-action UI (Task 8,
// plan 1c). Cloned from the permissions:* block above — same gap it closes:
// a channel missing from remote-shim.ts or SessionService.kt would silently
// break the roster/tier pickers or a card's steer/stop button on remote or
// Android, the exact failure mode native:* had until 2026-07-28.
describe('specialists:* channel parity', () => {
  const NEW_TYPES = [
    'specialists:list',
    'specialists:delegated-get',
    'specialists:delegated-set',
    'specialists:steer',
    'specialists:interrupt',
  ];
  const CHANNEL_TO_CONST: Record<string, string> = {
    'specialists:list': 'IPC.SPECIALISTS_LIST',
    'specialists:delegated-get': 'IPC.SPECIALISTS_DELEGATED_GET',
    'specialists:delegated-set': 'IPC.SPECIALISTS_DELEGATED_SET',
    'specialists:steer': 'IPC.SPECIALISTS_STEER',
    'specialists:interrupt': 'IPC.SPECIALISTS_INTERRUPT',
  };
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  it('exposed in preload.ts', () => {
    const src = read('src', 'main', 'preload.ts');
    for (const t of NEW_TYPES) expect(src, `${t} missing from preload.ts`).toContain(`'${t}'`);
  });
  it('exposed in remote-shim.ts', () => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const t of NEW_TYPES) expect(src, `${t} missing from remote-shim.ts`).toContain(`'${t}'`);
  });
  it('registered in ipc-handlers.ts', () => {
    const src = read('src', 'main', 'ipc-handlers.ts');
    for (const t of NEW_TYPES) expect(src.includes(`'${t}'`) || src.includes(CHANNEL_TO_CONST[t]), `${t} missing from ipc-handlers.ts`).toBe(true);
  });
  it('handled by remote-server.ts (WS case)', () => {
    const src = read('src', 'main', 'remote-server.ts');
    for (const t of NEW_TYPES) expect(src, `${t} missing from remote-server.ts`).toContain(`'${t}'`);
  });
  it('stubbed in SessionService.kt (Android)', () => {
    const kt = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    for (const t of NEW_TYPES) expect(kt, `${t} missing from SessionService.kt`).toContain(`"${t}"`);
  });
  // specialists:event is a PUSH, not a request — it is exempt from the
  // ipc-handlers.ts (no `ipcMain.handle`, only a `.on()` forwarder) and
  // Kotlin/remote-server "request" surfaces the same way native:model-state
  // is (see the native:* describe block above). It still needs to exist on
  // BOTH client surfaces (preload + remote-shim) so a subscriber compiles and
  // actually receives it on either platform.
  it('specialists:event push channel present in preload + remote-shim only', () => {
    const preload = read('src', 'main', 'preload.ts');
    const shim = read('src', 'renderer', 'remote-shim.ts');
    const kt = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    expect(preload).toContain(`'specialists:event'`);
    expect(shim).toContain(`'specialists:event'`);
    // Never a request stub: unlike the five channels above, this is push-only
    // and must not appear in Kotlin's not-implemented list at all.
    expect(kt).not.toContain(`"specialists:event"`);
  });
});

// Five-surface parity for fs:read-head — the composer attachment card's head
// read (rendered markdown / mono text preview). Cloned from the permissions:*
// block: a channel missing from remote-shim.ts or SessionService.kt would
// silently turn every preview into the glyph on remote or Android.
describe('fs:* channel parity', () => {
  const NEW_TYPES = ['fs:read-head'];
  const CHANNEL_TO_CONST: Record<string, string> = { 'fs:read-head': 'IPC.FS_READ_HEAD' };
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  it('exposed in preload.ts', () => {
    const src = read('src', 'main', 'preload.ts');
    for (const t of NEW_TYPES) expect(src, `${t} missing from preload.ts`).toContain(`'${t}'`);
  });
  it('exposed in remote-shim.ts', () => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const t of NEW_TYPES) expect(src, `${t} missing from remote-shim.ts`).toContain(`'${t}'`);
  });
  it('registered in ipc-handlers.ts', () => {
    const src = read('src', 'main', 'ipc-handlers.ts');
    for (const t of NEW_TYPES) expect(src.includes(`'${t}'`) || src.includes(CHANNEL_TO_CONST[t]), `${t} missing from ipc-handlers.ts`).toBe(true);
  });
  it('handled by remote-server.ts (WS case)', () => {
    const src = read('src', 'main', 'remote-server.ts');
    for (const t of NEW_TYPES) expect(src, `${t} missing from remote-server.ts`).toContain(`'${t}'`);
  });
  it('handled by SessionService.kt (Android)', () => {
    const kt = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    for (const t of NEW_TYPES) expect(kt, `${t} missing from SessionService.kt`).toContain(`"${t}"`);
  });
  it('the Android cap mirrors READ_HEAD_MAX_BYTES', async () => {
    const { READ_HEAD_MAX_BYTES } = await import('../src/shared/read-head');
    const kt = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    expect(kt).toContain(`coerceIn(1, ${READ_HEAD_MAX_BYTES})`);
  });
});

// Four-surface parity for the marketplace feedback channels (overhaul Plan 1,
// Task 8). FOUR, not five: marketplace write channels have no remote-server.ts
// WS case — `marketplace:rate` has none either, so the remote browser cannot
// rate today and cannot vote either. This block pins the status quo; it does
// not fix it (ROADMAP).
describe('marketplace feedback channel parity', () => {
  // Three channels, not two: reading your OWN vote is an authed GET, so it
  // cannot be a direct renderer fetch the way the public comment list is —
  // the sign-in token lives in the main process.
  const NEW_TYPES = ['marketplace:thumb', 'marketplace:thumb:get', 'marketplace:comment'];
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  it('exposed in preload.ts', () => {
    const src = read('src', 'main', 'preload.ts');
    for (const t of NEW_TYPES) expect(src, `${t} missing from preload.ts`).toContain(`'${t}'`);
  });
  it('exposed in remote-shim.ts', () => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const t of NEW_TYPES) expect(src, `${t} missing from remote-shim.ts`).toContain(`'${t}'`);
  });
  it('registered in marketplace-api-handlers.ts', () => {
    const src = read('src', 'main', 'marketplace-api-handlers.ts');
    for (const t of NEW_TYPES) expect(src, `${t} missing from marketplace-api-handlers.ts`).toContain(`"${t}"`);
  });
  it('handled by SessionService.kt (Android)', () => {
    const kt = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    for (const t of NEW_TYPES) expect(kt, `${t} missing from SessionService.kt`).toContain(`"${t}"`);
  });
  it('the thumb handlers forward the TOTALS, not just the vote', () => {
    // Both thumbs routes return { vote, thumbs_up, thumbs_down }. A handler that
    // rebuilds the object and forgets the totals type-checks, passes every
    // component test (they mock the channel), and ships the bug it was written
    // to fix: a lit thumb beside "No votes yet" on reopen, because the count
    // falls back to the /stats snapshot taken at app start. Caught in a dev
    // build after a silent no-op edit, never by the suite — hence this guard.
    const src = read('src', 'main', 'marketplace-api-handlers.ts');
    for (const ch of ['marketplace:thumb', 'marketplace:thumb:get']) {
      const start = src.indexOf(`ipcMain.handle("${ch}"`);
      expect(start, `${ch} handler not found`).toBeGreaterThan(-1);
      const body = src.slice(start, start + 900);
      expect(body, `${ch} must forward thumbs_up`).toContain('thumbs_up');
      expect(body, `${ch} must forward thumbs_down`).toContain('thumbs_down');
    }
  });

  it('the shim sends an OBJECT payload for every one, never a bare id', () => {
    // Android reads `msg.payload.optString("plugin_id")`. A bare string payload
    // is not a JSON object there, so the id arrives empty and the call silently
    // does nothing on a phone — no error on either side. The two legal shapes are
    // an object literal (`{ plugin_id: pluginId }`) or the conventional `input`
    // variable, which is always an object type; anything else — `pluginId`,
    // `themeId`, `slug` — is the bug.
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const t of NEW_TYPES) {
      const call = src.match(new RegExp(`invoke\\('${t}',\\s*([^)]*)\\)`));
      expect(call, `no invoke('${t}', ...) found in remote-shim.ts`).toBeTruthy();
      const arg = call![1]!.trim();
      expect(
        arg.startsWith('{') || arg === 'input',
        `invoke('${t}') must pass an object literal or \`input\`, got: ${arg}`,
      ).toBe(true);
    }
  });
});

// The marketplace Worker's host is spelled out in two languages: TypeScript
// (MARKETPLACE_API_HOST) and Kotlin (MarketplaceFetcher.kt, which the Android
// catalog fetch builds `$MARKETPLACE_API_HOST/catalog` from). Neither can import
// the other, so the string is duplicated — exactly the drift these parity tests
// exist to catch. If someone moves the Worker, both copies must move together or
// Android silently keeps fetching the old host and falls back to index.json
// forever, with no error anywhere.
describe('marketplace Worker host parity (desktop ↔ Android)', () => {
  it('MarketplaceFetcher.kt names the same host as MARKETPLACE_API_HOST', () => {
    const tsSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'renderer', 'state', 'marketplace-api-client.ts'),
      'utf8',
    );
    const ktSrc = fs.readFileSync(
      path.join(
        __dirname, '..', '..', 'app', 'src', 'main', 'kotlin',
        'com', 'youcoded', 'app', 'skills', 'MarketplaceFetcher.kt',
      ),
      'utf8',
    );

    const ts = tsSrc.match(/export const MARKETPLACE_API_HOST = "([^"]+)"/);
    expect(ts, 'MARKETPLACE_API_HOST not found in marketplace-api-client.ts').toBeTruthy();

    const kt = ktSrc.match(/const val MARKETPLACE_API_HOST = "([^"]+)"/);
    expect(kt, 'MARKETPLACE_API_HOST not found in MarketplaceFetcher.kt').toBeTruthy();

    expect(kt![1]).toBe(ts![1]);
  });
});

// Five-surface parity for the games arcade's scores (spec §6.1). Android runs
// the SAME React UI, so a channel missing there does not fail loudly — the
// leaderboard silently degrades to "no board", which looks identical to having
// no friends. That is exactly the kind of drift a parity test exists to catch.
//
// The main-process surface is `arcade-handlers.ts`, not `ipc-handlers.ts`, the
// same way `social:*` lives in `social-handlers.ts`: every call needs the
// account bearer token, so it sits beside the other token-bound namespaces.
describe('arcade:* channel parity', () => {
  const TYPES = ['arcade:status', 'arcade:leaderboard', 'arcade:submit-score', 'arcade:records'];
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  it('exposed in preload.ts', () => {
    const src = read('src', 'main', 'preload.ts');
    for (const t of TYPES) expect(src, `${t} missing from preload.ts`).toContain(`'${t}'`);
  });

  it('exposed in remote-shim.ts', () => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const t of TYPES) expect(src, `${t} missing from remote-shim.ts`).toContain(`'${t}'`);
  });

  it('registered in arcade-handlers.ts', () => {
    const src = read('src', 'main', 'arcade-handlers.ts');
    for (const t of TYPES) expect(src, `${t} missing from arcade-handlers.ts`).toContain(`"${t}"`);
  });

  it('handled by remote-server.ts (WS case)', () => {
    const src = read('src', 'main', 'remote-server.ts');
    for (const t of TYPES) expect(src, `${t} missing from remote-server.ts`).toContain(`'${t}'`);
  });

  it('has a REAL Android handler arm, not a not-implemented stub', () => {
    const kt = fs.readFileSync(
      path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin',
        'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'),
      'utf8',
    );
    // `"channel" ->` is the arm marker. A channel listed in the shared
    // not-implemented fall-through would appear WITHOUT the arrow, which is
    // what this distinguishes — Android has a real HTTP client for this API,
    // so a stub here would be a silently worse product, not a platform limit.
    for (const t of TYPES) expect(kt, `${t} has no real arm in SessionService.kt`).toContain(`"${t}" ->`);
  });

  it('the shim sends an OBJECT payload, never bare positional args', () => {
    // Kotlin reads msg.payload.optString(...) — a bare arg arrives as nothing.
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const t of TYPES) {
      const call = src.match(new RegExp(`invoke\\('${t}'(,\\s*([^)]*))?\\)`));
      expect(call, `no invoke('${t}', ...) found in remote-shim.ts`).toBeTruthy();
      const arg = (call![2] ?? '').trim();
      expect(arg === '' || arg.startsWith('{'),
        `invoke('${t}') must pass an object literal or nothing, got: ${arg}`).toBe(true);
    }
  });
});

// Regression net for the three Linux/KDE buddy helper channels
// (docs/active/design/2026-09-04-linux-buddy-helper/, §4). Hand-written, like
// every block above — this file does NOT pick a new channel up for free.
//
// THREE surfaces, not five, and that is deliberate. The blocks above assert
// four or five because those features exist on Android and in the remote
// browser too. The buddy does not: it is desktop-Electron only, SessionService.kt
// contains no `buddy` string at all today (`buddy:show` / `buddy:hide` are not
// stubbed there either), and remote-server.ts has no buddy entry. Adding either
// would turn a three-channel feature into a platform-parity sweep, so the gap is
// left exactly as wide as it already was — recorded here so a later reader sees
// a decision rather than an oversight.
describe('buddy:* helper channel parity', () => {
  const TYPES = ['buddy:helper-status', 'buddy:install-helper', 'buddy:remove-helper'];
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  it('declared in the shared/types.ts channel map', () => {
    const src = read('src', 'shared', 'types.ts');
    for (const t of TYPES) expect(src, `${t} missing from shared/types.ts`).toContain(`'${t}'`);
  });

  it("declared in preload.ts's duplicate of that map", () => {
    const src = read('src', 'main', 'preload.ts');
    for (const t of TYPES) expect(src, `${t} missing from preload.ts`).toContain(`'${t}'`);
  });

  it('handled in ipc-handlers.ts', () => {
    const src = read('src', 'main', 'ipc-handlers.ts');
    // Asserted through the constant, not the string: this file imports the map
    // rather than writing channel names out, so a literal search would fail on
    // correct code.
    for (const name of ['BUDDY_HELPER_STATUS', 'BUDDY_INSTALL_HELPER', 'BUDDY_REMOVE_HELPER']) {
      expect(src, `IPC.${name} has no handler in ipc-handlers.ts`).toContain(`IPC.${name}`);
    }
  });

  it('exposed on the buddy API preload hands the renderer', () => {
    const src = read('src', 'main', 'preload.ts');
    for (const m of ['helperStatus', 'installHelper', 'removeHelper']) {
      expect(src, `buddy.${m} is not exposed by preload.ts`).toContain(`${m}: (`);
    }
  });

  it('answered by remote-shim.ts, so a remote browser cannot fall through', () => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    // The shim answers these locally instead of sending them over the wire, so
    // it never names the channel — the methods are what must exist.
    for (const m of ['helperStatus', 'installHelper', 'removeHelper']) {
      expect(src, `buddy.${m} is missing from remote-shim.ts`).toContain(`${m}: `);
    }
  });

  it('has NO Android or remote-server arm, deliberately', () => {
    // Pinned so the omission stays a decision. If the buddy ever grows an
    // Android or remote presence, this test is the thing that has to change,
    // and changing it is the prompt to add all three channels there properly.
    const kt = read('..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt');
    const remoteServer = read('src', 'main', 'remote-server.ts');
    for (const t of TYPES) {
      expect(kt, `${t} appeared in SessionService.kt — update this block`).not.toContain(`"${t}"`);
      expect(remoteServer, `${t} appeared in remote-server.ts — update this block`).not.toContain(`'${t}'`);
    }
    // Sanity: the buddy really has no Android surface at all, which is the
    // premise of the paragraph above. `buddy:show` predates this feature.
    expect(kt).not.toContain('"buddy:show"');
  });
});

// ── Voice prompting ──────────────────────────────────────────────────────────
// Talking instead of typing (design 2026-09-05). This is the one feature whose
// `window.claude` shape is deliberately NOT the same everywhere, so the parity
// check here has to say WHICH surface gets which channel rather than demanding
// all of them everywhere:
//
//   preload.ts          the desktop app       — every channel
//   voice/voice-handlers.ts  the desktop's main process — every channel
//   SessionService.kt   the Android app       — the five the phone can do,
//                                               plus a not-implemented stub for
//                                               the two that are desktop-only
//   remote-shim.ts      Android's window.claude — the five, minus the two
//                                               desktop-only ones
//
// A remote BROWSER tab gets no voice at all; that is a runtime decision (the
// namespace is deleted at install time) and is pinned by
// remote-shim-voice-gate.test.ts, not by a string search.
describe('voice:* channel parity', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const preload = read('src', 'main', 'preload.ts');
  const shim = read('src', 'renderer', 'remote-shim.ts');
  const handlers = read('src', 'main', 'voice', 'voice-handlers.ts');
  const kotlinPath = path.join(
    __dirname, '..', '..', 'app', 'src', 'main', 'kotlin',
    'com', 'youcoded', 'app', 'runtime', 'SessionService.kt',
  );

  /** The five calls every surface that has a microphone can answer. */
  const SHARED = ['voice:status', 'voice:download', 'voice:start', 'voice:stop', 'voice:cancel'];
  /** Desktop-only: the phone's own recogniser owns the microphone (voice:audio)
   *  and the Activity's permission launcher owns the permission question
   *  (voice:mic-access). */
  const DESKTOP_ONLY = ['voice:audio', 'voice:mic-access'];
  const PUSH = 'voice:event';

  it('preload.ts declares every voice channel', () => {
    for (const t of [...SHARED, ...DESKTOP_ONLY, PUSH]) {
      expect(preload, `${t} missing from preload.ts`).toContain(`'${t}'`);
    }
  });

  it('voice-handlers.ts really registers an arm for every voice channel', () => {
    // Fix (whole-branch review F5): this used to be `toContain("'voice:start'")`
    // over the raw source, which the file's own CHANNELS list already satisfied
    // — deleting every ipcMain.handle call left it green. Match the registration
    // itself, so the test fails when the arm goes away rather than when a string
    // does.
    for (const t of SHARED) {
      expect(handlers, `${t} has no ipcMain.handle in voice-handlers.ts`)
        .toMatch(new RegExp(`ipcMain\\.handle\\('${t}'`));
    }
    // The permission question is a handle; the audio stream is a fire-and-forget
    // `on` ten times a second, so it is registered the other way on purpose.
    expect(handlers).toMatch(/ipcMain\.handle\('voice:mic-access'/);
    expect(handlers).toMatch(/ipcMain\.on\(AUDIO_CHANNEL/);
    // The push has no handler at all — it is sent TO the window.
    expect(handlers).toMatch(/const EVENT_CHANNEL = 'voice:event'/);
    expect(handlers).toMatch(/send\(EVENT_CHANNEL/);
    // And every channel is on the list the double-registration guard clears.
    for (const t of [...SHARED, 'voice:mic-access']) {
      expect(handlers, `${t} missing from the CHANNELS clear-list`).toContain(`  '${t}',`);
    }
  });

  it('remote-shim.ts carries the five shared channels and the push event', () => {
    for (const t of [...SHARED, PUSH]) {
      expect(shim, `${t} missing from remote-shim.ts`).toContain(`'${t}'`);
    }
  });

  if (fs.existsSync(kotlinPath)) {
    const kotlin = fs.readFileSync(kotlinPath, 'utf8');
    it('SessionService.kt has a real arm for the four calls the phone answers', () => {
      // voice:download is NOT here — a phone downloads no speech model — so it
      // rides the not-implemented stub asserted below.
      for (const t of ['voice:status', 'voice:start', 'voice:stop', 'voice:cancel']) {
        expect(kotlin, `${t} has no real arm in SessionService.kt`).toContain(`"${t}" ->`);
      }
    });
    it('SessionService.kt stubs the two desktop-only calls so the phone fails fast', () => {
      // Listed WITHOUT the `->` arrow: they share the not-implemented-on-mobile
      // fall-through. A missing entry means a 30-second timeout on the phone
      // instead of an immediate, explained refusal.
      for (const t of ['voice:download', 'voice:mic-access']) {
        expect(kotlin, `${t} missing from SessionService.kt`).toContain(`"${t}"`);
      }
    });
    it('SessionService.kt pushes voice:event', () => {
      expect(kotlin).toContain('"voice:event"');
    });
  } else {
    it.skip('SessionService.kt not found — skipping Android voice parity', () => {});
  }

  // ── The two named exceptions to the parity rule ────────────────────────────
  // .claude/rules/ipc-bridge.md keeps a CLOSED list of members that exist on one
  // surface and not the other. These are two of them, asserted by name so that
  // "adding them to the shim for symmetry" fails here with the reason attached
  // rather than shipping a phone that fights its own recogniser for the mic.
  //
  // Scoped to the shim's `voice` block (indent 4, members at indent 6) rather
  // than searched file-wide: a bare absence check would also pass if the whole
  // namespace disappeared. Same brace scan the workbench contract test uses —
  // which is also why the namespace must stay a plain `voice: {`, never a
  // conditional spread.
  const shimVoiceBlock = (() => {
    const start = shim.search(/^ {4}voice: \{/m);
    if (start < 0) return null;
    const end = shim.indexOf('\n    },', start);
    return end < 0 ? shim.slice(start) : shim.slice(start, end);
  })();

  it("remote-shim's voice namespace is findable at the indentation the scans assume", () => {
    expect(shimVoiceBlock).not.toBeNull();
    for (const m of ['status', 'download', 'start', 'stop', 'cancel', 'onEvent']) {
      expect(shimVoiceBlock!, `voice.${m} missing from remote-shim.ts`)
        .toMatch(new RegExp(`^ {6}${m}\\s*[:(]`, 'm'));
    }
  });

  it('EXCEPTION: sendAudio is desktop-only — the phone\'s recogniser owns the microphone', () => {
    expect(preload, 'sendAudio must exist on the desktop').toContain('sendAudio');
    expect(shimVoiceBlock!, 'sendAudio must NOT be on the Android shim').not.toContain('sendAudio');
    expect(shim, 'voice:audio must never be sent over the bridge').not.toContain("'voice:audio'");
  });

  it("EXCEPTION: micAccess is desktop-only — the Activity's launcher owns that question", () => {
    expect(preload, 'micAccess must exist on the desktop').toContain('micAccess');
    expect(shimVoiceBlock!, 'micAccess must NOT be on the Android shim').not.toContain('micAccess');
    expect(shim, 'voice:mic-access must never be sent over the bridge').not.toContain("'voice:mic-access'");
  });
});

// Five-surface parity for Sign in with ChatGPT (backend design 2026-09-05 §5,
// §8). Shaped like the arcade block above, with one deliberate difference: the
// Android assertion is "listed in the not-implemented fall-through", the
// permissions:* / specialists:* precedent — the account, its encrypted tokens
// and the 127.0.0.1:1455 sign-in listener all live in the DESKTOP main process,
// and Android has no native runtime to hold any of that until M8. A REAL arm
// there would be wrong, and a missing entry would make a phone's invoke hang
// ~30 s instead of rejecting fast.
describe('chatgpt:* channel parity', () => {
  const TYPES = ['chatgpt:status', 'chatgpt:sign-in', 'chatgpt:cancel-sign-in', 'chatgpt:sign-out'];
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  // Review T4 F2: a bare `toContain("'chatgpt:status'")` was satisfied by the
  // IPC constants table alone, because this namespace invokes through IPC.*
  // rather than a literal. Deleting all four methods from the exposed
  // `chatgpt: { ... }` object shipped GREEN -- and every desktop user would then
  // get "window.claude.chatgpt.status is not a function" the moment they opened
  // the Settings card. Assert the actual invoke through the constant instead.
  it('exposed in preload.ts', () => {
    const src = read('src', 'main', 'preload.ts');
    const CONSTS: Record<string, string> = {
      'chatgpt:status': 'CHATGPT_STATUS',
      'chatgpt:sign-in': 'CHATGPT_SIGN_IN',
      'chatgpt:cancel-sign-in': 'CHATGPT_CANCEL_SIGN_IN',
      'chatgpt:sign-out': 'CHATGPT_SIGN_OUT',
    };
    for (const t of TYPES) {
      expect(src, t + ' missing from preload.ts').toContain("'" + t + "'");
      expect(src, t + ' is only in the constants table -- preload never invokes it')
        .toContain('ipcRenderer.invoke(IPC.' + CONSTS[t] + ')');
    }
  });

  it('exposed in remote-shim.ts', () => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const t of TYPES) expect(src, `${t} missing from remote-shim.ts`).toContain(`'${t}'`);
  });

  it('registered in ipc-handlers.ts (through the IPC constants)', () => {
    // The handlers use IPC.CHATGPT_* rather than string literals, so assert
    // the constant exists in shared/types.ts AND the handler references it.
    const types = read('src', 'shared', 'types.ts');
    const handlers = read('src', 'main', 'ipc-handlers.ts');
    const constants: Record<string, string> = {
      'chatgpt:status': 'CHATGPT_STATUS',
      'chatgpt:sign-in': 'CHATGPT_SIGN_IN',
      'chatgpt:cancel-sign-in': 'CHATGPT_CANCEL_SIGN_IN',
      'chatgpt:sign-out': 'CHATGPT_SIGN_OUT',
    };
    for (const t of TYPES) {
      expect(types, `${t} missing from shared/types.ts IPC`).toContain(`${constants[t]}: '${t}'`);
      expect(handlers, `IPC.${constants[t]} has no ipcMain.handle in ipc-handlers.ts`).toContain(`ipcMain.handle(IPC.${constants[t]}`);
    }
  });

  it('handled by remote-server.ts (WS case)', () => {
    const src = read('src', 'main', 'remote-server.ts');
    for (const t of TYPES) expect(src, `${t} missing from remote-server.ts`).toContain(`case '${t}'`);
  });

  it('is listed in the Android not-implemented fall-through, NOT a real arm', () => {
    const kt = fs.readFileSync(
      path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin',
        'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'),
      'utf8',
    );
    for (const t of TYPES) {
      expect(kt, `${t} not listed in SessionService.kt`).toContain(`"${t}"`);
      // `"channel" ->` is the real-arm marker (see the arcade block). Android
      // cannot run the sign-in, so an arm here would be a fake, not a feature.
      expect(kt, `${t} has a real arm in SessionService.kt — it must be a not-implemented stub`).not.toContain(`"${t}" ->`);
    }
  });

  it('the preload flag and the mock/remote flags exist, so the renderer gate (=== true) is honest everywhere', () => {
    // Review R1-9: a `supported` the renderer reads as `=== true` must be SET
    // on every surface — undefined hides the card in the workbench and on the
    // acceptance deck for a tooling reason.
    expect(read('src', 'main', 'preload.ts')).toMatch(/chatgpt:\s*\{\s*supported: process\.env\.YOUCODED_CHATGPT !== '0'/);
    expect(read('src', 'renderer', 'dev', 'workbench', 'mock-shim.ts')).toMatch(/const chatgpt = \{[\s\S]*?supported: true,/);
    expect(read('src', 'renderer', 'remote-shim.ts')).toMatch(/chatgpt:\s*\{\s*supported: false,/);
  });

  it('the shim sends an OBJECT payload or nothing, never bare positional args', () => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const t of TYPES) {
      const call = src.match(new RegExp(`invoke\\('${t}'(,\\s*([^)]*))?\\)`));
      expect(call, `no invoke('${t}', ...) found in remote-shim.ts`).toBeTruthy();
      const arg = (call![2] ?? '').trim();
      expect(arg === '' || arg.startsWith('{'),
        `invoke('${t}') must pass an object literal or nothing, got: ${arg}`).toBe(true);
    }
  });
});

// The kill switch and the lock-out guard are wiring, not channels: nothing else
// in the suite reads main.ts, and both are one line whose deletion is silent.
// Reviews T4 F1/F3 and T5 F1/F2 measured that each could be dropped with the
// whole suite still green.
describe('Sign in with ChatGPT - the wiring that has no other guard', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  it('the kill switch reaches the handlers, the background poll and the first-run arm', () => {
    const handlers = read('src', 'main', 'ipc-handlers.ts');
    const main = read('src', 'main', 'main.ts');
    // 1. The handlers, the provider row and the catalog.
    expect(handlers, 'the kill switch no longer gates the user-facing handle')
      .toMatch(/chatgptForUi[^\n]*process\.env\.YOUCODED_CHATGPT !== '0'/);
    // 2. The background usage poll. WHY this one matters most: the poll
    //    refreshes the token, and a rejected refresh deletes the saved sign-in -
    //    so an ungated poll turns "turn the feature off" into "sign the user
    //    out", the opposite of what the switch promises.
    expect(main, 'ChatGptAuth is constructed without the pollUsage gate')
      .toMatch(/pollUsage:\s*chatgptEnabled/);
    expect(main, 'the kill switch is not read into chatgptEnabled')
      .toMatch(/const chatgptEnabled = process\.env\.YOUCODED_CHATGPT !== '0'/);
    // 3. The first-run arm, which would otherwise still open a browser tab and
    //    bind port 1455 with the feature turned off.
    expect(main, "the wizard's ChatGPT arm ignores the kill switch")
      .toMatch(/mode === 'chatgpt' && chatgptEnabled/);
  });

  it('re-showing the setup wizard marks setup complete first, so it cannot strand an established install', () => {
    const main = read('src', 'main', 'main.ts');
    const i = main.indexOf("forceStep('AUTHENTICATE')");
    expect(i, 'main.ts no longer re-shows the wizard - update this guard').toBeGreaterThan(0);
    // The 400 characters before it must contain the completion mark. WHY:
    // forceStep() writes 'AUTHENTICATE' to the state file and isFirstRun() reads
    // exactly that - so without the mark, closing the window without signing in
    // makes the NEXT launch take the early first-run branch, skip the
    // provider-aware check entirely, and re-run the Node/Git/Claude installers
    // against a working install. This branch removed the Skip link, so a failing
    // installer there leaves the user with no way forward at all.
    expect(main.slice(Math.max(0, i - 400), i), 'markSetupCompleted() must run before forceStep(AUTHENTICATE)')
      .toContain('markSetupCompleted()');
  });
});
