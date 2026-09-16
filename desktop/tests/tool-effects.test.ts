// Specialists plans, Task 9a (pause handoff design §1): every native tool
// declares what running it can change — `read` (nothing), `local` (files and
// state on this computer), `external` (anything that may reach outside it).
// The plan executor decides whether a specialist cut off mid-call may be
// restarted automatically from this one declaration, so a tool that forgets
// to declare one must fail here rather than silently count as anything.
import { describe, it, expect } from 'vitest';
import { CORE_TOOLS, nativeToolEffect } from '../src/main/harness/tools';
import { createSkillTool } from '../src/main/harness/tools/skill';
import { createTaskTool } from '../src/main/harness/tools/task';
import { ModelSearchTool } from '../src/main/harness/tools/model-search';
import { createProposePlanTool } from '../src/main/harness/tools/propose-plan';
import { BUILTIN_ROSTER } from '../src/main/harness/specialists/registry';
import { mcpToolsFor } from '../src/main/harness/mcp/mcp-tools';
import type { NativeTool } from '../src/main/harness/tools/types';

const fakeServer = (names: string[]) => ({
  id: 'srv', label: 'Server',
  tools: names.map((name) => ({ name, description: `d ${name}`, inputSchema: { type: 'object' } })),
  call: async () => ({ text: '', isError: false }),
}) as any;

const everyNativeTool = (): NativeTool[] => [
  ...CORE_TOOLS,
  ModelSearchTool,
  createSkillTool({ list: () => [{ id: 'x', description: 'd' }], load: () => { throw new Error('unused'); } }),
  createTaskTool(),
  createProposePlanTool(BUILTIN_ROSTER),
];

/** The design's table (§1), verbatim. Task and propose_plan are not in it;
 *  Task may start a specialist that runs commands (external), propose_plan
 *  only writes this conversation's plan file (local). */
const EXPECTED: Record<string, 'read' | 'local' | 'external'> = {
  Read: 'read', Glob: 'read', Grep: 'read', Skill: 'read', ModelSearch: 'read', BashOutput: 'read', WebSearch: 'read',
  Write: 'local', Edit: 'local', TodoWrite: 'local', KillShell: 'local', propose_plan: 'local',
  Bash: 'external', WebFetch: 'external', AskUserQuestion: 'external', SendUserFile: 'external', SendUserLink: 'external',
  Task: 'external',
};

describe('tool effects (pause handoff §1)', () => {
  it('every native tool declares an effect', () => {
    const missing = everyNativeTool().filter((t) => !['read', 'local', 'external'].includes(t.effect as string)).map((t) => t.name);
    expect(missing, `tools with no effect: ${missing.join(', ')}`).toEqual([]);
  });

  it('each declared effect is the one the design names', () => {
    const got = Object.fromEntries(everyNativeTool().map((t) => [t.name, t.effect]));
    expect(got).toEqual(EXPECTED);
  });

  it('the name lookup the executor uses agrees with every definition', () => {
    for (const t of everyNativeTool()) expect(nativeToolEffect(t.name), t.name).toBe(t.effect);
  });

  it('every MCP tool is external, by declaration and by name', () => {
    const tools = mcpToolsFor(fakeServer(['search', 'read_file']));
    for (const t of tools) {
      expect(t.effect).toBe('external');
      expect(nativeToolEffect(t.name)).toBe('external');
    }
  });

  it('an unclassified name counts as external (the safe direction)', () => {
    expect(nativeToolEffect('SomethingNew')).toBe('external');
    expect(nativeToolEffect('an unknown tool')).toBe('external');
    expect(nativeToolEffect('')).toBe('external');
  });
});
