import type { NativeTool } from './types';
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
