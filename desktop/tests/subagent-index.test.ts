import { describe, it, expect, beforeEach } from 'vitest';
import { SubagentIndex } from '../src/main/subagent-index';

describe('SubagentIndex', () => {
  let idx: SubagentIndex;

  beforeEach(() => {
    idx = new SubagentIndex({ nowMs: () => 1000 });
  });

  it('binds a subagent to the most recent matching parent', () => {
    idx.recordParentAgentToolUse('toolu_A', 'Find bug', 'Explore');
    const bound = idx.bindSubagent('agent1', { description: 'Find bug', agentType: 'Explore' });
    expect(bound).toBe('toolu_A');
    expect(idx.lookup('agent1')).toBe('toolu_A');
  });

  it('returns null when no parent matches', () => {
    const bound = idx.bindSubagent('agent1', { description: 'Find bug', agentType: 'Explore' });
    expect(bound).toBeNull();
    expect(idx.lookup('agent1')).toBeNull();
  });

  it('FIFO: two parallel parents with identical description bind in emit order', () => {
    idx.recordParentAgentToolUse('toolu_A', 'Review diff', 'general-purpose');
    idx.recordParentAgentToolUse('toolu_B', 'Review diff', 'general-purpose');

    const bound1 = idx.bindSubagent('agent1', { description: 'Review diff', agentType: 'general-purpose' });
    const bound2 = idx.bindSubagent('agent2', { description: 'Review diff', agentType: 'general-purpose' });

    expect(bound1).toBe('toolu_A');
    expect(bound2).toBe('toolu_B');
  });

  it('does not match parents with different subagent_type', () => {
    idx.recordParentAgentToolUse('toolu_A', 'Do stuff', 'Explore');
    const bound = idx.bindSubagent('agent1', { description: 'Do stuff', agentType: 'Plan' });
    expect(bound).toBeNull();
  });

  it('binding consumes the parent so it is not reused', () => {
    idx.recordParentAgentToolUse('toolu_A', 'Find bug', 'Explore');
    idx.bindSubagent('agent1', { description: 'Find bug', agentType: 'Explore' });
    const second = idx.bindSubagent('agent2', { description: 'Find bug', agentType: 'Explore' });
    expect(second).toBeNull();
  });

  it('unbind removes a binding so lookup returns null', () => {
    idx.recordParentAgentToolUse('toolu_A', 'Find bug', 'Explore');
    idx.bindSubagent('agent1', { description: 'Find bug', agentType: 'Explore' });
    idx.unbind('agent1');
    expect(idx.lookup('agent1')).toBeNull();
  });

  it('pending subagent events buffer then flush when parent arrives later', () => {
    idx.bufferPendingEvent('agent1', { description: 'Find bug', agentType: 'Explore' }, { fakeEvent: 1 });
    idx.bufferPendingEvent('agent1', { description: 'Find bug', agentType: 'Explore' }, { fakeEvent: 2 });

    idx.recordParentAgentToolUse('toolu_A', 'Find bug', 'Explore');

    const flushed = idx.tryFlushPending('agent1');
    expect(flushed?.parentToolUseId).toBe('toolu_A');
    expect(flushed?.events).toEqual([{ fakeEvent: 1 }, { fakeEvent: 2 }]);
    expect(idx.lookup('agent1')).toBe('toolu_A');
  });

  it('pending events age out after 30s with no matching parent', () => {
    const clock = { t: 1000 };
    const aged = new SubagentIndex({ nowMs: () => clock.t });

    aged.bufferPendingEvent('agent1', { description: 'Find bug', agentType: 'Explore' }, { fakeEvent: 1 });
    clock.t = 1000 + 30_001;
    aged.pruneExpired();

    expect(aged.tryFlushPending('agent1')).toBeNull();
  });

  it('pruneExpired keeps entries younger than 30s', () => {
    const clock = { t: 1000 };
    const aged = new SubagentIndex({ nowMs: () => clock.t });
    aged.bufferPendingEvent('agent1', { description: 'Find bug', agentType: 'Explore' }, { fakeEvent: 1 });
    clock.t = 1000 + 15_000;
    aged.pruneExpired();

    aged.recordParentAgentToolUse('toolu_A', 'Find bug', 'Explore');
    expect(aged.tryFlushPending('agent1')?.parentToolUseId).toBe('toolu_A');
  });
});
