import type { NativeTool } from './types';
import { canRunPrograms } from '../../headless/host-bridge';
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
import {
  ReadFileCommentsTool,
  ReplyToCommentTool,
  ResolveCommentTool,
  ReopenCommentTool,
  AddCommentTool,
  MoveCommentTool,
} from './doc-comments-tools';

/** Plan A core set + Plan B tools + SendUserFile (2026-08-25) + the six
 *  document-comment tools (T8, docs/active/specs/2026-09-26-doc-comments-
 *  build-design.md §5). WebFetch/WebSearch are the web pair (free in every
 *  preset/mode — see permission-types.rulesForMode); AskUserQuestion
 *  (interactive, driver-routed) comes last. */
export const CORE_TOOLS: NativeTool[] = [ReadTool, WriteTool, EditTool, BashTool, BashOutputTool, KillShellTool, GlobTool, GrepTool, TodoWriteTool, WebFetchTool, WebSearchTool, SendUserFileTool, SendUserLinkTool, ReadFileCommentsTool, ReplyToCommentTool, ResolveCommentTool, ReopenCommentTool, AddCommentTool, MoveCommentTool, AskUserQuestionTool];

/** Tools that ARE "start another program": the shell and its two companions. */
const PROGRAM_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell']);

/** The tools a session on THIS device can actually be given.
 *  WHY (2026-11-25, iPhone app, card #89): an iPhone cannot start a program, so a model offered `Bash` there
 *  would call it, fail, and try again — and tell the person to "run this command", which they cannot either.
 *  A tool that cannot work is not offered. (Grep stays: it searches in-process where ripgrep cannot run.)
 *  Everywhere else this is exactly CORE_TOOLS. */
export function deviceTools(): NativeTool[] {
  return canRunPrograms() ? CORE_TOOLS : CORE_TOOLS.filter((t) => !PROGRAM_TOOLS.has(t.name));
}
