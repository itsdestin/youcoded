import { describe, it, expect } from 'vitest';
import {
  classifyBuffer,
  ClassifierContext,
} from '../src/renderer/state/attention-classifier';

function ctx(lines: string[], overrides: Partial<ClassifierContext> = {}): ClassifierContext {
  return {
    bufferTail: lines,
    previousSpinnerSeconds: null,
    secondsSincePreviousSpinner: 0,
    ...overrides,
  };
}

describe('classifyBuffer', () => {
  it('empty buffer → unknown', () => {
    expect(classifyBuffer(ctx([])).class).toBe('unknown');
  });

  it('recognizes the Claude spinner with seconds counter (first tick → active)', () => {
    const result = classifyBuffer(ctx(['', '✻ Pondering… (7s · esc to interrupt)', '']));
    expect(result.class).toBe('thinking-active');
    expect(result.spinnerSeconds).toBe(7);
  });

  it('spinner counter advancing between ticks → active', () => {
    const result = classifyBuffer(
      ctx(['⏺ Cogitating… (12s · esc to interrupt)'], {
        previousSpinnerSeconds: 9,
        secondsSincePreviousSpinner: 3,
      }),
    );
    expect(result.class).toBe('thinking-active');
    expect(result.spinnerSeconds).toBe(12);
  });

  it('spinner counter flat for >=10s between ticks → stalled', () => {
    const result = classifyBuffer(
      ctx(['⏺ Cogitating… (12s · esc to interrupt)'], {
        previousSpinnerSeconds: 12,
        secondsSincePreviousSpinner: 11,
      }),
    );
    expect(result.class).toBe('thinking-stalled');
  });

  it('spinner counter flat for <10s → still active (brief pause is normal)', () => {
    const result = classifyBuffer(
      ctx(['⏺ Cogitating… (12s · esc to interrupt)'], {
        previousSpinnerSeconds: 12,
        secondsSincePreviousSpinner: 3,
      }),
    );
    expect(result.class).toBe('thinking-active');
  });

  it('y/n prompt in tail → awaiting-input', () => {
    expect(
      classifyBuffer(ctx(['Do you want to continue? (y/n)'])).class,
    ).toBe('awaiting-input');
  });

  it('[y/n] bracketed prompt → awaiting-input', () => {
    expect(classifyBuffer(ctx(['Proceed [y/N]'])).class).toBe('awaiting-input');
  });

  it('numbered choice menu (1./2.) → awaiting-input', () => {
    expect(
      classifyBuffer(
        ctx(['Choose an option:', '  1. First', '  2. Second', '  3. Third']),
      ).class,
    ).toBe('awaiting-input');
  });

  it('shell prompt at tail with no spinner → shell-idle', () => {
    expect(classifyBuffer(ctx(['user@host ~ $ '])).class).toBe('shell-idle');
    expect(classifyBuffer(ctx(['~/project $'])).class).toBe('shell-idle');
  });

  it('error line near tail → error', () => {
    expect(
      classifyBuffer(ctx(['something', 'Error: ENOENT: file not found', ''])).class,
    ).toBe('error');
    expect(
      classifyBuffer(ctx(['Traceback: at main.py:42'])).class,
    ).toBe('error');
  });

  it('plain noise → unknown', () => {
    expect(
      classifyBuffer(ctx(['hello world', 'some random output'])).class,
    ).toBe('unknown');
  });

  it('sequential spinner advances — multiple ticks remain active', () => {
    let prev: number | null = null;
    const readings = [5, 8, 12, 15];
    for (const sec of readings) {
      const result = classifyBuffer(
        ctx([`⏺ Pondering… (${sec}s · esc to interrupt)`], {
          previousSpinnerSeconds: prev,
          secondsSincePreviousSpinner: 1,
        }),
      );
      expect(result.class).toBe('thinking-active');
      prev = result.spinnerSeconds;
    }
  });
});
