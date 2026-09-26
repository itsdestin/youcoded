import { describe, it, expect } from 'vitest';
import { loadFixture } from './fixture-loader';

describe('loadFixture', () => {
  it('parses a Skill tool_use + tool_result pair into a single tool block', () => {
    const raw = [
      '{"type":"tool_use","id":"toolu_01ABC","name":"Skill","input":{"skill":"superpowers:brainstorming"}}',
      '{"tool_use_id":"toolu_01ABC","type":"tool_result","content":"Launching skill: superpowers:brainstorming","is_error":false}',
    ].join('\n');

    const result = loadFixture('skill-brainstorming', raw);

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].kind).toBe('tool');
    if (result.blocks[0].kind === 'tool') {
      // 'complete' is the real reducer output — ToolCallStatus has no 'completed' variant.
      expect(result.blocks[0].tool).toMatchObject({
        toolUseId: 'toolu_01ABC',
        toolName: 'Skill',
        input: { skill: 'superpowers:brainstorming' },
        status: 'complete',
        response: 'Launching skill: superpowers:brainstorming',
      });
    }
    expect(result.error).toBeUndefined();
  });

  it('marks is_error:true results as failed status', () => {
    const raw = [
      '{"type":"tool_use","id":"toolu_01XYZ","name":"Bash","input":{"command":"false"}}',
      '{"tool_use_id":"toolu_01XYZ","type":"tool_result","content":"exit code 1","is_error":true}',
    ].join('\n');

    const result = loadFixture('bash-failure', raw);

    expect(result.blocks).toHaveLength(1);
    if (result.blocks[0].kind === 'tool') {
      expect(result.blocks[0].tool.status).toBe('failed');
      expect(result.blocks[0].tool.error).toBe('exit code 1');
    }
  });

  it('flips a running tool to awaiting-approval on a permission_request line', () => {
    const raw = [
      '{"type":"tool_use","id":"toolu_01BashAsk","name":"Bash","input":{"command":"npm test","description":"Run the test suite"}}',
      '{"type":"permission_request","tool_use_id":"toolu_01BashAsk","requestId":"native-fixture-1","denyListed":false}',
    ].join('\n');

    const result = loadFixture('bash-awaiting-approval', raw);

    // The bare tool_use emits no block — the permission_request line is what
    // surfaces the (terminal) awaiting-approval card.
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].kind).toBe('tool');
    if (result.blocks[0].kind === 'tool') {
      expect(result.blocks[0].tool).toMatchObject({
        toolUseId: 'toolu_01BashAsk',
        toolName: 'Bash',
        status: 'awaiting-approval',
        requestId: 'native-fixture-1',
        denyListed: false,
      });
    }
    expect(result.error).toBeUndefined();
  });

  it('carries denyListed:true through to the awaiting-approval tool', () => {
    const raw = [
      '{"type":"tool_use","id":"toolu_01BashRm","name":"Bash","input":{"command":"rm -rf build/"}}',
      '{"type":"permission_request","tool_use_id":"toolu_01BashRm","requestId":"native-fixture-2","denyListed":true}',
    ].join('\n');

    const result = loadFixture('bash-awaiting-approval-denylisted', raw);

    expect(result.blocks).toHaveLength(1);
    if (result.blocks[0].kind === 'tool') {
      expect(result.blocks[0].tool.status).toBe('awaiting-approval');
      expect(result.blocks[0].tool.denyListed).toBe(true);
    }
  });

  it('keeps an awaiting-approval card with expired:true on a permission_expired line', () => {
    const raw = [
      '{"type":"tool_use","id":"toolu_01BashExpired","name":"Bash","input":{"command":"rm -rf node_modules && npm ci"}}',
      '{"type":"permission_request","tool_use_id":"toolu_01BashExpired","requestId":"wb-expired-1","denyListed":false}',
      '{"type":"permission_expired","tool_use_id":"toolu_01BashExpired","requestId":"wb-expired-1","reason":"hook-closed"}',
    ].join('\n');
    const result = loadFixture('bash-awaiting-approval-expired', raw);
    // The expiry swaps the permission_request's block in place — never a second block.
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].kind).toBe('tool');
    if (result.blocks[0].kind === 'tool') {
      expect(result.blocks[0].tool).toMatchObject({
        toolUseId: 'toolu_01BashExpired', toolName: 'Bash',
        status: 'awaiting-approval', expired: true, requestId: undefined,
      });
    }
    expect(result.error).toBeUndefined();
  });

  it('returns an error field when the fixture is malformed', () => {
    const result = loadFixture('broken', 'not valid json\n');

    expect(result.blocks).toEqual([]);
    expect(result.error).toMatch(/^parse error in broken:/);
  });

  it('interleaves text blocks and tool blocks in source order', () => {
    const raw = [
      '{"type":"text","text":"Let me check a couple of files."}',
      '{"type":"tool_use","id":"toolu_01G1","name":"Read","input":{"file_path":"/a.ts"}}',
      '{"tool_use_id":"toolu_01G1","type":"tool_result","content":"// a","is_error":false}',
      '{"type":"text","text":"Now the other one."}',
      '{"type":"tool_use","id":"toolu_01G2","name":"Read","input":{"file_path":"/b.ts"}}',
      '{"tool_use_id":"toolu_01G2","type":"tool_result","content":"// b","is_error":false}',
    ].join('\n');

    const result = loadFixture('group', raw);

    expect(result.blocks).toHaveLength(4);
    expect(result.blocks[0]).toEqual({ kind: 'text', text: 'Let me check a couple of files.' });
    expect(result.blocks[1].kind).toBe('tool');
    expect(result.blocks[2]).toEqual({ kind: 'text', text: 'Now the other one.' });
    expect(result.blocks[3].kind).toBe('tool');
    if (result.blocks[1].kind === 'tool' && result.blocks[3].kind === 'tool') {
      expect(result.blocks[1].tool.toolUseId).toBe('toolu_01G1');
      expect(result.blocks[3].tool.toolUseId).toBe('toolu_01G2');
    }
  });
});
