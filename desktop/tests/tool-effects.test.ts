// Specialists plans, Task 9a (pause handoff design §1): every native tool
// declares what running it can change — `read` (nothing), `local` (files and
// state on this computer), `external` (anything that may reach outside it).
// The plan executor decides whether a specialist cut off mid-call may be
// restarted automatically from this one declaration, so a tool that forgets
// to declare one must fail here rather than silently count as anything.
import { describe, it, expect } from 'vitest';
import { CORE_TOOLS, nativeToolEffect } from '../src/main/harness/tools';
import { HarnessSession } from '../src/main/harness/harness-session';
import { CLOUD_DEFAULT } from '../src/main/harness/capability-profile';
import { mcpToolsFor } from '../src/main/harness/mcp/mcp-tools';
import type { NativeTool } from '../src/main/harness/tools/types';
import { makeOpts } from './helpers/harness-fakes';

const fakeServer = (names: string[]) => ({
  id: 'srv', label: 'Server',
  tools: names.map((name) => ({ name, description: `d ${name}`, inputSchema: { type: 'object' } })),
  call: async () => ({ text: '', isError: false }),
}) as any;

/**
 * Review fix 5: the tools a REAL root session ends up holding — the host's
 * CORE_TOOLS (native-session-host.ts passes exactly that list) plus every
 * conditional tool the session attaches itself (Skill, Task, ModelSearch,
 * propose_plan, MCP) — read from the session's own tool map after it syncs.
 * WHY not a hand-written list: a tool added to the session later would escape
 * a list; it cannot escape the map the model is actually offered.
 */
const everyNativeTool = (): NativeTool[] => {
  const session = new HarnessSession(makeOpts({
    tools: CORE_TOOLS,
    providerType: 'openrouter',
    profile: { ...CLOUD_DEFAULT, exposeSkillCatalog: true, canDelegate: true, supportsTools: true, mcpToolBudgetTokens: 1_000_000 },
    skillCatalog: { list: () => [{ id: 'x', description: 'd' }], load: () => { throw new Error('unused'); } },
    mcpServers: [fakeServer(['search', 'read_file'])],
    decide: async () => ({ action: 'allow', denyListed: false }),
  }), async () => { throw new Error('no model needed'); });
  (session as any).buildAiTools();
  return [...((session as any).toolByName as Map<string, NativeTool>).values()];
};

/** The design's table (§1), verbatim. Task and propose_plan are not in it;
 *  Task may start a specialist that runs commands (external), propose_plan
 *  only writes this conversation's plan file (local). */
const EXPECTED: Record<string, 'read' | 'local' | 'external'> = {
  Read: 'read', Glob: 'read', Grep: 'read', Skill: 'read', ModelSearch: 'read', BashOutput: 'read', WebSearch: 'read',
  Write: 'local', Edit: 'local', TodoWrite: 'local', KillShell: 'local', propose_plan: 'local',
  Bash: 'external', WebFetch: 'external', AskUserQuestion: 'external', SendUserFile: 'external', SendUserLink: 'external',
  Task: 'external',
  mcp__srv__search: 'external', mcp__srv__read_file: 'external',
};

describe('tool effects (pause handoff §1)', () => {
  it('the session really attached every conditional tool (so the checks below cover them)', () => {
    const names = everyNativeTool().map((t) => t.name);
    for (const n of ['Skill', 'Task', 'ModelSearch', 'propose_plan', 'mcp__srv__search']) expect(names).toContain(n);
    for (const t of CORE_TOOLS) expect(names).toContain(t.name);
  });

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
