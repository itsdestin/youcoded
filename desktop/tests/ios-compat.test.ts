// The fills that let the backend run on the Node an iPhone has (src/main/headless/ios-compat.ts): Node 18, no JIT,
// and no Unicode data library. Each is tested where it can be FORCED on, on the Node the tests run on, against that
// Node's own real behaviour.
import { describe, it, expect, afterEach } from 'vitest';
import { rewriteUnicodeProperties, installRegExpPropertyFallback, unicodePropertiesWork, installIosCompat, type UnicodeTables } from '../src/main/headless/ios-compat';

/** The same table the build makes (ios/runtime/build-backend.mjs → unicodeTable), from this Node's own Unicode data. */
function table(name: string): string {
  const re = new RegExp(`\\p{${name}}`, 'u');
  const esc = (cp: number) => `\\u{${cp.toString(16).toUpperCase()}}`;
  let body = '';
  let start = -1;
  for (let cp = 0; cp <= 0x110000; cp++) {
    const hit = cp <= 0x10FFFF && !(cp >= 0xD800 && cp <= 0xDFFF) && re.test(String.fromCodePoint(cp));
    if (hit && start < 0) start = cp;
    if (!hit && start >= 0) { body += start === cp - 1 ? esc(start) : `${esc(start)}-${esc(cp - 1)}`; start = -1; }
  }
  return body;
}
const TABLES: UnicodeTables = { Cc: table('Cc'), Extended_Pictographic: table('Extended_Pictographic'), Emoji_Component: table('Emoji_Component'), Regional_Indicator: table('Regional_Indicator') };
const NativeRegExp = RegExp;

afterEach(() => {
  (globalThis as unknown as { RegExp: RegExpConstructor }).RegExp = NativeRegExp;
  Object.defineProperty(NativeRegExp.prototype, 'constructor', { value: NativeRegExp, writable: true, configurable: true });
  delete (NativeRegExp as unknown as { __ycPatched?: boolean }).__ycPatched;
});

describe('Unicode property escapes without the Unicode data library', () => {
  // The exact expressions the bundled libraries build while they load.
  const patterns: Array<[string, string]> = [
    ['^(?=[\\s\\S]*[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\u20E3])[\\p{Extended_Pictographic}\\p{Emoji_Component}]+$', 'u'],
    ['\\p{Extended_Pictographic}', 'u'],
    ['^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$', 'u'],
    ['["\\\\\\p{Cc}]', 'gu'],
    ['\\p{Cc}', 'u'],
    ['\\P{Cc}+', 'u'],
  ];
  const samples = ['', 'a', 'hello world', '😀', '👍🏽', '🇺🇸', '1️⃣', 'tab\there', 'bell\u0007', 'quote"and\\slash', 'é', '日本語', '\u009F', 'a😀b', '©', '#'];

  it('a rewritten expression matches exactly what the original matches', () => {
    for (const [source, flags] of patterns) {
      const rewritten = rewriteUnicodeProperties(source, TABLES);
      expect(rewritten).not.toMatch(/\\[pP]\{/);
      for (const s of samples) {
        const want = [...s.matchAll(new NativeRegExp(source, flags.includes('g') ? flags : flags + 'g'))].map((m) => [m.index, m[0]]);
        const got = [...s.matchAll(new NativeRegExp(rewritten, flags.includes('g') ? flags : flags + 'g'))].map((m) => [m.index, m[0]]);
        expect(got, `${source} on ${JSON.stringify(s)}`).toEqual(want);
      }
    }
  });

  it('leaves alone what it must: no property, an escaped backslash before "p{", a name it has no table for', () => {
    expect(rewriteUnicodeProperties('a+b*\\d', TABLES)).toBe('a+b*\\d');
    expect(rewriteUnicodeProperties('\\\\p{Cc}', TABLES)).toBe('\\\\p{Cc}'); // a literal backslash, then "p{Cc}"
    expect(rewriteUnicodeProperties('\\p{Script=Greek}', TABLES)).toBe('\\p{Script=Greek}');
    // "Not this property" inside another class has no plain spelling: left for the engine to refuse loudly.
    expect(rewriteUnicodeProperties('[a\\P{Cc}]', TABLES)).toBe('[a\\P{Cc}]');
  });

  it('once installed, new RegExp(...) accepts the expression and everything else about RegExp is unchanged', () => {
    installRegExpPropertyFallback(TABLES, true);
    expect(RegExp).not.toBe(NativeRegExp);
    const re = new RegExp('^\\p{Extended_Pictographic}+$', 'u');
    expect(re.source).not.toContain('\\p{');
    expect([re.test('😀😀'), re.test('abc')]).toEqual([true, false]);
    expect(re instanceof RegExp).toBe(true);
    expect(/literal/ instanceof RegExp).toBe(true);
    expect(/literal/.constructor).toBe(RegExp);
    expect(RegExp('a', 'g').flags).toBe('g'); // called without `new`
    expect(new RegExp(/x/gi).flags).toBe('gi'); // from another expression
    expect('a-b-c'.split(new RegExp('-'))).toEqual(['a', 'b', 'c']);
    expect('aXbXc'.replace(new RegExp('x', 'gi'), '-')).toBe('a-b-c');
    class Sub extends RegExp {}
    expect(new Sub('\\p{Cc}', 'u') instanceof Sub).toBe(true);
    expect(() => new RegExp('(')).toThrow(SyntaxError);
  });

  it('does nothing on a Node that already understands them', () => {
    expect(unicodePropertiesWork()).toBe(true);
    installRegExpPropertyFallback(TABLES);
    expect(RegExp).toBe(NativeRegExp);
  });
});

describe('the other fills', () => {
  it('installing everything on a current Node changes nothing it already has', () => {
    const before = { fetch: globalThis.fetch, crypto: globalThis.crypto, any: AbortSignal.any, toSorted: Array.prototype.toSorted };
    installIosCompat();
    expect(globalThis.fetch).toBe(before.fetch);
    expect(globalThis.crypto).toBe(before.crypto);
    expect(AbortSignal.any).toBe(before.any);
    expect(Array.prototype.toSorted).toBe(before.toSorted);
    expect(RegExp).toBe(NativeRegExp);
  });
});
