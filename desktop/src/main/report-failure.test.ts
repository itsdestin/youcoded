import { describe, it, expect, vi, beforeEach } from 'vitest';

// WHY mocked: the real logger appends to ~/.claude/desktop.log, which a test must never touch.
const log = vi.fn();
vi.mock('./logger', () => ({ log: (...a: unknown[]) => log(...a) }));
import { reportFailure, resetFailureDedupeForTests } from './report-failure';

beforeEach(() => { log.mockClear(); resetFailureDedupeForTests(); });

describe('main reportFailure', () => {
  it('writes the real cause to the log', () => {
    reportFailure({ what: 'check the model list', cause: new Error('ENETDOWN'), where: 'naming' });
    expect(log).toHaveBeenCalledWith('WARN', 'naming', "couldn't check the model list", { cause: 'ENETDOWN' });
  });
  it('writes nothing invented when there is no cause, and merges repeats', () => {
    reportFailure({ what: 'a', where: 'w' });
    reportFailure({ what: 'a', where: 'w' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('WARN', 'w', "couldn't a", undefined);
  });
});
