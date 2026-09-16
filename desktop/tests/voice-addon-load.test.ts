// Loading the downloaded speech engine — and, when it will not load, saying why.
//
// The speech engine is not part of this app's install. It is fetched at first use
// into the user's own data folder, so the app has to reach for a compiled library
// sitting at a plain absolute path, with no `node_modules` anywhere in sight.
// That is unusual enough to be worth pinning, and it has one failure mode that
// really matters to a user:
//
//   sherpa-onnx's own loader catches a library that will not open, throws the
//   operating system's actual explanation away, and prints advice about setting
//   LD_LIBRARY_PATH — advice that is simply wrong for how we install it. A user
//   whose download was cut short, or whose Linux is a little too old, would be
//   sent to fix an environment variable that has nothing to do with it.
//
// So voice-worker.ts opens the compiled library ITSELF, first, and passes whatever
// the operating system said straight through. These tests build a FAKE engine —
// a file that is not a real library, and a JavaScript half whose neighbour is
// missing — in a throwaway folder, and check that the real words come out. sherpa
// is never downloaded, installed, or imported here.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { loadSherpa } from '../src/main/voice/voice-worker';
import { addonPath, wrapperEntryPath } from '../src/main/voice/voice-pin';

let userData = '';

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-voice-addon-'));
  fs.mkdirSync(path.dirname(addonPath(userData)), { recursive: true });
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3 });
});

/** Walk up from a folder listing any `node_modules` on the way to the root. */
function nodeModulesAbove(dir: string): string[] {
  const found: string[] = [];
  let at = dir;
  for (;;) {
    const candidate = path.join(at, 'node_modules');
    if (fs.existsSync(candidate)) found.push(candidate);
    const up = path.dirname(at);
    if (up === at) return found;
    at = up;
  }
}

describe('where the engine is looked for', () => {
  it('is exactly where voice-pin says, and nowhere near a node_modules folder', () => {
    // The point of the whole design: the engine lives in the user's data folder,
    // not in the app's dependencies. If a `node_modules` were reachable from
    // here, a passing test would prove nothing — Node might have found a
    // real sherpa install instead of the fake one under test.
    expect(nodeModulesAbove(userData)).toEqual([]);
    expect(addonPath(userData)).toBe(
      path.join(userData, 'voice', 'runtime', 'package', 'sherpa-onnx.node'),
    );
    expect(wrapperEntryPath(userData)).toBe(
      path.join(userData, 'voice', 'runtime', 'package', 'sherpa-onnx.js'),
    );
  });
});

describe('when the compiled library will not open', () => {
  it('passes the operating system\'s own explanation through, word for word', () => {
    // A file that is not a real compiled library — exactly what a download cut
    // short leaves behind.
    fs.writeFileSync(addonPath(userData), 'this is not a compiled library\n');

    // What Node itself says about this file, captured independently so the test
    // is checking forwarding rather than repeating a sentence we made up.
    let realReason = '';
    try {
      createRequire(addonPath(userData))(addonPath(userData));
    } catch (err) {
      realReason = (err as Error).message;
    }
    expect(realReason).not.toBe('');

    expect(() => loadSherpa(userData)).toThrow(realReason);
  });

  it('names the exact file it tried, and offers no advice it cannot stand behind', () => {
    fs.writeFileSync(addonPath(userData), 'this is not a compiled library\n');
    let message = '';
    try {
      loadSherpa(userData);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(addonPath(userData));
    // The sentence sherpa's own loader would have printed instead. Its presence
    // here would mean we had fallen back into the loader we bypassed.
    expect(message).not.toContain('LD_LIBRARY_PATH');
  });

  it('says the file is missing when it is missing, rather than guessing', () => {
    let message = '';
    try {
      loadSherpa(userData);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('Cannot find module');
    expect(message).toContain(addonPath(userData));
  });
});

describe('when the JavaScript half is broken', () => {
  it('reports the missing neighbour it actually failed on', () => {
    // The compiled library opens fine; its JavaScript half reaches for a file
    // that is not there. (The compiled half is stubbed rather than built for
    // real: a genuine 20 MB native library has no business in a test suite, and
    // what is being checked is our error handling, not sherpa's.)
    fs.writeFileSync(
      wrapperEntryPath(userData),
      "module.exports = require('./a-file-that-was-never-unpacked');\n",
    );
    const realRequire = createRequire(addonPath(userData));
    const req = (p: string) => (p.endsWith('.node') ? {} : realRequire(p));

    let message = '';
    try {
      loadSherpa(userData, req);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(wrapperEntryPath(userData));
    expect(message).toContain('a-file-that-was-never-unpacked');
  });
});

describe('when both halves are there', () => {
  it('hands back whatever the JavaScript half exports', () => {
    fs.writeFileSync(
      wrapperEntryPath(userData),
      'module.exports = { OfflineRecognizer: { createAsync: async () => ({}) } };\n',
    );
    const realRequire = createRequire(addonPath(userData));
    const req = (p: string) => (p.endsWith('.node') ? {} : realRequire(p));

    const sherpa = loadSherpa(userData, req);
    expect(typeof sherpa.OfflineRecognizer.createAsync).toBe('function');
  });
});
