// What the shared page asks the Android app itself (invokeAndroidHost in remote-shim.ts) and what the app
// answers (HostJsBridge.kt) must be the same list. WHY (2026-10-14, Android clean rebuild): everything else
// goes to the desktop backend running on the phone, so this short list is the whole Kotlin surface the page
// depends on — a type on one side only is a button that waits two minutes and then fails.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repo = path.join(__dirname, '..', '..');
const shim = fs.readFileSync(path.join(repo, 'desktop/src/renderer/remote-shim.ts'), 'utf8');
const kotlin = fs.readFileSync(path.join(repo, 'app/src/main/kotlin/com/youcoded/app/bridge/HostJsBridge.kt'), 'utf8');

const fromShim = new Set([...shim.matchAll(/invokeAndroidHost\('([^']+)'/g)].map((m) => m[1]));
const typesBlock = kotlin.slice(kotlin.indexOf('val TYPES = listOf('), kotlin.indexOf(')', kotlin.indexOf('val TYPES = listOf(')));
const declared = new Set([...typesBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
const handled = new Set([...kotlin.matchAll(/^\s*"([a-z]+:[a-z-]+)" ->/gm)].map((m) => m[1]));

describe('the Android app answers exactly what the page asks it', () => {
  it('finds both lists (the scan itself works)', () => {
    expect(fromShim.size).toBeGreaterThan(5);
    expect(declared.size).toBeGreaterThan(5);
  });

  it('every type the page sends to the app is one the app answers', () => {
    expect([...fromShim].filter((t) => !handled.has(t))).toEqual([]);
  });

  it('every type the app answers is declared, and every declared type is answered', () => {
    expect([...handled].sort()).toEqual([...declared].sort());
  });

  it('the app answers nothing the page never sends', () => {
    expect([...declared].filter((t) => !fromShim.has(t))).toEqual([]);
  });
});
