// Dev-only fixture parser: converts a JSONL snippet (text lines + tool_use/tool_result
// pairs) into an ordered list of blocks by running tool entries through the actual
// chat reducer. This keeps the sandbox honest — any reducer drift surfaces here
// automatically.
//
// Why ordered blocks (not a flat tool list): fixtures now interleave assistant-text
// lines and tool pairs so the sandbox can render grouped "turn-like" bubbles. Pulling
// tools out of `session.toolCalls.values()` at the end would lose that interleaving
// order — so we track insertion order explicitly as we walk the fixture.
//
// Text lines are fixture-only annotations — they are NOT dispatched to the reducer
// (no assistant-text action is needed; the reducer stays reserved for the real
// tool state transitions it was designed for).

import { chatReducer } from '../state/chat-reducer';
import type { ChatState, ChatAction, ToolCallState } from '../state/chat-types';

const SANDBOX_SESSION_ID = 'sandbox';

// ChatState is a Map<string, SessionChatState> (chat-types.ts:357), so an
// empty Map is the initial state. SESSION_INIT seeds the sandbox session —
// without it, TRANSCRIPT_TOOL_USE/RESULT bail out because `session` is missing.
function makeInitialState(): ChatState {
  return chatReducer(new Map(), {
    type: 'SESSION_INIT',
    sessionId: SANDBOX_SESSION_ID,
  });
}

export type FixtureBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: ToolCallState };

export interface LoadResult {
  blocks: FixtureBlock[];
  error?: string;
}

export function loadFixture(name: string, raw: string): LoadResult {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);

  try {
    let state = makeInitialState();
    const blocks: FixtureBlock[] = [];

    for (const line of lines) {
      const parsed = JSON.parse(line);

      if (parsed.type === 'text' && typeof parsed.text === 'string') {
        // Text lines are fixture annotations only — append directly, no reducer.
        blocks.push({ kind: 'text', text: parsed.text });
      } else if (parsed.type === 'tool_use') {
        const action: ChatAction = {
          type: 'TRANSCRIPT_TOOL_USE',
          sessionId: SANDBOX_SESSION_ID,
          uuid: `${name}-use-${parsed.id}`,
          toolUseId: parsed.id,
          toolName: parsed.name,
          toolInput: parsed.input ?? {},
        };
        state = chatReducer(state, action);
        // Do NOT emit a block here — wait for the matching tool_result so the
        // block reflects the tool's final state (complete/failed + response).
      } else if (parsed.type === 'tool_result') {
        // tool_result.content is usually a string in Claude Code transcripts,
        // but can be a structured array (e.g. for Agent results) — stringify
        // those so the reducer's `result: string` field stays consistent.
        const content = typeof parsed.content === 'string'
          ? parsed.content
          : JSON.stringify(parsed.content);
        const action: ChatAction = {
          type: 'TRANSCRIPT_TOOL_RESULT',
          sessionId: SANDBOX_SESSION_ID,
          uuid: `${name}-res-${parsed.tool_use_id}`,
          toolUseId: parsed.tool_use_id,
          result: content,
          isError: parsed.is_error === true,
        };
        state = chatReducer(state, action);
        // Emit the tool block in fixture source order (not reducer-map order).
        const session = state.get(SANDBOX_SESSION_ID);
        const tool = session?.toolCalls.get(parsed.tool_use_id);
        if (tool) blocks.push({ kind: 'tool', tool });
      }
      // Unknown types are silently skipped (same policy as before).
    }

    return { blocks };
  } catch (err) {
    return {
      blocks: [],
      error: `parse error in ${name}: ${(err as Error).message}`,
    };
  }
}
