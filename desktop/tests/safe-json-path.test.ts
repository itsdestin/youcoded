import { describe, it, expect } from 'vitest';
import { getJsonPath, setJsonPath } from '../src/main/safe-json-path';

describe('setJsonPath — prototype pollution guard (2026-09-10 security review)', () => {
  it('writes a nested field without clobbering siblings', () => {
    const obj: Record<string, unknown> = { permissions: { defaultMode: 'ask', other: 1 } };
    setJsonPath(obj, 'permissions.defaultMode', 'plan');
    expect(obj).toEqual({ permissions: { defaultMode: 'plan', other: 1 } });
  });

  it('creates missing intermediate objects', () => {
    const obj: Record<string, unknown> = {};
    setJsonPath(obj, 'a.b.c', 42);
    expect(obj).toEqual({ a: { b: { c: 42 } } });
  });

  it('deletes the leaf when value is null or undefined', () => {
    const obj: Record<string, unknown> = { a: { b: 1, c: 2 } };
    setJsonPath(obj, 'a.b', null);
    expect(obj).toEqual({ a: { c: 2 } });
  });

  it.each(['__proto__.polluted', '__proto__', 'constructor.prototype.x', 'a.__proto__.x', 'a.constructor.y', 'a..b', ''])(
    'refuses %j and pollutes nothing',
    (field) => {
      const obj: Record<string, unknown> = {};
      expect(() => setJsonPath(obj, field, 'yes')).toThrow();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(({} as Record<string, unknown>).x).toBeUndefined();
      expect(({} as Record<string, unknown>).y).toBeUndefined();
    },
  );

  it('the exact payload the review reproduced does not reach Object.prototype', () => {
    setJsonPath.bind(null, {} as Record<string, unknown>, '__proto__.polluted', 'yes');
    try { setJsonPath({}, '__proto__.polluted', 'yes'); } catch { /* expected */ }
    expect(({}) as Record<string, unknown>).not.toHaveProperty('polluted');
  });

  it('walks into an existing array instead of clobbering it (2026-09-11 review)', () => {
    const obj: Record<string, unknown> = { permissions: { allow: ['Bash(npm:*)', 'Read(*)'] } };
    setJsonPath(obj, 'permissions.allow.0', 'Bash(rm:*)');
    // the array survives as an array with the one element replaced
    expect((obj.permissions as any).allow).toEqual(['Bash(rm:*)', 'Read(*)']);
    expect(Array.isArray((obj.permissions as any).allow)).toBe(true);
  });

  it('reads a value nested under an array', () => {
    expect(getJsonPath({ a: { list: [{ x: 1 }, { x: 2 }] } }, 'a.list.1.x')).toBe(2);
  });

  it('overwrites a non-object step rather than walking into it', () => {
    const obj: Record<string, unknown> = { a: 5 };
    setJsonPath(obj, 'a.b', 1);
    expect(obj).toEqual({ a: { b: 1 } });
  });
});

describe('getJsonPath', () => {
  it('reads a nested own field', () => {
    expect(getJsonPath({ a: { b: 7 } }, 'a.b')).toBe(7);
  });

  it('returns undefined for a missing path', () => {
    expect(getJsonPath({ a: {} }, 'a.b.c')).toBeUndefined();
  });

  it('never returns an inherited property (no __proto__ leak)', () => {
    expect(() => getJsonPath({}, '__proto__')).toThrow();
    expect(getJsonPath({ a: {} }, 'a.toString')).toBeUndefined();
  });
});
