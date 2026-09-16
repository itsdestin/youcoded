import type { NativeTool, ToolEffect } from './types';
import { ReadTool } from './read';
import { WriteTool } from './write';
import { EditTool } from './edit';
import { BashOutputTool } from './bash-output';
import { KillShellTool } from './kill-shell';
import { BashTool } from './bash';
import { GlobTool } from './glob';
import { GrepTool } from './grep';
import { TodoWriteTool } from './todo-write';
import { WebFetchTool } from './web-fetch';
import { WebSearchTool } from './web-search';
import { AskUserQuestionTool } from './ask-user-question';
import { SendUserFileTool } from './send-user-file';
import { SendUserLinkTool } from './send-user-link';
import { ModelSearchTool } from './model-search';
import { SKILL_TOOL_EFFECT } from './skill';
import { TASK_TOOL_EFFECT } from './task';
import { PROPOSE_PLAN_TOOL_EFFECT } from './propose-plan';

/** Plan A core set + Plan B tools + SendUserFile (2026-08-25). WebFetch/WebSearch
 *  are the web pair (free in every preset/mode — see permission-types.rulesForMode);
 *  AskUserQuestion (interactive, driver-routed) comes last. */
export const CORE_TOOLS: NativeTool[] = [ReadTool, WriteTool, EditTool, BashTool, BashOutputTool, KillShellTool, GlobTool, GrepTool, TodoWriteTool, WebFetchTool, WebSearchTool, SendUserFileTool, SendUserLinkTool, AskUserQuestionTool];

/**
 * Pause handoff §1: what a tool NAME can change, read from the tools' own
 * declarations. A plan specialist's transcript only records the name of a call
 * that never got a result, and this is how the plan decides whether it may be
 * restarted by itself. WHY a lookup derived from the definitions (not a second
 * list): the executor's old read-only name list drifted from the tools
 * (WebFetch and AskUserQuestion were "read-only"). Every MCP tool
 * (`mcp__…`) and every name not declared here counts as `external`.
 * Pinned by tests/tool-effects.test.ts.
 */
const NATIVE_TOOL_EFFECTS: ReadonlyMap<string, ToolEffect> = new Map<string, ToolEffect>([
  ...[...CORE_TOOLS, ModelSearchTool].map((t): [string, ToolEffect] => [t.name, t.effect ?? 'external']),
  ['Skill', SKILL_TOOL_EFFECT],
  ['Task', TASK_TOOL_EFFECT],
  ['propose_plan', PROPOSE_PLAN_TOOL_EFFECT],
]);

export function nativeToolEffect(name: string): ToolEffect {
  if (name.startsWith('mcp__')) return 'external';
  return NATIVE_TOOL_EFFECTS.get(name) ?? 'external';
}
