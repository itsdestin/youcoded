import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { timeSessionSetup } from '../src/main/session-setup-timing';
import { log } from '../src/main/logger';
vi.mock('../src/main/logger', () => ({ log: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('session setup timings', () => {
  it('records a slow stage without logging its result or error contents', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(2610);
    await expect(timeSessionSetup('native-profile', async () => 'private value')).resolves.toBe('private value');
    expect(log).toHaveBeenCalledWith('INFO', 'SessionSetup', 'slow setup stage', {
      stage: 'native-profile', durationMs: 2600, outcome: 'ok',
    });
  });
  it('preserves the original error and reports only failure timing', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(1).mockReturnValueOnce(501);
    const error = new Error('private credential detail');
    await expect(timeSessionSetup('native-mcp', async () => { throw error; })).rejects.toBe(error);
    expect(log).toHaveBeenCalledWith('INFO', 'SessionSetup', 'slow setup stage', {
      stage: 'native-mcp', durationMs: 500, outcome: 'failed',
    });
  });
  it('does not log ordinary fast setup', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(1).mockReturnValueOnce(20);
    await timeSessionSetup('native-skills', async () => []);
    expect(log).not.toHaveBeenCalled();
  });
});
