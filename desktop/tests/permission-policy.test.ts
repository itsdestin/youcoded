// Pins audit F4: a page may use the microphone (voice), copy/paste and full-screen — nothing else.
import { describe, it, expect } from 'vitest';
import { isPermissionAllowed, installPermissionPolicy } from '../src/main/permission-policy';
import { isAppPageUrl } from '../src/main/app-navigation';

const INDEX = '/opt/app/renderer/index.html';
const DEV = 'http://localhost:5223';
const ctx = { isAppPage: (u: string) => isAppPageUrl(u, INDEX, DEV) };
const APP = 'file:///opt/app/renderer/index.html?mode=main';

describe('permission policy', () => {
  it('lets the app page use the microphone, and only the microphone', () => {
    expect(isPermissionAllowed({ permission: 'media', requestingUrl: APP, mediaTypes: ['audio'] }, ctx)).toBe(true);
    expect(isPermissionAllowed({ permission: 'media', requestingUrl: APP, mediaTypes: ['video'] }, ctx)).toBe(false);
    expect(isPermissionAllowed({ permission: 'media', requestingUrl: APP, mediaTypes: ['audio', 'video'] }, ctx)).toBe(false);
    expect(isPermissionAllowed({ permission: 'media', requestingUrl: DEV + '/', mediaTypes: ['audio'] }, ctx)).toBe(true);
  });
  it('allows copy/paste and full-screen for the app page and the document editor', () => {
    for (const p of ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen']) {
      expect(isPermissionAllowed({ permission: p, requestingUrl: APP }, ctx), p).toBe(true);
      expect(isPermissionAllowed({ permission: p, requestingUrl: 'office://abc/editor.html' }, ctx), p).toBe(true);
    }
  });
  it('refuses everything else, from anywhere', () => {
    for (const p of ['geolocation', 'notifications', 'midi', 'midiSysex', 'display-capture', 'hid', 'usb', 'serial', 'openExternal',
      'idle-detection', 'window-management', 'pointerLock', 'keyboardLock', 'unknown', 'persistent-storage', 'speaker-selection', 'local-fonts']) {
      expect(isPermissionAllowed({ permission: p, requestingUrl: APP }, ctx), p).toBe(false);
    }
    expect(isPermissionAllowed({ permission: 'media', requestingUrl: 'office://abc/e.html', mediaTypes: ['audio'] }, ctx)).toBe(false);
  });
  it('refuses pages that are not the app: previews, other files, web pages', () => {
    for (const u of ['about:srcdoc', '', 'null', 'https://example.com/', 'file:///tmp/evil.html', 'data:text/html,x', 'http://localhost:9999/']) {
      expect(isPermissionAllowed({ permission: 'media', requestingUrl: u, mediaTypes: ['audio'] }, ctx), u).toBe(false);
      expect(isPermissionAllowed({ permission: 'clipboard-read', requestingUrl: u }, ctx), u).toBe(false);
    }
  });
  it('wires both the ask handler and the check handler', () => {
    let ask: any; let check: any;
    installPermissionPolicy({ setPermissionRequestHandler: (h) => { ask = h; }, setPermissionCheckHandler: (h) => { check = h; } }, { indexHtmlPath: INDEX, devServerUrl: DEV });
    let granted: boolean | undefined;
    ask({}, 'media', (g: boolean) => { granted = g; }, { requestingUrl: APP, mediaTypes: ['audio'] });
    expect(granted).toBe(true);
    ask({}, 'media', (g: boolean) => { granted = g; }, { requestingUrl: APP, mediaTypes: ['video'] });
    expect(granted).toBe(false);
    expect(check({}, 'media', 'file://', { requestingUrl: APP, mediaType: 'audio' })).toBe(true);
    expect(check({}, 'media', 'file://', { requestingUrl: APP, mediaType: 'video' })).toBe(false);
    expect(check({}, 'geolocation', 'file://', { requestingUrl: APP })).toBe(false);
  });
});
