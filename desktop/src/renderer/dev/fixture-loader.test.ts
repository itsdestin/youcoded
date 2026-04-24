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
