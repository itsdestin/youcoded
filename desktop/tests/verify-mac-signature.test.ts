// Pins scripts/verify-mac-signature.sh — the CI check that stops an unsigned Mac app
// from shipping (six weeks of unopenable builds went out with every check green before
// it existed, 2026-07-23 → 2026-09-03). Runs on any OS: `codesign` and `PlistBuddy`
// are replaced by tiny stand-in scripts via the CODESIGN / PLISTBUDDY env hooks, so
// what is under test is the script's own logic — which cases it rejects, and that
// every rejection carries a readable reason instead of a bare non-zero exit.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SCRIPT = path.resolve(__dirname, '../scripts/verify-mac-signature.sh');

let tmp: string;

// A fake `codesign`: `--verify` exits per VERIFY_EXIT, `-d` prints the identifier in
// CODESIGN_IDENT (blank = no Identifier line at all, like a truly unsigned binary).
function writeStub(name: string, body: string): string {
  const p = path.join(tmp, 'bin', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return p;
}

function makeApp(dir: string, bundleId = 'com.youcoded.desktop'): void {
  const contents = path.join(tmp, 'release', dir, 'YouCoded.app', 'Contents');
  fs.mkdirSync(contents, { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), bundleId);
}

function run(env: Record<string, string> = {}) {
  const codesign = writeStub(
    'codesign',
    `if [ "$1" = "--verify" ]; then
       for a in "$@"; do case "$a" in */converter/*)
         echo "stub converter verify output: $a"
         case "$a" in *"\${UNSIGNED_CONVERTER_FILE:-<none>}") exit 1;; esac
         exit 0;; esac; done
       echo "stub verify output"; exit "\${VERIFY_EXIT:-0}"
     fi
     if [ "$1" = "-d" ]; then
       [ -n "\${CODESIGN_IDENT:-}" ] && echo "Identifier=\${CODESIGN_IDENT}"
       echo "Signature=adhoc"; exit 0
     fi
     exit 2`,
  );
  // The stand-in PlistBuddy just prints the file's content (the tests write the bare id).
  const plistbuddy = writeStub('PlistBuddy', 'cat "$3"');
  const r = spawnSync('bash', [SCRIPT, path.join(tmp, 'release')], {
    cwd: tmp,
    encoding: 'utf8',
    env: { ...process.env, CODESIGN: codesign, PLISTBUDDY: plistbuddy, CODESIGN_IDENT: 'com.youcoded.desktop', ...env },
  });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-mac-sig-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('verify-mac-signature.sh', () => {
  it('passes when every bundle verifies and the identifier matches Info.plist', () => {
    makeApp('mac');
    makeApp('mac-arm64');
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toContain('2 macOS bundle(s) signed and sealed');
  });

  it('fails when codesign --verify rejects the seal, and surfaces codesign\'s own output', () => {
    // The beta.72 case: `codesign --verify` says "code object is not signed at all".
    makeApp('mac');
    const r = run({ VERIFY_EXIT: '1' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('::error::');
    expect(r.out).toContain('failed codesign --verify');
    expect(r.out).toContain('stub verify output'); // the cause is never swallowed
  });

  it('fails when the signing identifier is the stock Electron one', () => {
    // A seal can exist while the wrong thing was sealed — the prebuilt binary keeps
    // its "Electron" identifier when electron-builder never re-signed it.
    makeApp('mac');
    const r = run({ CODESIGN_IDENT: 'Electron' });
    expect(r.status).toBe(1);
    expect(r.out).toContain("signing identifier is 'Electron', expected 'com.youcoded.desktop'");
  });

  it('fails when no Identifier line is present at all', () => {
    makeApp('mac');
    const r = run({ CODESIGN_IDENT: '' });
    expect(r.status).toBe(1);
    expect(r.out).toContain("signing identifier is '<none>'");
  });

  it('compares against the bundle\'s OWN CFBundleIdentifier, not a hard-coded string', () => {
    // A beta-channel bundle id must not turn the check red on a correctly signed app.
    makeApp('mac', 'com.youcoded.desktop.beta');
    const r = run({ CODESIGN_IDENT: 'com.youcoded.desktop.beta' });
    expect(r.status).toBe(0);
  });

  // The Office converter sits in Contents/Resources/, where --deep does not look for code, and
  // Apple silicon will not run it unsigned — so each of its files is verified on its own.
  function withOffice(dir: string, files: string[]): void {
    const conv = path.join(tmp, 'release', dir, 'YouCoded.app', 'Contents', 'Resources', 'office', 'converter');
    fs.mkdirSync(conv, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(conv, f), '');
  }

  it('passes when the Office converter and its libraries are signed', () => {
    makeApp('mac-arm64');
    withOffice('mac-arm64', ['x2t', 'libkernel.dylib', 'libicuuc.58.dylib', 'AllFonts.js']);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toContain('Office converter signed (x2t and 2 dylib(s))');
  });

  it('fails naming the converter library that is not signed', () => {
    makeApp('mac-arm64');
    withOffice('mac-arm64', ['x2t', 'libkernel.dylib', 'libicuuc.58.dylib']);
    const r = run({ UNSIGNED_CONVERTER_FILE: 'libicuuc.58.dylib' });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/::error::.*converter\/libicuuc\.58\.dylib failed codesign --verify/);
  });

  it('fails when the app carries Office without its converter', () => {
    makeApp('mac');
    fs.mkdirSync(path.join(tmp, 'release', 'mac', 'YouCoded.app', 'Contents', 'Resources', 'office', 'editors'), { recursive: true });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain('carries Office but no converter/x2t');
  });

  it('fails loudly when no .app bundle exists (the mac build never ran)', () => {
    fs.mkdirSync(path.join(tmp, 'release'), { recursive: true });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain('no .app bundle found');
  });
});
