import { ChatMessage, ToolCallState, ToolGroupState } from '../../shared/types';

export interface InteractivePrompt {
  promptId: string;
  title: string;
  description?: string; // Contextual text explaining the prompt (e.g., resume trade-offs)
  buttons: { label: string; input: string }[];
  completed?: string; // label of the selected option, if completed
}

// --- Assistant turn types ---

export type AssistantTurnSegment =
  | { type: 'text'; content: string; messageId: string }
  | { type: 'tool-group'; groupId: string }
  // Plan mode: ExitPlanMode tool's `input.plan` surfaced as its own bubble so
  // users see the full plan markdown in chat, not just the approval buttons.
  // Linked to the tool via toolUseId so the reducer can dedup across re-emits.
  | { type: 'plan'; messageId: string; toolUseId: string; content: string; planFilePath?: string; allowedPrompts?: unknown };

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface AssistantTurn {
  id: string;
  segments: AssistantTurnSegment[];
  /** Epoch ms — captured from the first segment's transcript event */
  timestamp?: number;
  /** Only set when stop_reason is non-end_turn (max_tokens, refusal, etc.). Null for normal completions. */
  stopReason: string | null;
  /** Model ID from the transcript (e.g. 'claude-opus-4-7'). Drives per-turn model chip + drift detection. */
  model: string | null;
  /** Token + cache usage from message.usage. Rendered in the opt-in metadata strip. */
  usage: TurnUsage | null;
  /** Anthropic API request ID (req_…). Surfaced in error banners for support correlation. */
  anthropicRequestId: string | null;
}

// Snapshot of session stats + rate limits captured when /cost or /usage was typed.
// Point-in-time — never auto-updates. The live view lives in the status bar.
export interface UsageSnapshot {
  entryId: string;              // stable id so re-renders don't duplicate
  timestamp: number;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  contextTokens: number | null;
  contextPercent: number | null;
  duration: number | null;
  apiDuration: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  fiveHourUtilization: number | null;
  fiveHourResetsAt: string | null;
  sevenDayUtilization: number | null;
  sevenDayResetsAt: string | null;
}

// Thin divider entry — shown when a slash command produced a side-effect
// worth marking in the conversation history (e.g. /clear, /compact).
// Permanent so the user can scroll back and see that "these messages end here."
export interface SystemMarker {
  id: string;
  timestamp: number;
  label: string;                                // e.g. "Conversation cleared"
  variant?: 'clear' | 'compact' | 'info';       // For styling hooks
}

// /copy [N] picker — shown inline when the Nth assistant turn has multiple
// copyable units (full response + code blocks). Temporary; removed on click or cancel.
export interface CopyPickerOption {
  id: string;
  label: string;       // e.g. "Full response", "Code block 1 (python)"
  preview: string;     // First ~80 chars for button subtitle
  content: string;     // The actual text to copy
}

export type TimelineEntry =
  | { kind: 'user'; message: ChatMessage }
  | { kind: 'assistant-turn'; turnId: string }
  | { kind: 'prompt'; prompt: InteractivePrompt }
  // /cost and /usage render a snapshot card inline. Permanent (not dismissible).
  | { kind: 'usage-card'; snapshot: UsageSnapshot }
  // Thin "Conversation cleared" / "Compacted" dividers
  | { kind: 'system-marker'; marker: SystemMarker }
  // Spinner card while /compact (or resume-from-summary) is running
  | { kind: 'compacting'; id: string; startedAt: number }
  // /copy picker when the target turn has multiple copyable blocks
  | { kind: 'copy-picker'; id: string; options: CopyPickerOption[] };

// AttentionState drives the UI decision between ThinkingIndicator (ok) and
// the AttentionBanner (everything else). A classifier reads the PTY buffer
// and maps its conclusions onto these states; process-exit events also
// transition to 'session-died' directly. See docs/chat-reducer.md.
export type AttentionState =
  | 'ok'              // Default — indicator renders if isThinking
  | 'awaiting-input'  // PTY shows a non-hook prompt (CLI-level confirm, etc.)
  | 'shell-idle'      // PTY shows bash/shell prompt; session not actively running
  | 'error'           // PTY tail matches error pattern
  | 'stuck'           // Spinner frame stale ≥ 10s OR unknown silence > 60s
  | 'session-died';   // Process exited mid-turn

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
  /**
   * Drives the chat-view "is something wrong?" banner. Default 'ok' means
   * render the normal ThinkingIndicator (when isThinking). Anything else
   * surfaces an AttentionBanner with state-specific copy. Set by the PTY
   * buffer classifier (useAttentionClassifier) or by SESSION_PROCESS_EXITED.
   * Reset to 'ok' on any transcript activity or endTurn().
   */
  attentionState: AttentionState;
  /**
   * Wall-clock of the last non-spinner buffer change (set by classifier).
   * Used to distinguish "spinner is ticking but nothing else is changing"
   * from "buffer is actively producing new output."
   */
  lastBufferActivityAt: number;
  /**
   * Compaction in flight — set by /compact (typed or resume-from-summary click),
   * cleared by transcript-shrink event OR first turn-complete after pending was set
   * (resume-from-summary writes to a NEW file, so shrink on the old file never fires).
   * Holds the pre-compaction contextTokens count so COMPACTION_COMPLETE can compute
   * how much was freed.
   */
  compactionPending: { startedAt: number; beforeContextTokens: number | null } | null;
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
    attentionState: 'ok',
    lastBufferActivityAt: 0,
    compactionPending: null,
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
      description?: string;
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
      // Process exited — main-process session-exit event forwarded via IPC.
      // Reducer decides whether to surface 'session-died' based on exitCode
      // and whether a turn was in flight.
      type: 'SESSION_PROCESS_EXITED';
      sessionId: string;
      exitCode: number;
    }
  | {
      // Classifier-driven attention state change. Pure state write; no
      // side effects. Dispatched by useAttentionClassifier only when the
      // classifier's decision differs from the current state.
      type: 'ATTENTION_STATE_CHANGED';
      sessionId: string;
      state: AttentionState;
    }
  | {
      // Heartbeat fired when the transcript watcher sees an assistant
      // thinking block (extended-thinking models). No UI; just bumps
      // lastActivityAt and clears attentionState back to 'ok'.
      type: 'TRANSCRIPT_THINKING_HEARTBEAT';
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
      // Task 2.4: model from the transcript's `message.model` field, captured
      // on the first assistant-text of a turn so the model pill/metadata is
      // visible on in-flight turns (before turn-complete stamps it definitively).
      model?: string;
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
      structuredPatch?: import('../../shared/types').StructuredPatchHunk[];
    }
  | {
      type: 'TRANSCRIPT_TURN_COMPLETE';
      sessionId: string;
      uuid: string;
      timestamp: number;
      stopReason: string | null;
      model: string | null;
      anthropicRequestId: string | null;
      usage: TurnUsage | null;
    }
  | {
      type: 'HISTORY_LOADED';
      sessionId: string;
      messages: { role: 'user' | 'assistant'; content: string; timestamp: number }[];
      hasMore: boolean;
    }
  // Snapshot card shown when user runs /cost or /usage. Point-in-time —
  // doesn't auto-update even as live stats change (see status bar for live view).
  | {
      type: 'SHOW_USAGE_CARD';
      sessionId: string;
      snapshot: UsageSnapshot;
    }
  // /clear wipes the visible timeline and inserts a thin divider. Claude Code's
  // own context reset is handled separately by forwarding /clear to the PTY.
  // Reducer uses endTurn() to fail any tools orphaned mid-turn.
  | {
      type: 'CLEAR_TIMELINE';
      sessionId: string;
      markerId: string;       // Stable id so the divider survives re-renders
      timestamp: number;
    }
  // Spinner card shown during /compact. Sets compactionPending flag + inserts
  // a 'compacting' timeline entry so users see *something* is happening.
  | {
      type: 'COMPACTION_PENDING';
      sessionId: string;
      cardId: string;
      beforeContextTokens: number | null;
    }
  // Compaction finished — remove spinner, clear timeline, add marker with diff.
  // Triggered by transcript-shrink OR first turn-complete (resume-from-summary).
  | {
      type: 'COMPACTION_COMPLETE';
      sessionId: string;
      markerId: string;
      afterContextTokens: number | null;
      aborted?: boolean;       // true when watchdog fires — marker text differs
    }
  // /copy picker for multi-block turns
  | {
      type: 'SHOW_COPY_PICKER';
      sessionId: string;
      id: string;
      options: CopyPickerOption[];
    }
  // Clicked an option or dismissed the picker
  | {
      type: 'DISMISS_COPY_PICKER';
      sessionId: string;
      id: string;
    };

export type ChatState = Map<string, SessionChatState>;
