// What a screen can do (src/shared/capabilities.ts): the three sets of values, how a handshake's object is read, and that
// every place that spells the values out (the preload copy, Android's Kotlin) says the same thing.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ANDROID_LOCAL_CAPABILITIES, DESKTOP_WINDOW_CAPABILITIES, PROTOCOL_VERSION, REMOTE_SCREEN_CAPABILITIES,
  normalizeCapabilities, normalizeProtocolVersion,
} from '../src/shared/capabilities';
import { readSource } from './helpers/guard-scope';

const root = path.resolve(__dirname, '..');
const KOTLIN_ROUTER = path.resolve(root, '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'bridge', 'MessageRouter.kt');

describe('reading a handshake\'s capabilities', () => {
  it('takes every known value as sent', () => {
    expect(normalizeCapabilities({ ...DESKTOP_WINDOW_CAPABILITIES })).toEqual(DESKTOP_WINDOW_CAPABILITIES);
    expect(normalizeCapabilities({ ...ANDROID_LOCAL_CAPABILITIES })).toEqual(ANDROID_LOCAL_CAPABILITIES);
  });

  it('an older computer that sends nothing gets the conservative set: nothing that needs the computer\'s own machine', () => {
    for (const none of [undefined, null, 'x', 7, []]) expect(normalizeCapabilities(none)).toEqual(REMOTE_SCREEN_CAPABILITIES);
    const c = normalizeCapabilities(undefined);
    expect([c.nativeWindows, c.openInOs, c.git, c.nativeSessions, c.buddy, c.projectWrites]).toEqual([false, false, false, false, false, false]);
  });

  it('a value of the wrong type falls back, a missing key falls back, and an unknown key is dropped', () => {
    const c = normalizeCapabilities({ openInOs: 'yes', terminalTransport: 'carrier-pigeon', nativeWindows: true, somethingNew: true }) as unknown as Record<string, unknown>;
    expect(c.openInOs).toBe(false);
    expect(c.terminalTransport).toBe('text');
    expect(c.nativeWindows).toBe(true);
    expect(c.git).toBe(false);
    expect('somethingNew' in c).toBe(false);
  });

  it('reads the protocol version as a positive whole number, and 0 when the host sent none', () => {
    expect(normalizeProtocolVersion(1)).toBe(1);
    for (const bad of [undefined, null, '1', 0, -1, 1.5, NaN]) expect(normalizeProtocolVersion(bad)).toBe(0);
  });

  it('the three sets have the same keys, so no screen is missing an answer', () => {
    const keys = (c: object) => Object.keys(c).sort();
    expect(keys(REMOTE_SCREEN_CAPABILITIES)).toEqual(keys(DESKTOP_WINDOW_CAPABILITIES));
    expect(keys(ANDROID_LOCAL_CAPABILITIES)).toEqual(keys(DESKTOP_WINDOW_CAPABILITIES));
  });
});

describe('every copy of the values agrees', () => {
  it('the preload\'s generated copy is the shared one, with the native kill switch as its one runtime part', () => {
    const preload = readSource(path.join(root, 'src', 'main', 'preload.ts'));
    expect(preload).toContain(`const PROTOCOL_VERSION = ${PROTOCOL_VERSION};`);
    for (const [k, v] of Object.entries(DESKTOP_WINDOW_CAPABILITIES)) {
      expect(preload, `preload copy of ${k}`).toContain(`  ${k}: ${typeof v === 'string' ? `'${v}'` : v},`);
    }
    expect(preload).toContain("nativeSessions: process.env.YOUCODED_NATIVE !== '0'");
  });

  it('Android\'s MessageRouter.kt reports the same version and the same Android values', () => {
    const kt = readSource(KOTLIN_ROUTER);
    expect(kt.match(/const val PROTOCOL_VERSION = (\d+)/)?.[1], 'PROTOCOL_VERSION in MessageRouter.kt').toBe(String(PROTOCOL_VERSION));
    const block = kt.match(/fun buildCapabilities\(\): JSONObject \{([\s\S]*?)\n    \}/);
    expect(block, 'could not find buildCapabilities() in MessageRouter.kt').not.toBeNull();
    const kotlin: Record<string, unknown> = {};
    for (const m of block![1].matchAll(/put\("(\w+)",\s*("[^"]*"|true|false)\)/g)) kotlin[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2] === 'true';
    expect(kotlin).toEqual({ ...ANDROID_LOCAL_CAPABILITIES });
    expect(kt).toContain('put("protocolVersion", PROTOCOL_VERSION)');
    expect(kt).toContain('put("capabilities", buildCapabilities())');
  });
});
