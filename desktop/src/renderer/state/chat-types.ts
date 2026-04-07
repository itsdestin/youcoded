import { ChatMessage, ToolCallState, ToolGroupState } from '../../shared/types';

export interface InteractivePrompt {
  promptId: string;
  title: string;
  buttons: { label: string; input: string }[];
  completed?: string; // label of the selected option, if completed
}

// --- Assistant turn types ---

export type AssistantTurnSegment =
  | { type: 'text'; content: string; messageId: string }
  | { type: 'tool-group'; groupId: string };

export interface AssistantTurn {
  id: string;
  segments: AssistantTurnSegment[];
}

export type TimelineEntry =
  | { kind: 'user'; message: ChatMessage }
  | { kind: 'assistant-turn'; turnId: string }
  | { kind: 'prompt'; prompt: InteractivePrompt };

export interface SessionChatState {
  timeline: TimelineEntry[];
  toolCalls: Map<string, ToolCallState>;
  toolGroups: Map<string, ToolGroupState>;
  assistantTurns: Map<string, AssistantTurn>;
  isThinking: boolean;
  streamingText: string;
  /** ID of the current tool group (tools are appended here until next message) */
  currentGroupId: string | null;
  /** ID of the current assistant turn (text + tool groups accumulate here) */
  currentTurnId: string | null;
  /** Timestamp of last activity from Claude — used to reset the thinking timeout */
  lastActivityAt: number;
  /** Tool IDs belonging to the current active turn — cleared on turn end */
  activeTurnToolIds: Set<string>;
  /** True when the thinking timeout fired — ephemeral, cleared on turn-complete */
  thinkingTimedOut: boolean;
}

export function createSessionChatState(): SessionChatState {
  return {
    timeline: [],
    toolCalls: new Map(),
    toolGroups: new Map(),
    assistantTurns: new Map(),
    isThinking: false,
    streamingText: '',
    currentGroupId: null,
    currentTurnId: null,
    lastActivityAt: 0,
    activeTurnToolIds: new Set(),
    thinkingTimedOut: false,
  };
}

export type ChatAction =
  | { type: 'RESET' }
  | { type: 'SESSION_INIT'; sessionId: string }
  | { type: 'SESSION_REMOVE'; sessionId: string }
  | {
      type: 'USER_PROMPT';
      sessionId: string;
      content: string;
      timestamp: number;
    }
  | {
      type: 'SHOW_PROMPT';
      sessionId: string;
      promptId: string;
      title: string;
      buttons: { label: string; input: string }[];
    }
  | {
      type: 'COMPLETE_PROMPT';
      sessionId: string;
      promptId: string;
      selection: string;
    }
  | {
      type: 'DISMISS_PROMPT';
      sessionId: string;
      promptId: string;
    }
  | {
      type: 'THINKING_TIMEOUT';
      sessionId: string;
    }
  | {
      type: 'PERMISSION_REQUEST';
      sessionId: string;
      toolName: string;
      input: Record<string, unknown>;
      requestId: string;
      permissionSuggestions?: string[];
    }
  | {
      type: 'PERMISSION_EXPIRED';
      sessionId: string;
      requestId: string;
    }
  | {
      type: 'PERMISSION_RESPONDED';
      sessionId: string;
      requestId: string;
    }
  | {
      type: 'TERMINAL_ACTIVITY';
      sessionId: string;
    }
  | {
      type: 'TRANSCRIPT_USER_MESSAGE';
      sessionId: string;
      uuid: string;
      text: string;
      timestamp: number;
    }
  | {
      type: 'TRANSCRIPT_ASSISTANT_TEXT';
      sessionId: string;
      uuid: string;
      text: string;
      timestamp: number;
    }
  | {
      type: 'TRANSCRIPT_TOOL_USE';
      sessionId: string;
      uuid: string;
      toolUseId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
    }
  | {
      type: 'TRANSCRIPT_TOOL_RESULT';
      sessionId: string;
      uuid: string;
      toolUseId: string;
      result: string;
      isError: boolean;
    }
  | {
      type: 'TRANSCRIPT_TURN_COMPLETE';
      sessionId: string;
      uuid: string;
      timestamp: number;
    }
  | {
      type: 'HISTORY_LOADED';
      sessionId: string;
      messages: { role: 'user' | 'assistant'; content: string; timestamp: number }[];
      hasMore: boolean;
    };

export type ChatState = Map<string, SessionChatState>;
