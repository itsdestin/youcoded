import { describe, it, expect } from 'vitest';
import { formatBytes, formatGb, formatGbNumber, formatMbWhole } from '../src/shared/format-bytes';

// Card #143: sizes count 1000, like Hugging Face and the computer's own file manager.
describe('formatBytes (1000-based)', () => {
  it('counts a thousand, not 1024', () => {
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1000)).toBe('1.0 KB');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1_000_000)).toBe('1.0 MB');
    expect(formatBytes(1_048_576)).toBe('1.0 MB');
    expect(formatBytes(1_000_000_000)).toBe('1.0 GB');
  });
  it('the Hugging Face number: 79.7 GB on the page is 79.7 GB here', () => {
    expect(formatGb(79_700_000_000)).toBe('79.7 GB');
    expect(formatGbNumber(79_700_000_000)).toBe('79.7');
  });
  it('rolls a near-1000 value into the next unit instead of "1000.0 KB"', () => {
    expect(formatBytes(999_960)).toBe('1.0 MB');
    expect(formatBytes(999_960_000)).toBe('1.0 GB');
  });
  it('options keep each screen\'s look', () => {
    expect(formatBytes(12_340, { kbDecimals: 0 })).toBe('12 KB');
    expect(formatBytes(10_000_000, { trimZero: true })).toBe('10 MB');
    expect(formatBytes(24_300_000, { trimZero: true })).toBe('24.3 MB');
    expect(formatBytes(4_000, { compact: true })).toBe('4.0KB');
  });
  it('bad numbers say nothing', () => {
    expect(formatBytes(NaN)).toBe('');
    expect(formatBytes(-1)).toBe('');
  });
  it('whole megabytes', () => { expect(formatMbWhole(412_400_000)).toBe('412 MB'); });
});
