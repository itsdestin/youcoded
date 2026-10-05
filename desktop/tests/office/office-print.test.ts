import { describe, expect, it } from 'vitest';
import { classifyPrintResult } from '../../src/main/office/office-print';

// What Electron's webContents.print answers, as measured on Linux (office-print.ts).
describe('classifyPrintResult', () => {
  it('reads a sent job, a closed dialog, and a machine with no printing service', () => {
    expect(classifyPrintResult(true, '')).toBe('printed');
    expect(classifyPrintResult(false, 'Print job canceled')).toBe('cancelled');
    expect(classifyPrintResult(false, 'cancelled')).toBe('cancelled');
    expect(classifyPrintResult(false, 'Failed to enumerate printers')).toEqual({ failed: 'no-printer' });
    expect(classifyPrintResult(false, 'Failed to get default printer name')).toEqual({ failed: 'no-printer' });
  });
  it('treats anything else as a failure it does not guess the cause of', () => {
    expect(classifyPrintResult(false, 'Print job failed')).toEqual({ failed: 'other' });
    expect(classifyPrintResult(false, '')).toEqual({ failed: 'other' });
  });
});
