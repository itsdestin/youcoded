import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { scanSource, scanDir, compare, BASELINE_PATH } from '../scripts/silent-catch-check.mjs';

// R-1 (Destin H-2/H-6): a NEW place that catches a failure and says nothing fails here unless a
// one-line "// benign: <reason>" sits beside it. Existing ones are on a frozen list that may only shrink.
describe('silent-catch detector', () => {
  const n = (src: string) => scanSource(src, 'x.ts').length;
  it('flags empty catches and do-nothing .catch handlers', () => {
    expect(n('function a(){ try { f() } catch {} }')).toBe(1);
    expect(n('function a(){ try { f() } catch (e) { /* ignore */ } }')).toBe(1);
    expect(n('const a = () => p.catch(() => {});')).toBe(1);
    expect(n('const a = () => p.catch(() => null);')).toBe(1);
    expect(n('const a = () => p.catch(() => []);')).toBe(1);
    expect(n('const a = () => p.catch((e) => false);')).toBe(1);
  });
  it('lets a catch through that does something, or carries a written reason', () => {
    expect(n('function a(){ try { f() } catch (e) { log(e) } }')).toBe(0);
    expect(n('const a = () => p.catch((e) => report(e));')).toBe(0);
    expect(n('function a(){\n // benign: the file may already be gone\n try { f() } catch {}\n}')).toBe(0);
    expect(n('const a = () => p.catch(() => {}); // benign: window already closing')).toBe(0);
    // an empty reason does not count
    expect(n('function a(){\n // benign:\n try { f() } catch {}\n}')).toBe(1);
  });
  it('names the enclosing function, not a line number', () => {
    expect(scanSource('const save = async () => { try { f() } catch {} }', 'x.ts')[0].fn).toBe('save');
    expect(scanSource('class A { run() { try { f() } catch {} } }', 'x.ts')[0].fn).toBe('run');
  });
});

describe('frozen list', () => {
  it('a new swallow fails, and a fixed one forces the list to shrink', () => {
    const base = { 'a.ts': { save: 1 } };
    expect(compare({ 'a.ts': { save: 2 } }, base)[0]).toMatch(/NEW silent catch in a\.ts \(save\)/);
    expect(compare({ 'b.ts': { go: 1 } }, base).join('\n')).toMatch(/NEW silent catch in b\.ts/);
    expect(compare({}, base)[0]).toMatch(/STALE list/);
    expect(compare({ 'a.ts': { save: 1 } }, base)).toEqual([]);
  });
  it('the real source matches the frozen list exactly', () => {
    const src = path.join(__dirname, '..', 'src');
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    expect(compare(scanDir(src), baseline)).toEqual([]);
  });
});
