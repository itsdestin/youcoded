import {
  AssistantTurn,
  AssistantTurnSegment,
  ChatAction,
  ChatState,
  SessionChatState,
  TimelineEntry,
  createSessionChatState,
} from './chat-types';

let messageCounter = 0;
function nextMessageId(): string {
  return `msg-${++messageCounter}`;
}

let groupCounter = 0;
function nextGroupId(): string {
  return `group-${++groupCounter}`;
}

let turnCounter = 0;
function nextTurnId(): string {
  return `turn-${++turnCounter}`;
}

/**
 * Returns the current assistant turn (or creates a new one).
 * All assistant text and tool groups within a single turn accumulate here.
 */
function getOrCreateTurn(session: SessionChatState): {
  assistantTurns: Map<string, AssistantTurn>;
  timeline: TimelineEntry[];
  currentTurnId: string;
} {
  const assistantTurns = new Map(session.assistantTurns);
  let timeline = session.timeline;
  let currentTurnId = session.currentTurnId;

  if (currentTurnId && assistantTurns.has(currentTurnId)) {
    return { assistantTurns, timeline, currentTurnId };
  }

  currentTurnId = nextTurnId();
  // Metadata fields default to null here; turn-complete populates them later (see TRANSCRIPT_TURN_COMPLETE).
  assistantTurns.set(currentTurnId, {
    id: currentTurnId,
    segments: [],
    timestamp: Date.now(),
    stopReason: null,
    model: null,
    usage: null,
    anthropicRequestId: null,
  });
  timeline = [...timeline, { kind: 'assistant-turn' as const, turnId: currentTurnId }];
  return { assistantTurns, timeline, currentTurnId };
}

/**
 * Inject a plan segment into the current turn for an ExitPlanMode tool_use.
 * Returns a new assistantTurns Map (or the original if no injection happened).
 *
 * - Dedups by toolUseId so re-emits of the same tool_use don't duplicate bubbles.
 * - If `beforeGroupId` is provided (merge-synthetic path, where the tool-group
 *   already exists), splices the plan segment in before it so the plan renders
 *   above the approval card. Otherwise appends.
 */
function injectPlanSegment(
  assistantTurns: Map<string, AssistantTurn>,
  currentTurnId: string,
  toolUseId: string,
  toolInput: Record<string, unknown>,
  beforeGroupId?: string,
): Map<string, AssistantTurn> {
  const plan = toolInput.plan;
  if (typeof plan !== 'string' || !plan) return assistantTurns;
  const turn = assistantTurns.get(currentTurnId);
  if (!turn) return assistantTurns;
  const planFilePath = typeof toolInput.planFilePath === 'string' ? toolInput.planFilePath : undefined;
  const existingIdx = turn.segments.findIndex(
    (s) => s.type === 'plan' && s.toolUseId === toolUseId,
  );
  let newSegments: AssistantTurnSegment[];
  if (existingIdx >= 0) {
    // Update in place: dedup must prevent duplicate bubbles, NOT freeze stale
    // content. If an earlier tool_use emit carried partial/empty input and a
    // later emit has the full plan, the bubble needs to reflect the latest.
    // Preserve the original messageId so React keeps the same bubble identity.
    const existing = turn.segments[existingIdx];
    if (existing.type !== 'plan') return assistantTurns;
    if (
      existing.content === plan &&
      existing.planFilePath === planFilePath &&
      existing.allowedPrompts === toolInput.allowedPrompts
    ) {
      return assistantTurns;
    }
    const updatedSeg: AssistantTurnSegment = {
      ...existing,
      content: plan,
      planFilePath,
      allowedPrompts: toolInput.allowedPrompts,
    };
    newSegments = [
      ...turn.segments.slice(0, existingIdx),
      updatedSeg,
      ...turn.segments.slice(existingIdx + 1),
    ];
  } else {
    const planSeg: AssistantTurnSegment = {
      type: 'plan',
      messageId: nextMessageId(),
      toolUseId,
      content: plan,
      planFilePath,
      allowedPrompts: toolInput.allowedPrompts,
    };
    if (beforeGroupId) {
      const idx = turn.segments.findIndex(
        (s) => s.type === 'tool-group' && s.groupId === beforeGroupId,
      );
      newSegments = idx >= 0
        ? [...turn.segments.slice(0, idx), planSeg, ...turn.segments.slice(idx)]
        : [...turn.segments, planSeg];
    } else {
      newSegments = [...turn.segments, planSeg];
    }
  }
  const updated = new Map(assistantTurns);
  updated.set(currentTurnId, { ...turn, segments: newSegments });
  return updated;
}

/**
 * Shared cleanup for turn endings (both normal completion and timeout).
 * Marks orphaned running/awaiting tools as failed and clears turn tracking.
 */
function endTurn(session: SessionChatState): Partial<SessionChatState> {
  const toolCalls = new Map(session.toolCalls);
  for (const id of session.activeTurnToolIds) {
    const tool = toolCalls.get(id);
    if (tool && (tool.status === 'running' || tool.status === 'awaiting-approval')) {
      toolCalls.set(id, { ...tool, status: 'failed', error: 'Turn ended' });
    }
  }
  return {
    toolCalls,
    isThinking: false,
    streamingText: '',
    currentGroupId: null,
    currentTurnId: null,
    activeTurnToolIds: new Set(),
    // Clean slate on turn end. SESSION_PROCESS_EXITED sets 'session-died'
    // AFTER spreading endTurn() so it overrides this reset.
    attentionState: 'ok' as const,
  };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  const next = new Map(state);

  switch (action.type) {
    case 'RESET': {
      return new Map();
    }

    case 'SESSION_INIT': {
      if (!next.has(action.sessionId)) {
        next.set(action.sessionId, createSessionChatState());
      }
      return next;
    }

    case 'SESSION_REMOVE': {
      next.delete(action.sessionId);
      return next;
    }

    case 'USER_PROMPT': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      // ALWAYS append a pending bubble — no content-based dedup. The prior
      // last-10-entries content match silently dropped legitimate rapid-fire
      // duplicates (e.g. "yes" twice within five turns). TRANSCRIPT_USER_MESSAGE
      // confirms this entry by finding the oldest matching pending and
      // clearing its flag.
      const message = {
        id: nextMessageId(),
        role: 'user' as const,
        content: action.content,
        timestamp: action.timestamp,
      };

      next.set(action.sessionId, {
        ...session,
        timeline: [...session.timeline, { kind: 'user', message, pending: true }],
        isThinking: true,
        currentGroupId: null,
        currentTurnId: null,
      });
      return next;
    }

    case 'SHOW_PROMPT': {
      let session = next.get(action.sessionId);
      if (!session) {
        session = createSessionChatState();
        next.set(action.sessionId, session);
      }

      const timeline = session.timeline.filter(
        (e) => !(e.kind === 'prompt' && e.prompt.promptId === action.promptId),
      );
      timeline.push({
        kind: 'prompt',
        prompt: {
          promptId: action.promptId,
          title: action.title,
          description: action.description,
          buttons: action.buttons,
        },
      });

      next.set(action.sessionId, { ...session, timeline });
      return next;
    }

    case 'COMPLETE_PROMPT': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      const timeline = session.timeline.map((e) => {
        if (e.kind === 'prompt' && e.prompt.promptId === action.promptId) {
          return { ...e, prompt: { ...e.prompt, completed: action.selection } };
        }
        return e;
      });

      next.set(action.sessionId, { ...session, timeline });
      return next;
    }

    case 'DISMISS_PROMPT': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      const timeline = session.timeline.filter(
        (e) => !(e.kind === 'prompt' && e.prompt.promptId === action.promptId && !e.prompt.completed),
      );

      next.set(action.sessionId, { ...session, timeline });
      return next;
    }

    // Process exited — if the session was still working (in-flight tools OR
    // isThinking) OR exited nonzero, surface this as 'session-died'. Clean
    // exits during idle are no-ops (we don't want a banner when the user
    // intentionally closes a quiet session).
    case 'SESSION_PROCESS_EXITED': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      const hadInFlight = session.isThinking || session.activeTurnToolIds.size > 0;
      if (action.exitCode === 0 && !hadInFlight) return state;
      next.set(action.sessionId, {
        ...session,
        ...endTurn(session),
        // Override endTurn's 'ok' reset — this is the state we want to surface.
        attentionState: 'session-died',
      });
      return next;
    }

    // Pure state write from the classifier driver hook. Gated by the hook
    // itself (only dispatches when mapped state differs), so no guard needed.
    case 'ATTENTION_STATE_CHANGED': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      if (session.attentionState === action.state) return state;
      next.set(action.sessionId, { ...session, attentionState: action.state });
      return next;
    }

    // Thinking blocks are genuine activity — bump lastActivityAt and clear
    // any stale attention state back to 'ok'. No timeline change.
    case 'TRANSCRIPT_THINKING_HEARTBEAT': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      next.set(action.sessionId, {
        ...session,
        lastActivityAt: Date.now(),
        attentionState: 'ok',
      });
      return next;
    }

    // --- Transcript watcher actions ---

    case 'TRANSCRIPT_USER_MESSAGE': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      // Find the OLDEST pending entry with matching content and confirm it
      // (clear the `pending` flag). This replaces the old last-10-entries
      // content-match dedup, which suppressed legitimate rapid-fire repeats.
      // Oldest-first so two identical optimistic bubbles get confirmed by two
      // transcript events in order.
      let confirmedIdx = -1;
      for (let i = 0; i < session.timeline.length; i++) {
        const entry = session.timeline[i];
        if (
          entry.kind === 'user' &&
          entry.pending === true &&
          entry.message.content === action.text
        ) {
          confirmedIdx = i;
          break;
        }
      }

      if (confirmedIdx >= 0) {
        const entry = session.timeline[confirmedIdx];
        if (entry.kind !== 'user') return state; // type-narrowing safety
        const confirmed: TimelineEntry = {
          kind: 'user',
          message: entry.message,
          pending: false,
        };
        const timeline = [
          ...session.timeline.slice(0, confirmedIdx),
          confirmed,
          ...session.timeline.slice(confirmedIdx + 1),
        ];
        next.set(action.sessionId, {
          ...session,
          timeline,
          isThinking: true,
          currentGroupId: null,
          currentTurnId: null,
          attentionState: 'ok',
        });
        return next;
      }

      // No pending match — remote/replay client, or user typed directly into
      // the terminal. Append as a new confirmed entry.
      const message = {
        id: nextMessageId(),
        role: 'user' as const,
        content: action.text,
        timestamp: action.timestamp,
      };

      next.set(action.sessionId, {
        ...session,
        timeline: [...session.timeline, { kind: 'user', message, pending: false }],
        isThinking: true,
        currentGroupId: null,
        currentTurnId: null,
        // Fresh activity from the transcript → chat view is back in sync,
        // so any stale attention banner should disappear.
        attentionState: 'ok',
      });
      return next;
    }

    case 'TRANSCRIPT_ASSISTANT_TEXT': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      const { assistantTurns, timeline, currentTurnId } = getOrCreateTurn(session);
      const turn = assistantTurns.get(currentTurnId)!;
      // Task 2.4: Capture model on first text of the turn so the model pill is
      // visible while the turn is in-flight. `?? turn.model` preserves the
      // existing value when a later text chunk arrives without a model, so we
      // never clobber a previously-captured model with null.
      assistantTurns.set(currentTurnId, {
        ...turn,
        segments: [
          ...turn.segments,
          { type: 'text', content: action.text, messageId: nextMessageId() },
        ],
        model: action.model ?? turn.model,
      });

      next.set(action.sessionId, {
        ...session, assistantTurns, timeline, currentTurnId,
        currentGroupId: null, // next tool_use creates a new group
        lastActivityAt: Date.now(),
        attentionState: 'ok',
      });
      return next;
    }

    case 'TRANSCRIPT_TOOL_USE': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      const toolCalls = new Map(session.toolCalls);

      // Check for a synthetic permission entry (perm-*) that matches this tool.
      // When the hook arrives before the transcript, a synthetic entry is created
      // with awaiting-approval status. Replace it with the real tool, preserving
      // the permission state and group placement.
      let mergedSynthetic = false;
      for (const [synId, synTool] of toolCalls) {
        if (synId.startsWith('perm-') && synTool.toolName === action.toolName
            && synTool.status === 'awaiting-approval') {
          // Replace synthetic with real tool, preserving permission state
          toolCalls.delete(synId);
          toolCalls.set(action.toolUseId, {
            toolUseId: action.toolUseId,
            toolName: action.toolName,
            input: action.toolInput,
            status: synTool.status,
            requestId: synTool.requestId,
            permissionSuggestions: synTool.permissionSuggestions,
          });
          // Update the tool group to reference the real ID
          const toolGroups = new Map(session.toolGroups);
          for (const [gid, group] of toolGroups) {
            if (group.toolIds.includes(synId)) {
              toolGroups.set(gid, {
                ...group,
                toolIds: group.toolIds.map((id) => id === synId ? action.toolUseId : id),
              });
              break;
            }
          }
          const activeTurnToolIds = new Set(session.activeTurnToolIds);
          activeTurnToolIds.delete(synId);
          activeTurnToolIds.add(action.toolUseId);

          // For ExitPlanMode, surface the plan markdown as its own bubble.
          // The tool-group already exists (hook arrived first), so splice the
          // plan segment in before it rather than appending.
          let mergedTurns = session.assistantTurns;
          if (action.toolName === 'ExitPlanMode' && session.currentTurnId) {
            let targetGroupId: string | undefined;
            for (const [gid, group] of toolGroups) {
              if (group.toolIds.includes(action.toolUseId)) { targetGroupId = gid; break; }
            }
            mergedTurns = injectPlanSegment(
              session.assistantTurns,
              session.currentTurnId,
              action.toolUseId,
              action.toolInput,
              targetGroupId,
            );
          }

          next.set(action.sessionId, {
            ...session, toolCalls, toolGroups,
            assistantTurns: mergedTurns,
            activeTurnToolIds,
            lastActivityAt: Date.now(),
            attentionState: 'ok',
          });
          mergedSynthetic = true;
          break;
        }
      }
      if (mergedSynthetic) return next;

      toolCalls.set(action.toolUseId, {
        toolUseId: action.toolUseId,
        toolName: action.toolName,
        input: action.toolInput,
        status: 'running',
      });

      let { assistantTurns, timeline, currentTurnId } = getOrCreateTurn(session);
      const toolGroups = new Map(session.toolGroups);
      let currentGroupId = session.currentGroupId;

      // ExitPlanMode: inject plan markdown as its own bubble BEFORE the
      // tool-group, so the full plan is visible in chat view (not just the
      // approval buttons).
      if (action.toolName === 'ExitPlanMode') {
        assistantTurns = injectPlanSegment(
          assistantTurns,
          currentTurnId,
          action.toolUseId,
          action.toolInput,
        );
      }

      if (currentGroupId && toolGroups.has(currentGroupId)) {
        // Add to existing group (no new segment needed)
        const group = toolGroups.get(currentGroupId)!;
        toolGroups.set(currentGroupId, {
          ...group,
          toolIds: [...group.toolIds, action.toolUseId],
        });
      } else {
        // Create new group and add as segment to current turn
        currentGroupId = nextGroupId();
        toolGroups.set(currentGroupId, { id: currentGroupId, toolIds: [action.toolUseId] });

        const turn = assistantTurns.get(currentTurnId)!;
        assistantTurns.set(currentTurnId, {
          ...turn,
          segments: [...turn.segments, { type: 'tool-group', groupId: currentGroupId }],
        });
      }

      const activeTurnToolIds = new Set(session.activeTurnToolIds);
      activeTurnToolIds.add(action.toolUseId);
      next.set(action.sessionId, {
        ...session, toolCalls, toolGroups, assistantTurns, timeline,
        currentGroupId, currentTurnId,
        activeTurnToolIds,
        lastActivityAt: Date.now(),
        attentionState: 'ok',
      });
      return next;
    }

    case 'TRANSCRIPT_TOOL_RESULT': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      const toolCalls = new Map(session.toolCalls);
      const existing = toolCalls.get(action.toolUseId);
      if (existing) {
        // Carry structuredPatch onto the tool state so DiffView can render
        // with absolute file line numbers (Claude Code ships it pre-computed).
        const patch = action.structuredPatch;
        if (action.isError) {
          toolCalls.set(action.toolUseId, {
            ...existing, status: 'failed', error: action.result,
            ...(patch ? { structuredPatch: patch } : {}),
          });
        } else {
          toolCalls.set(action.toolUseId, {
            ...existing, status: 'complete', response: action.result,
            ...(patch ? { structuredPatch: patch } : {}),
          });
        }
      }

      next.set(action.sessionId, {
        ...session, toolCalls, lastActivityAt: Date.now(),
        attentionState: 'ok',
      });
      return next;
    }

    case 'TRANSCRIPT_TURN_COMPLETE': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      // Attach completion metadata to the completing turn before clearing
      // turn-scoped state via endTurn(). currentTurnId is the in-flight turn;
      // if it's already null (edge case: turn-complete arrived before any
      // assistant text), skip metadata attachment but still call endTurn.
      const completingTurnId = session.currentTurnId;
      const assistantTurns = new Map(session.assistantTurns);
      if (completingTurnId) {
        const turn = assistantTurns.get(completingTurnId);
        if (turn) {
          assistantTurns.set(completingTurnId, {
            ...turn,
            stopReason: action.stopReason,
            // Preserve any model already captured on the turn (e.g. from
            // assistant-text in Task 2.4) — only override when the action
            // carries one. The two should agree when both are present.
            model: action.model ?? turn.model,
            anthropicRequestId: action.anthropicRequestId,
            usage: action.usage,
          });
        }
      }

      next.set(action.sessionId, { ...session, assistantTurns, ...endTurn(session) });
      return next;
    }

    case 'PERMISSION_REQUEST': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      // Find the matching running tool — prefer matching by tool name,
      // fall back to the first running tool if no name match exists.
      const toolCalls = new Map(session.toolCalls);
      let found = false;
      let fallbackId: string | null = null;
      for (const [id, tool] of toolCalls) {
        if (tool.status === 'running') {
          if (tool.toolName === action.toolName) {
            toolCalls.set(id, {
              ...tool,
              status: 'awaiting-approval',
              requestId: action.requestId,
              permissionSuggestions: action.permissionSuggestions,
            });
            found = true;
            break;
          }
          if (!fallbackId) fallbackId = id;
        }
      }
      // Prefer matching by requestId over the arbitrary first-running-tool fallback
      if (!found && action.requestId) {
        for (const [id, tool] of toolCalls) {
          if (tool.status === 'running' && tool.requestId === action.requestId) {
            toolCalls.set(id, {
              ...tool,
              status: 'awaiting-approval',
              requestId: action.requestId,
              permissionSuggestions: action.permissionSuggestions,
            });
            found = true;
            break;
          }
        }
      }
      if (!found && fallbackId) {
        const tool = toolCalls.get(fallbackId)!;
        toolCalls.set(fallbackId, {
          ...tool,
          status: 'awaiting-approval',
          requestId: action.requestId,
          permissionSuggestions: action.permissionSuggestions,
        });
        found = true;
      }

      if (!found) {
        // Permission hook arrived before transcript watcher — create synthetic tool entry
        const syntheticId = `perm-${action.requestId}`;
        toolCalls.set(syntheticId, {
          toolUseId: syntheticId,
          toolName: action.toolName,
          input: action.input,
          status: 'awaiting-approval',
          requestId: action.requestId,
          permissionSuggestions: action.permissionSuggestions,
        });

        const groupId = nextGroupId();
        const toolGroups = new Map(session.toolGroups);
        toolGroups.set(groupId, { id: groupId, toolIds: [syntheticId] });

        // Place the synthetic tool group inside an assistant turn
        const filteredTimeline = session.timeline.filter(
          (e) => !(e.kind === 'prompt' && !e.prompt.completed),
        );
        const { assistantTurns, timeline, currentTurnId } = getOrCreateTurn({
          ...session, timeline: filteredTimeline,
        });
        const turn = assistantTurns.get(currentTurnId)!;
        assistantTurns.set(currentTurnId, {
          ...turn,
          segments: [...turn.segments, { type: 'tool-group', groupId }],
        });

        const activeTurnToolIds = new Set(session.activeTurnToolIds);
        activeTurnToolIds.add(syntheticId);
        next.set(action.sessionId, {
          ...session, toolCalls, toolGroups, assistantTurns,
          timeline, currentTurnId, activeTurnToolIds,
          // Chat already renders the approval card — classifier doesn't also need to warn.
          attentionState: 'ok',
        });
        return next;
      }

      // Dismiss any parser-detected PromptCards
      const timeline = session.timeline.filter(
        (e) => !(e.kind === 'prompt' && !e.prompt.completed),
      );

      next.set(action.sessionId, { ...session, toolCalls, timeline, attentionState: 'ok' });
      return next;
    }

    case 'PERMISSION_RESPONDED': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      const toolCalls = new Map(session.toolCalls);
      for (const [id, tool] of toolCalls) {
        if (tool.status === 'awaiting-approval' && tool.requestId === action.requestId) {
          toolCalls.set(id, { ...tool, status: 'running', requestId: undefined });
          break;
        }
      }

      next.set(action.sessionId, { ...session, toolCalls });
      return next;
    }

    case 'PERMISSION_EXPIRED': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      const toolCalls = new Map(session.toolCalls);
      for (const [id, tool] of toolCalls) {
        if (tool.status === 'awaiting-approval' && tool.requestId === action.requestId) {
          toolCalls.set(id, {
            ...tool,
            status: 'failed',
            requestId: undefined,
            error: 'Permission request expired — socket closed before a response was sent',
          });
          break;
        }
      }

      next.set(action.sessionId, { ...session, toolCalls });
      return next;
    }

    case 'HISTORY_LOADED': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      // Build timeline entries from historical messages
      const historyTimeline: TimelineEntry[] = [];
      const historyTurns = new Map(session.assistantTurns);
      let historyMsgCounter = 0;

      // Add "see previous messages" marker if there's more history
      if (action.hasMore) {
        historyTimeline.push({
          kind: 'prompt',
          prompt: {
            promptId: '_history_expand',
            title: 'See previous messages',
            buttons: [],
          },
        });
      }

      // When replacing history (hasMore=false), remove old history entries and expand button
      const existingTimeline = action.hasMore
        ? session.timeline
        : session.timeline.filter((e) => {
            if (e.kind === 'prompt' && e.prompt.promptId === '_history_expand') return false;
            if (e.kind === 'user' && e.message.id.startsWith('hist-')) return false;
            if (e.kind === 'assistant-turn' && e.turnId.startsWith('hist-')) return false;
            return true;
          });

      for (const msg of action.messages) {
        const id = `hist-${++historyMsgCounter}`;
        if (msg.role === 'user') {
          historyTimeline.push({
            kind: 'user',
            message: { id, role: 'user', content: msg.content, timestamp: msg.timestamp },
          });
        } else {
          const turnId = `hist-turn-${historyMsgCounter}`;
          const msgId = `hist-msg-${historyMsgCounter}`;
          // History-loaded turns never saw a turn-complete, so metadata fields stay null.
          historyTurns.set(turnId, {
            id: turnId,
            segments: [{ type: 'text', content: msg.content, messageId: msgId }],
            timestamp: msg.timestamp,
            stopReason: null,
            model: null,
            usage: null,
            anthropicRequestId: null,
          });
          historyTimeline.push({ kind: 'assistant-turn', turnId });
        }
      }

      // Prepend history before existing timeline
      next.set(action.sessionId, {
        ...session,
        timeline: [...historyTimeline, ...existingTimeline],
        assistantTurns: historyTurns,
      });
      return next;
    }

    // /cost and /usage — appends a point-in-time stats snapshot card to the timeline.
    // Permanent (not dismissible); reducer is write-only, UsageCard reads from snapshot.
    case 'SHOW_USAGE_CARD': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      next.set(action.sessionId, {
        ...session,
        timeline: [...session.timeline, { kind: 'usage-card', snapshot: action.snapshot }],
      });
      return next;
    }

    // /compact — inserts spinner card + sets pending flag. Claude Code does the
    // actual summarization via API; we detect completion via transcript shrink
    // OR next turn-complete (see COMPACTION_COMPLETE). Keep existing timeline —
    // the user should still see their messages during the 10-30s compaction.
    case 'COMPACTION_PENDING': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      // Idempotent: if already pending, just update the card (don't stack spinners)
      const filtered = session.timeline.filter((e) => e.kind !== 'compacting');
      const startedAt = Date.now();
      next.set(action.sessionId, {
        ...session,
        timeline: [...filtered, { kind: 'compacting', id: action.cardId, startedAt }],
        compactionPending: { startedAt, beforeContextTokens: action.beforeContextTokens },
      });
      return next;
    }

    // Compaction finished — remove the spinner, insert a marker, but KEEP
    // the pre-compaction timeline so the user can scroll back and read what
    // they discussed. Claude's actual context is now just the summary (which
    // arrives as a new assistant-turn via transcript events), but visually
    // showing the history matches how long chat threads feel elsewhere.
    // ChatView fades entries above the marker to hint they're "archived".
    // Invoked from two paths: transcript-shrink (typed /compact) and first
    // turn-complete after pending (resume-from-summary).
    case 'COMPACTION_COMPLETE': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      if (!session.compactionPending) return state; // Stale event — ignore
      const before = session.compactionPending.beforeContextTokens;
      const after = action.afterContextTokens;
      let label: string;
      if (action.aborted) {
        label = 'Compaction may have failed';
      } else if (before != null && after != null && before > after) {
        const freed = before - after;
        label = `Compacted · freed ${freed.toLocaleString()} tokens`;
      } else {
        label = 'Conversation compacted';
      }
      // Strip the compacting spinner card but preserve everything else.
      const preserved = session.timeline.filter((e) => e.kind !== 'compacting');
      next.set(action.sessionId, {
        ...session,
        ...endTurn(session),
        timeline: [
          ...preserved,
          {
            kind: 'system-marker',
            marker: {
              id: action.markerId,
              timestamp: Date.now(),
              label,
              variant: 'compact',
            },
          },
        ],
        compactionPending: null,
      });
      return next;
    }

    // /copy picker — inserts a copy-picker card inline. Removed on click or cancel.
    case 'SHOW_COPY_PICKER': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      next.set(action.sessionId, {
        ...session,
        timeline: [...session.timeline, { kind: 'copy-picker', id: action.id, options: action.options }],
      });
      return next;
    }

    case 'DISMISS_COPY_PICKER': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      next.set(action.sessionId, {
        ...session,
        timeline: session.timeline.filter((e) => !(e.kind === 'copy-picker' && e.id === action.id)),
      });
      return next;
    }

    // /clear — wipes visible timeline, inserts a thin divider, resets turn state.
    // Claude Code's own context is reset separately by forwarding /clear to the PTY.
    // We preserve toolCalls/toolGroups Maps so any mid-flight results that arrive
    // after the clear (before the PTY-level reset takes effect) don't crash lookups.
    case 'CLEAR_TIMELINE': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      next.set(action.sessionId, {
        ...session,
        ...endTurn(session),
        timeline: [
          {
            kind: 'system-marker',
            marker: {
              id: action.markerId,
              timestamp: action.timestamp,
              label: 'Conversation cleared',
              variant: 'clear',
            },
          },
        ],
      });
      return next;
    }

    default:
      return state;
  }
}
