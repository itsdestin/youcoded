// The queue runtime is wired once for desktop and the Android-shared backend: it must receive the screen
// reader's reason for refusing (Send now's note), not only its yes/no.
import { describe, it, expect, vi } from 'vitest';
const made: Record<string, unknown>[] = [];
vi.mock('../src/main/claude-queue-runtime', () => ({ ClaudeQueueRuntime: class { constructor(options: Record<string, unknown>) { made.push(options); } } }));
import { wireClaudeQueues } from '../src/main/claude-queue-wiring';

describe('claude queue wiring', () => {
  it('hands the runtime both the screen check and the reason it refuses', () => {
    const screens = { queueInputSafe: vi.fn(() => false), queueInputBlock: vi.fn(() => 'question'), waitForQueueInputSafe: vi.fn() };
    const manager = { claudeBridgeForQueues: () => ({}) };
    wireClaudeQueues(manager as never, { facts: () => null, noteSend: vi.fn() } as never, screens as never, vi.fn() as never, () => '/tmp');
    const options = made.at(-1) as { inputSafe(id: string): boolean; inputBlock?(id: string): unknown };
    expect(options.inputSafe('s')).toBe(false);
    expect(options.inputBlock?.('s')).toBe('question');
    expect(screens.queueInputBlock).toHaveBeenCalledWith('s');
  });
});
