// hook-scripts-android-parity.test.ts — the hook scripts Android ships are the
// desktop's, byte for byte.
//
// WHY: desktop/hook-scripts/ and app/src/main/assets/ each carry a copy of the
// same four shell scripts with no copy step between them, so a fix that lands
// on one platform can silently leave the other still doing the old thing.
// Before this test only statusline.sh was pinned (statusline-rate-limits.test.ts,
// where the legal invariant lives); the other three drifted unguarded
// (simplification audit D13, 2026-09-16).
//
// NOT covered on purpose: relay.js / relay-blocking.js. Android ships them as
// hook-relay.js / hook-relay-blocking.js and they legitimately differ.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const HOOK_SCRIPTS = path.resolve(__dirname, '..', 'hook-scripts');
const ANDROID_ASSETS = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets');

// Relative to BOTH roots — the layout is the same on each side.
const SHARED_SCRIPTS = [
  'write-guard.sh',
  'statusline.sh',
  'title-update.sh',
  path.join('lib', 'hook-preamble.sh'),
];

describe('hook scripts are byte-identical between desktop and Android', () => {
  for (const rel of SHARED_SCRIPTS) {
    it(`${rel} is the same file on both platforms`, () => {
      const desktop = fs.readFileSync(path.join(HOOK_SCRIPTS, rel));
      const android = fs.readFileSync(path.join(ANDROID_ASSETS, rel));
      // Buffer equality: a CRLF/LF or trailing-newline drift is a real drift
      // for a shell script, so no normalization here.
      expect(android.equals(desktop), `${rel} differs between desktop/hook-scripts and app/src/main/assets`).toBe(true);
    });
  }
});
