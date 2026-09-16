// Remote access batch 3 decision (design §10, contract R20), pinned here (T9):
// a web page preview runs in a sealed box. Without `allow-same-origin` the
// frame has an opaque origin, so nothing a file contains can reach the app's
// storage, cookies or bridge — on the desktop and on a phone alike. Adding
// that token would open a second origin the design decided against.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readStripped, assertPatternMatches } from './helpers/guard-scope';

const src = readStripped(join(__dirname, '..', 'src', 'renderer', 'components', 'artifact-views', 'HtmlView.tsx'));

describe('HtmlView previews are sealed', () => {
  it('the sandbox attribute never gains allow-same-origin', () => {
    const attr = /sandbox="([^"]*)"/g;
    assertPatternMatches(attr, 'sandbox="allow-scripts allow-popups allow-forms"', 'an iframe sandbox attribute');
    const values = [...src.matchAll(attr)].map((m) => m[1]);
    expect(values.length).toBeGreaterThanOrEqual(1);
    for (const v of values) {
      expect(v.split(/\s+/)).toContain('allow-scripts');          // known-positive: scripts are allowed
      expect(v.split(/\s+/)).not.toContain('allow-same-origin');
    }
  });
});
