// The iPhone app's shell (ios/) against the page and the backend it hosts. WHY these are desktop tests: the shell is
// Swift and only compiles on a Mac (CI: ios-ci.yml), but the things it must agree on live in THIS codebase — the list
// of phone-only calls the page makes, the page's private address, the backend's host methods, the worker threads the
// bundle must carry. A mismatch is a button that waits two minutes and fails, or an app that shows a blank page, and
// none of that fails a Swift build.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { IOS_PAGE_ORIGIN, ANDROID_PAGE_ORIGIN } from '../src/shared/android-page-origin';
import { IOS_LOCAL_CAPABILITIES, ANDROID_LOCAL_CAPABILITIES, DESKTOP_WINDOW_CAPABILITIES, REMOTE_SCREEN_CAPABILITIES, normalizeCapabilities } from '../src/shared/capabilities';
import { isAllowedWsOrigin } from '../src/main/remote-origin';

const repo = path.join(__dirname, '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(repo, ...p), 'utf8');
const swift = (name: string) => read('ios', 'YouCoded', name);

describe('the iPhone app answers exactly what the page asks it', () => {
  const page = read('desktop/src/renderer/remote-shim.ts') + read('desktop/src/renderer/android-local-bridge.ts');
  const fromPage = new Set([...page.matchAll(/invokeAndroidHost\('([^']+)'/g)].map((m) => m[1]));
  const bridge = swift('HostJsBridge.swift');
  const typesBlock = bridge.slice(bridge.indexOf('static let types: [String] = ['), bridge.indexOf(']', bridge.indexOf('static let types: [String] = [') + 32));
  const declared = new Set([...typesBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const handled = new Set([...bridge.matchAll(/^\s*case "([a-z]+:[a-z-]+)"/gm)].map((m) => m[1]));

  it('finds the lists (the scan itself works)', () => {
    expect(fromPage.size).toBeGreaterThan(5);
    expect(declared.size).toBeGreaterThan(5);
    expect(handled.size).toBeGreaterThan(5);
  });

  it('every type the page sends is one the iPhone app answers', () => {
    expect([...fromPage].filter((t) => !handled.has(t))).toEqual([]);
  });

  it('every type it answers is declared, and every declared type is answered', () => {
    expect([...handled].sort()).toEqual([...declared].sort());
  });

  it('answers the same list as the Android app (one page, two phones)', () => {
    const kotlin = read('app/src/main/kotlin/com/youcoded/app/bridge/HostJsBridge.kt');
    const block = kotlin.slice(kotlin.indexOf('val TYPES = listOf('), kotlin.indexOf(')', kotlin.indexOf('val TYPES = listOf(')));
    const android = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect([...declared].sort()).toEqual(android);
  });

  it('pushes only the events the page listens for', () => {
    const pushed = new Set([...bridge.matchAll(/push\("([a-z]+:[a-z-]+)"/g)].map((m) => m[1]));
    expect([...pushed].sort()).toEqual(['system:back', 'system:open-session', 'voice:event']);
  });
});

describe('the backend\'s calls to the phone', () => {
  it('the iPhone app handles every method the backend sends its host', () => {
    const backend = ['desktop/src/main/headless/electron-headless.ts', 'desktop/src/main/headless/host-bridge.ts', 'desktop/src/main/headless/headless-boot.ts']
      .map((f) => read(f)).join('\n');
    const sent = new Set([...backend.matchAll(/host(?:Call|Notify)(?:<[^>]*>)?\('([A-Za-z]+)'/g)].map((m) => m[1]));
    const root = swift('RootViewController.swift');
    const start = root.indexOf('private func handleHostCall(');
    const handled = new Set([...root.slice(start, root.indexOf('private func openLink', start)).matchAll(/case "([A-Za-z]+)":/g)].map((m) => m[1]));
    expect(sent.size).toBeGreaterThan(4);
    expect([...sent].filter((m) => !handled.has(m))).toEqual([]);
  });

  it('the app starts the backend with the entry, the environment names and the ready line the backend uses', () => {
    const runner = swift('BackendRunner.swift');
    // The app starts the small loader, which the build writes and which loads the real bundle inside a try.
    expect(runner).toContain('dist/main/headless/ios-boot.js');
    const build = read('ios/runtime/build-backend.mjs');
    expect(build).toContain("dist/main/headless/ios-boot.js");
    expect(build).toContain("require('./ios-main.js')");
    for (const name of ['YOUCODED_HEADLESS_PORT', 'YOUCODED_SECRETS_ON_STDIN', 'YOUCODED_USER_DATA', 'YOUCODED_HOST_SOCKET', 'YOUCODED_HOST_TOKEN', 'YOUCODED_HOST_OS', 'YOUCODED_APP_VERSION']) {
      expect(runner).toContain(`"${name}"`);
    }
    const backend = read('desktop/src/main/headless/headless-main.ts') + read('desktop/src/main/headless/headless-boot.ts')
      + read('desktop/src/main/headless/host-bridge.ts') + read('desktop/src/main/headless/electron-headless.ts');
    for (const name of ['YOUCODED_HEADLESS_PORT', 'YOUCODED_SECRETS_ON_STDIN', 'YOUCODED_USER_DATA', 'YOUCODED_HOST_SOCKET', 'YOUCODED_HOST_TOKEN', 'YOUCODED_HOST_OS', 'YOUCODED_APP_VERSION']) {
      expect(backend).toContain(name);
    }
    expect(runner).toContain('YOUCODED_HEADLESS_READY');
    expect(read('desktop/src/main/headless/headless-boot.ts')).toContain('YOUCODED_HEADLESS_READY');
    // The line the backend prints instead of exiting (an exit would end the whole app).
    expect(runner).toContain('YOUCODED_HEADLESS_EXIT');
    expect(read('desktop/src/main/headless/ios-compat.ts')).toContain('YOUCODED_HEADLESS_EXIT');
  });
});

describe('the page\'s private address', () => {
  it('is the same in the page, the backend\'s origin check and the Swift shell', () => {
    const web = swift('AppWebView.swift');
    const scheme = /static let pageScheme = "([^"]+)"/.exec(web)?.[1];
    const host = /static let pageHost = "([^"]+)"/.exec(web)?.[1];
    expect(`${scheme}://${host}`).toBe(IOS_PAGE_ORIGIN);
    expect(isAllowedWsOrigin(IOS_PAGE_ORIGIN, '127.0.0.1:9901')).toBe(true);
    expect(isAllowedWsOrigin('youcoded-app://evil', '127.0.0.1:9901')).toBe(false);
    expect(IOS_PAGE_ORIGIN).not.toBe(ANDROID_PAGE_ORIGIN);
  });
});

describe('what an iPhone can do', () => {
  it('the iPhone set answers every question the other sets answer', () => {
    expect(Object.keys(IOS_LOCAL_CAPABILITIES).sort()).toEqual(Object.keys(DESKTOP_WINDOW_CAPABILITIES).sort());
    expect(normalizeCapabilities({ ...IOS_LOCAL_CAPABILITIES })).toEqual(IOS_LOCAL_CAPABILITIES);
  });

  it('only the iPhone cannot start programs, and a host that says nothing can (it is older than the iPhone app)', () => {
    expect(IOS_LOCAL_CAPABILITIES.programs).toBe(false);
    expect([DESKTOP_WINDOW_CAPABILITIES.programs, ANDROID_LOCAL_CAPABILITIES.programs, REMOTE_SCREEN_CAPABILITIES.programs]).toEqual([true, true, true]);
    expect(normalizeCapabilities({}).programs).toBe(true);
    expect(normalizeCapabilities({ programs: false }).programs).toBe(false);
  });

  it('nothing that needs a program is on: no git, no terminal to read, no ripgrep search box', () => {
    expect([IOS_LOCAL_CAPABILITIES.git, IOS_LOCAL_CAPABILITIES.terminalScreenRead, IOS_LOCAL_CAPABILITIES.contentSearch]).toEqual([false, false, false]);
    expect(IOS_LOCAL_CAPABILITIES.nativeSessions).toBe(true);
  });
});

describe('the backend bundle the app carries', () => {
  it('builds every worker thread the headless backend starts', () => {
    // Read from the build script's text (it lives outside this TypeScript project, so it cannot be imported here).
    const build = read('ios/runtime/build-backend.mjs');
    const block = build.slice(build.indexOf('export const WORKER_ENTRIES = ['), build.indexOf('];', build.indexOf('export const WORKER_ENTRIES = [')));
    const WORKER_ENTRIES = [...block.matchAll(/'([^']+\.ts)'/g)].map((m) => m[1]);
    const srcMain = path.join(repo, 'desktop/src/main');
    const starters: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) {
          for (const m of fs.readFileSync(p, 'utf8').matchAll(/new Worker\(path\.join\(__dirname, '([^']+)\.js'\)/g)) {
            starters.push(path.relative(path.join(repo, 'desktop/src'), path.join(path.dirname(p), `${m[1]}.ts`)).split(path.sep).join('/'));
          }
          // image-resize-service names its worker through a helper.
          for (const m of fs.readFileSync(p, 'utf8').matchAll(/path\.join\(__dirname, '([a-z-]+-worker)\.js'\)/g)) {
            starters.push(path.relative(path.join(repo, 'desktop/src'), path.join(path.dirname(p), `${m[1]}.ts`)).split(path.sep).join('/'));
          }
        }
      }
    };
    walk(srcMain);
    // Desktop-only workers the headless backend never starts (no PTY, no voice engine, no browser on a phone).
    const notOnPhones = new Set(['main/pty-worker.ts', 'main/voice/voice-worker.ts']);
    const wanted = [...new Set(starters)].filter((s) => !notOnPhones.has(s)).sort();
    expect(wanted.length).toBeGreaterThan(1);
    expect([...WORKER_ENTRIES].sort()).toEqual(wanted);
    for (const entry of WORKER_ENTRIES) expect(fs.existsSync(path.join(repo, 'desktop/src', entry))).toBe(true);
  });

  it('pins Node for iOS by checksum', () => {
    const pins = read('ios/runtime/pins.env');
    expect(pins).toMatch(/^NODEJS_MOBILE_SHA256=[0-9a-f]{64}$/m);
    expect(read('ios/runtime/fetch-node.sh')).toContain('NODEJS_MOBILE_SHA256');
  });
});
