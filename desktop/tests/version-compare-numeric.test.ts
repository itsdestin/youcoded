import { describe, expect, it } from 'vitest';
import { isNewerVersion } from '../src/shared/version-compare';

// WHY: crossing a digit boundary catches accidental lexical comparison that
// single-digit version examples cannot distinguish from numeric ordering.
describe('numeric version component ordering', () => {
  it.each([
    ['1.9.0', '1.10.0', true],
    ['1.10.0', '1.9.0', false],
    ['9.99.99', '10.0.0', true],
    ['10.0.0', '9.99.99', false],
  ])('compares %s with %s as newer=%s', (installed, latest, expected) => {
    expect(isNewerVersion(installed, latest)).toBe(expected);
  });
});
