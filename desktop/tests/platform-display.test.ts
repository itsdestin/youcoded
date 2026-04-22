import { describe, test, expect } from 'vitest';
import { platformDisplayName, platformListDisplay } from '../src/shared/platform-display';

describe('platformDisplayName', () => {
  test('maps known codes to display names', () => {
    expect(platformDisplayName('darwin')).toBe('macOS');
    expect(platformDisplayName('win32')).toBe('Windows');
    expect(platformDisplayName('linux')).toBe('Linux');
    expect(platformDisplayName('android')).toBe('Android');
  });

  test('returns input unchanged for unknown codes', () => {
    expect(platformDisplayName('beos')).toBe('beos');
    expect(platformDisplayName('')).toBe('');
  });
});

describe('platformListDisplay', () => {
  test('returns empty string for empty input', () => {
    expect(platformListDisplay([])).toBe('');
  });

  test('returns single name for one-element list', () => {
    expect(platformListDisplay(['darwin'])).toBe('macOS');
  });

  test('joins two names with "or"', () => {
    expect(platformListDisplay(['darwin', 'linux'])).toBe('macOS or Linux');
  });

  test('joins three names with commas and oxford "or"', () => {
    expect(platformListDisplay(['darwin', 'linux', 'win32'])).toBe('macOS, Linux, or Windows');
  });

  test('passes unknown codes through unchanged', () => {
    expect(platformListDisplay(['darwin', 'beos'])).toBe('macOS or beos');
  });
});
