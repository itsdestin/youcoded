import {
  AssistantTurn,
  AssistantTurnSegment,
  ChatAction,
  ChatState,
  SessionChatState,
  TimelineEntry,
  createSessionChatState,
  deserializeChatState,
  HISTORY_EXPAND_PROMPT_ID,
  abnormalStopReason,
  SerializedChatState,
} from './chat-types';
import { SubagentSegment, SpecialistNote, SpecialistRunView, ToolCallState, ToolGroupState } from '../../shared/types';
import { pageEventToAction } from './transcript-page-actions';
import { addTurnUsage, addSubagentUsage, addPatchLines, mergeTotals } from './session-totals';

// Fix: message ids are used as React keys. A hydrated remote client restarts
// this counter at 0 while its snapshot already holds msg-1..msg-N, so new live
// messages reused existing keys and React mis-reconciled — messages rendering
// in the wrong place, not updating, or the list jumping after connect. The
// per-boot epoch makes ids unique across the hydrate boundary without pulling
// in a uuid/nanoid dependency, and keeps them greppable/ordered in logs.
const ID_EPOCH = Math.random().toString(36).slice(2, 8);
let messageCounter = 0;
function nextMessageId(): string {
  return `msg-${ID_EPOCH}-${++messageCounter}`;
}

let groupCounter = 0;
function nextGroupId(): string {
  // WHY: a fresh remote boot must not overwrite a hydrated host's tool group.
  return `group-${ID_EPOCH}-${++groupCounter}`;
}

// Fix (Destin, 2026-08-16): CC writes a bare `/compact` line as a real user
// prompt in its JSONL — verified present, with a promptId and no isMeta, in 12
// lines across live transcripts — both when the user types it AND when
// resume-from-summary runs compaction internally. The app already shows a
// CompactingCard for that event, so the bubble is pure duplication sitting
// right next to a card saying the same thing.
//
// Used at BOTH places a bubble can be built from CC's record of the past:
// the live transcript append and the HISTORY_LOADED replay. Miss the second
// and the bubble reappears on reload — a "where did that come from?" change
// with no visible cause, which is worse than never having fixed it.
//
// Deliberately NOT applied to the optimistic-bubble confirm arm: the escape
// hatch (`\/compact`) is passthrough text that DOES get a bubble, and hiding
// its confirmation would strand it as permanently `pending`.
function isCompactCommandEcho(text: string): boolean {
  return /^\/compact(\s|$)/.test(text.trim());
}

/**
 * Whether a transcript user line is the message a pending bubble drew: the exact text, or, for a
 * message sent with attachments, the same words once the bubble's attachment paths and Claude
 * Code's `[Image #N]` placeholders are set aside. WHY (2026-09-11 order investigation): the bubble
 * reads "<path> what is this" while Claude Code records "[Image #1] what is this", so it never
 * confirmed and stayed pinned at the bottom beside the recorded copy.
 */
function sameUserMessage(message: { content: string; attachments?: string[] }, recorded: string): boolean {
  if (message.content === recorded) return true;
  const paths = message.attachments;
  if (!paths?.length) return false;
  const words = (s: string) => {
    let out = s;
    for (const p of paths) out = out.split(p).join(' ');
    return out.replace(/\[Image #\d+\]/g, ' ').replace(/\s+/g, ' ').trim();
  };
  return words(message.content) === words(recorded);
}

let turnCounter = 0;
function nextTurnId(): string {
  // WHY: turns are Map keys too; counter-only ids replace hydrated history.
  return `turn-${ID_EPOCH}-${++turnCounter}`;
}

/**
 * Key-order-independent JSON serialization, used to compare a permission
 * hook's `tool_input` against a transcript tool's `input`. The two arrive
 * from different sources (named-pipe relay vs JSONL parse) and plain
 * JSON.stringify equality would fail whenever their key order differs.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** The run view MINUS its ordering stamp. ROADMAP L259: `seq` changes on every
 *  projection by design, so it must not take part in the "did anything
 *  actually change" comparison that absorbs a delivery cycle's four
 *  byte-identical pushes. */
function withoutSeq(run: SpecialistRunView): Omit<SpecialistRunView, 'seq'> {
  const { seq: _seq, ...rest } = run;
  return rest;
}

/** A streamed chunk that is nothing but whitespace (or empty). */
function isBlankDelta(text: string): boolean {
  return text.trim() === '';
}

/**
 * True when a native delta with this partId would MERGE into the open turn's
 * last segment (same type, same partId) rather than open a new segment. Reads
 * the session without creating a turn — the caller uses it to decide whether a
 * blank chunk has a paragraph to join (keep) or would stand alone (drop).
 */
function mergesIntoOpenSegment(
  session: SessionChatState,
  type: 'text' | 'reasoning',
  partId: string | undefined,
): boolean {
  if (!partId || !session.currentTurnId) return false;
  const turn = session.assistantTurns.get(session.currentTurnId);
  const last = turn?.segments[turn.segments.length - 1];
  return !!last && last.type === type && last.partId === partId;
}

/**
 * Append a timeline entry ABOVE this device's still-pending user bubbles.
 *
 * WHY (Destin, 2026-09-11, phone test of remote access batches 2/3: messages and replies
 * "interweave in different orders across the two platforms"): the device that sends a
 * message draws it at once as a pending bubble, while every other device draws it only
 * when the transcript records it. Anything that arrived in between — the reply to the
 * PREVIOUS message, a message typed in the terminal — used to land below the pending
 * bubble here and above it everywhere else. Keeping pending bubbles as the timeline's
 * tail makes every device show transcript order; a pending bubble joins that order when
 * TRANSCRIPT_USER_MESSAGE confirms it. Pinned by tests/chat-order-sender-matches-receiver.test.ts.
 */
function appendAbovePending(timeline: TimelineEntry[], entry: TimelineEntry): TimelineEntry[] {
  let at = timeline.length;
  while (at > 0) {
    const prev = timeline[at - 1];
    if (prev.kind !== 'user' || prev.pending !== true) break;
    at--;
  }
  return [...timeline.slice(0, at), entry, ...timeline.slice(at)];
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
  timeline = appendAbovePending(timeline, { kind: 'assistant-turn' as const, turnId: currentTurnId });
  return { assistantTurns, timeline, currentTurnId };
}

/**
 * Place a tool id in the session's current tool group, creating the turn and/or
 * group if needed. IDEMPOTENT by tool id: an id already in a group leaves both
 * the group and currentGroupId untouched, so a re-emit can never render a
 * duplicate card or retarget where subsequent tools land.
 *
 * Shared by TRANSCRIPT_TOOL_USE and NATIVE_TOOL_PREPARING. It MUST stay one
 * function: the whole preparing-card design rests on the two paths placing a
 * card identically, so the real tool-use supersedes the preparing entry in
 * place instead of adding a second card beside it.
 */
function placeToolInCurrentGroup(
  session: SessionChatState,
  toolUseId: string,
): {
  assistantTurns: Map<string, AssistantTurn>;
  timeline: TimelineEntry[];
  toolGroups: Map<string, ToolGroupState>;
  currentGroupId: string | null;
  currentTurnId: string;
} {
  const { assistantTurns, timeline, currentTurnId } = getOrCreateTurn(session);
  const toolGroups = new Map(session.toolGroups);
  let currentGroupId = session.currentGroupId;

  // The watcher deliberately re-emits tool-use on repeated uuids (CC rewrites
  // the same JSONL line as the assistant message grows, and a rewrite may carry
  // NEW tool_use blocks), relying on "the reducer dedupes by toolUseId" — true
  // of the toolCalls Map, but a group append would add the id a second time,
  // rendering a duplicate ToolCard. Symptom was most visible on
  // AskUserQuestion: AssistantTurnBubble hides awaiting-approval tools from
  // groups, so both copies only became visible once answered.
  // See transcript-watcher.ts readNewLines (~line 679) for the emit contract.
  let existingGroupId: string | null = null;
  for (const [gid, group] of toolGroups) {
    if (group.toolIds.includes(toolUseId)) { existingGroupId = gid; break; }
  }

  if (existingGroupId) {
    // Already placed by an earlier emit of this same tool.
  } else if (currentGroupId && toolGroups.has(currentGroupId)) {
    const group = toolGroups.get(currentGroupId)!;
    toolGroups.set(currentGroupId, { ...group, toolIds: [...group.toolIds, toolUseId] });
  } else {
    currentGroupId = nextGroupId();
    toolGroups.set(currentGroupId, { id: currentGroupId, toolIds: [toolUseId] });
    const turn = assistantTurns.get(currentTurnId)!;
    assistantTurns.set(currentTurnId, {
      ...turn,
      segments: [...turn.segments, { type: 'tool-group', groupId: currentGroupId }],
    });
  }

  return { assistantTurns, timeline, toolGroups, currentGroupId, currentTurnId };
}

/**
 * Remove a PREPARING tool card: no tool was ever invoked, so it is deleted
 * rather than failed. Prunes an emptied group and that group's turn segment —
 * an empty group otherwise renders as a stray bar.
 *
 * Refuses to touch an entry that is not `preparing`, so a stall-retry clear can
 * never delete a real tool card whose result is still coming (that would be the
 * dangling tool_call the native runtime forbids).
 *
 * Shared by the `cleared` path and endTurn so the two removals cannot drift.
 * Mutates the Maps it is handed — callers pass their own fresh copies.
 */
function removePreparingTool(
  toolCalls: Map<string, ToolCallState>,
  toolGroups: Map<string, ToolGroupState>,
  assistantTurns: Map<string, AssistantTurn>,
  toolUseId: string,
): boolean {
  const entry = toolCalls.get(toolUseId);
  if (!entry?.preparing) return false;
  toolCalls.delete(toolUseId);

  for (const [gid, group] of toolGroups) {
    if (!group.toolIds.includes(toolUseId)) continue;
    const toolIds = group.toolIds.filter((id) => id !== toolUseId);
    if (toolIds.length > 0) {
      toolGroups.set(gid, { ...group, toolIds });
    } else {
      toolGroups.delete(gid);
      for (const [tid, turn] of assistantTurns) {
        const segments = turn.segments.filter(
          (s) => !(s.type === 'tool-group' && s.groupId === gid),
        );
        if (segments.length !== turn.segments.length) {
          assistantTurns.set(tid, { ...turn, segments });
        }
      }
    }
    break;
  }
  return true;
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
 *
 * `errorMessage` lets turn-ending paths attribute the failure accurately.
 * Interrupt path (TRANSCRIPT_INTERRUPT) passes 'Turn interrupted' so the
 * tool card distinguishes user-cancelled from normal turn completion; the
 * default 'Turn ended' preserves behavior for TRANSCRIPT_TURN_COMPLETE
 * and SESSION_PROCESS_EXITED.
 */
function endTurn(
  session: SessionChatState,
  errorMessage: string = 'Turn ended',
  // Callers that edit assistantTurns themselves (TURN_COMPLETE stamps usage,
  // INTERRUPT stamps stopReason) MUST pass their edited map in: endTurn now
  // returns an assistantTurns of its own to prune emptied preparing groups, and
  // spreading it over their `...session, assistantTurns` would silently discard
  // their edit — which is exactly how the interrupt footer lost 'Interrupted'.
  baseAssistantTurns?: Map<string, AssistantTurn>,
): Partial<SessionChatState> {
  const toolCalls = new Map(session.toolCalls);
  const toolGroups = new Map(session.toolGroups);
  const assistantTurns = new Map(baseAssistantTurns ?? session.assistantTurns);
  for (const id of session.activeTurnToolIds) {
    const tool = toolCalls.get(id);
    if (!tool) continue;
    // A PREPARING card is deleted, not failed: the model was still composing
    // the request, so no tool was ever invoked and "failed" would describe an
    // event that did not happen (Destin, 2026-08-12).
    if (tool.preparing) {
      removePreparingTool(toolCalls, toolGroups, assistantTurns, id);
      continue;
    }
    if (tool.status === 'running' || tool.status === 'awaiting-approval') {
      toolCalls.set(id, { ...tool, status: 'failed', error: errorMessage });
    }
  }
  return {
    toolCalls,
    toolGroups,
    assistantTurns,
    isThinking: false,
    // Prefill is over the moment the turn is. Leaving it set meant the next
    // generation pause longer than ThinkingIndicator's 2s streaming window
    // re-rendered the PREVIOUS turn's "Reading your prompt — N%" line while the
    // model was mid-generation (2026-07-28 audit).
    promptProcessing: null,
    streamingText: '',
    currentGroupId: null,
    currentTurnId: null,
    activeTurnToolIds: new Set(),
    // Clean slate on turn end. SESSION_PROCESS_EXITED sets 'session-died'
    // and NATIVE_SESSION_ERROR sets 'error' + errorMessage AFTER spreading
    // endTurn() so they override these resets.
    attentionState: 'ok' as const,
    errorMessage: null,
    // Any turn end also dismisses a pending stall countdown (the give-up path
    // ends the turn via NATIVE_SESSION_ERROR, which spreads endTurn()).
    stallWarning: null,
    // The turn cannot still be parked once it has ended.
    stalledSince: null,
  };
}

/**
 * Route a subagent-originated transcript event into the parent Agent
 * tool's `subagentSegments`. Returns the original state when the parent
 * tool is missing (the subagent event arrived before the parent tool_use
 * was dispatched — reducer bails; next event will succeed).
 */
function applySubagentEvent(state: ChatState, action: ChatAction): ChatState {
  if (action.type !== 'TRANSCRIPT_TOOL_USE'
      && action.type !== 'TRANSCRIPT_TOOL_RESULT'
      && action.type !== 'TRANSCRIPT_ASSISTANT_TEXT'
      && action.type !== 'TRANSCRIPT_ASSISTANT_REASONING') {
    return state;
  }
  const parentId = (action as any).parentAgentToolUseId as string | undefined;
  if (!parentId) return state;

  const session = state.get(action.sessionId);
  if (!session) return state;
  const parent = session.toolCalls.get(parentId);
  if (!parent) return state;

  // Fix (external review, 2026-08-13): a subagent event used to skip the
  // seenUuids dedup every other replay-fed entry point passes (see
  // TRANSCRIPT_USER_MESSAGE and the main-timeline TRANSCRIPT_ASSISTANT_TEXT
  // case, both above) — parentAgentToolUseId routed here BEFORE any uuid
  // check ever ran. tool-use/tool-result are harmless regardless: they
  // dedupe structurally by toolUseId below (Map/array overwrite), and CC's
  // own subagent-JSONL replay (subagent-watcher.ts getHistory) can
  // legitimately re-emit a repeat-uuid tool-use line to pick up a growing
  // input as Claude Code rewrites the same line — gating those on uuid would
  // freeze the segment at its first, possibly-partial input (mirrors
  // TranscriptWatcher.getHistory's own assistant-text-only uuid skip, same
  // reasoning). assistant-text has no such structural dedup — it merges by
  // partId only — so a second delivery of the exact same delta (getHistory()
  // card replay, Task 9, has no guard against being called twice against an
  // already-populated reducer state: a live re-dock re-sends the same
  // stamped events, not just a post-restart resume) appended the same
  // specialist text again. Checked AFTER the parent-card-exists bail above,
  // not before: a genuinely-missed live event (rare race — a child delta
  // arriving before the parent's own Task tool-use is dispatched) must never
  // be marked "seen" while it was in fact dropped, or a later delivery once
  // the card exists could never apply it.
  if (action.type === 'TRANSCRIPT_ASSISTANT_TEXT' && session.seenUuids.has(action.uuid)) {
    return state;
  }

  const segments: SubagentSegment[] = parent.subagentSegments ? [...parent.subagentSegments] : [];
  // Captured only on the TOOL_RESULT branch below — the pre-update segment,
  // read before it's overwritten, so the once-only patch guard after the
  // if-chain can see whether THIS call already had a structuredPatch.
  let existingToolSegment: Extract<SubagentSegment, { type: 'tool' }> | undefined;

  if (action.type === 'TRANSCRIPT_ASSISTANT_TEXT') {
    // Fix: the native harness (harness-session.ts:1769) emits one
    // assistant-text event per STREAM DELTA, not per whole message like CC's
    // watcher — without coalescing, a specialist's report rendered as
    // hundreds of separately-markdown-rendered blocks, breaking markdown
    // that spans a chunk boundary. Mirror the main-timeline merge (below,
    // TRANSCRIPT_ASSISTANT_TEXT case): same partId as the LAST segment →
    // append into it; otherwise push a new segment. CC never sets partId,
    // so its events keep today's one-segment-per-event behavior.
    // Review fix (2026-09-04, F2): the merge target is the LAST text segment
    // with this partId, not the last segment — a note stamped later than this
    // text can sit behind it (insertByTime below), and "last segment" would
    // then start a second bubble for the same stream.
    const lastIdx = lastIndexWhere(segments, s => s.type === 'text' && s.partId === action.partId);
    const last = action.partId && lastIdx >= 0 ? segments[lastIdx] : null;
    if (last && last.type === 'text') {
      segments[lastIdx] = { ...last, content: last.content + action.text };
    } else if (isBlankDelta(action.text)) {
      // Whitespace-only chunk with no open paragraph to join — same rule as
      // the main timeline (see TRANSCRIPT_ASSISTANT_TEXT): it would render as
      // an empty block on the specialist's card.
      return state;
    } else {
      insertByTime(segments, {
        type: 'text',
        id: `sa-text-${action.uuid}`,
        content: action.text,
        partId: action.partId,
        // Stamped with the FIRST delta's time (later deltas merge into this
        // segment above without touching it) so a mid-run note can be placed
        // relative to it — see reconcileNoteSegments.
        timestamp: action.timestamp,
      });
    }
  } else if (action.type === 'TRANSCRIPT_ASSISTANT_REASONING') {
    // Specialists 1c: a child's reasoning lands in ITS card as a 'thinking'
    // segment (coalesced by partId like text), never in the parent's own
    // reasoning bubble — which is where an unstamped dispatch used to send it.
    const lastIdx = lastIndexWhere(segments, s => s.type === 'thinking' && s.partId === action.partId); // as for text above
    const last = action.partId && lastIdx >= 0 ? segments[lastIdx] : null;
    if (last && last.type === 'thinking') {
      segments[lastIdx] = { ...last, content: last.content + action.text };
    } else if (isBlankDelta(action.text)) {
      return state; // as for text above
    } else {
      insertByTime(segments, {
        type: 'thinking',
        id: `sa-think-${action.uuid}`,
        content: action.text,
        partId: action.partId,
        timestamp: action.timestamp, // as for text above
      });
    }
  } else if (action.type === 'TRANSCRIPT_TOOL_USE') {
    const existingIdx = segments.findIndex(
      s => s.type === 'tool' && s.toolUseId === action.toolUseId,
    );
    const next: SubagentSegment = {
      type: 'tool',
      id: `sa-tool-${action.toolUseId}`,
      toolUseId: action.toolUseId,
      toolName: action.toolName,
      input: action.toolInput,
      status: 'running',
      // Fix (2026-09-01 investigation, notes not interleaved): the row's own
      // time, so a note sent mid-run can be slotted before or after it by
      // reconcileNoteSegments. Undefined for an event without a stamp, which
      // simply means "cannot be ordered against" — never a wrong position.
      timestamp: action.timestamp,
    };
    if (existingIdx >= 0) {
      const existing = segments[existingIdx] as Extract<SubagentSegment, { type: 'tool' }>;
      // Specialists 1c: the ask can beat the (rAF-batched) tool-use event by
      // ~50ms — the exact race that hung plan 1b's Test 1 at the top level
      // (cd6fb766). A segment already flipped to 'awaiting-approval' keeps
      // its ask state; only a plain duplicate tool_use overwrites to 'running'
      // (JSONL FIFO order guarantees its result hasn't been emitted yet).
      segments[existingIdx] = existing.status === 'awaiting-approval'
        ? { ...existing, input: action.toolInput }
        : next;
    } else {
      // Specialists 1c: reclaim a synthetic ask placeholder (`sa-perm-*`, minted
      // by PERMISSION_REQUEST when the ask arrived before this event) that
      // names the same tool — exact input first, else the first still-pending
      // one. Mirrors the top-level `perm-` reclaim in TRANSCRIPT_TOOL_USE.
      const incoming = action.toolInput ? stableStringify(action.toolInput) : null;
      let reclaimIdx = -1;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.type !== 'tool' || !seg.id.startsWith('sa-perm-')) continue;
        if (seg.toolName !== action.toolName || seg.status !== 'awaiting-approval') continue;
        if (incoming !== null && stableStringify(seg.input) === incoming) { reclaimIdx = i; break; }
        if (reclaimIdx === -1) reclaimIdx = i;
      }
      if (reclaimIdx >= 0) {
        const placeholder = segments[reclaimIdx] as Extract<SubagentSegment, { type: 'tool' }>;
        segments[reclaimIdx] = {
          ...placeholder,
          id: next.id,
          toolUseId: action.toolUseId,
          input: action.toolInput,
          // The placeholder was minted by the ask, which has no transcript
          // stamp — the real tool-use event is the first thing that knows
          // when this row happened.
          timestamp: next.timestamp,
        };
      } else {
        insertByTime(segments, next);
      }
    }
  } else if (action.type === 'TRANSCRIPT_TOOL_RESULT') {
    const idx = segments.findIndex(
      s => s.type === 'tool' && s.toolUseId === action.toolUseId,
    );
    if (idx >= 0 && segments[idx].type === 'tool') {
      const existing = segments[idx] as Extract<SubagentSegment, { type: 'tool' }>;
      existingToolSegment = existing;
      segments[idx] = action.isError
        ? { ...existing, status: 'failed', error: action.result }
        : {
            ...existing,
            status: 'complete',
            response: action.result,
            ...(action.structuredPatch ? { structuredPatch: action.structuredPatch } : {}),
          };
    }
  }

  const toolCalls = new Map(session.toolCalls);
  const updated: ToolCallState = { ...parent, subagentSegments: segments };
  toolCalls.set(parentId, updated);
  // Only assistant-text needs to grow seenUuids — see the dedup check above
  // for why tool-use/tool-result deliberately don't participate.
  const seenUuids = action.type === 'TRANSCRIPT_ASSISTANT_TEXT'
    ? new Set(session.seenUuids).add(action.uuid)
    : session.seenUuids;
  // A specialist's edits are the parent session's edits (spec §7). They live in
  // subagentSegments, NOT session.toolCalls, so a count over toolCalls alone
  // would miss every edit made by delegation — i.e. undercount hardest on the
  // biggest sessions. Same once-only guard as the main path: existingToolSegment
  // is the pre-update segment (only set inside the TOOL_RESULT branch above),
  // so a duplicate delivery with a patch already recorded is a no-op.
  //
  // Fix (Finding 1, 2026-08-26): also require `existingToolSegment` itself, not
  // just `!existingToolSegment?.structuredPatch`. If this toolUseId's tool-use
  // was never observed under this parent (a dropped/malformed transcript line —
  // treated as real elsewhere in this function's own comments), no segment
  // exists to have been captured, so the old guard was vacuously true on EVERY
  // delivery and a duplicate orphan result counted twice. A rare missed orphan
  // now contributes an incomplete number; a duplicate would have invented one —
  // and this whole feature exists to stop the status bar showing numbers that
  // aren't true.
  const totals = action.type === 'TRANSCRIPT_TOOL_RESULT'
      && existingToolSegment
      && action.structuredPatch
      && !existingToolSegment.structuredPatch
    ? addPatchLines(session.totals, action.structuredPatch)
    : session.totals;
  const next = new Map(state);
  next.set(action.sessionId, { ...session, toolCalls, seenUuids, totals });
  return next;
}

/**
 * Specialists 1c: which Task card owns a child. Prefer the explicit
 * parentToolCallId (the ledger and the ask router both carry it); fall back to
 * the card whose run/agentId names the child — covers a routed ask that
 * arrived without the id (older host) after the run record already landed.
 */
/** G-1 resume rule (spec §5.7): a Bash card whose result announced a shell id
 *  but that carries no live run record after replay was running when the app
 *  quit (a live registry would have replayed its record before this point).
 *  Returns null when no card changes so the reducer can keep its Map ref. */
export function markOrphanedShellRuns(toolCalls: Map<string, ToolCallState>): Map<string, ToolCallState> | null {
  let out: Map<string, ToolCallState> | null = null;
  for (const [id, card] of toolCalls) {
    if (card.toolName !== 'Bash' || card.shellRun || !card.response) continue;
    const m = /\(shell id (sh-[0-9a-f]+)\)/.exec(card.response);
    if (!m) continue;
    out ??= new Map(toolCalls);
    out.set(id, {
      ...card,
      shellRun: {
        toolUseId: card.toolUseId, shellId: m[1], status: 'stopped', stopReason: 'app-quit',
        detached: /^Still running after/.test(card.response),
        // Unknown after a restart: the card hides the timer and the log line
        // when these are empty rather than inventing "0s" or a blank path.
        startedAt: 0, tail: '', logPath: '',
      },
    });
  }
  return out;
}

function findSpecialistCard(
  toolCalls: Map<string, ToolCallState>,
  ref: { parentToolCallId?: string; childId?: string },
): string | null {
  if (ref.parentToolCallId && toolCalls.has(ref.parentToolCallId)) return ref.parentToolCallId;
  if (ref.childId) {
    for (const [id, tool] of toolCalls) {
      if (tool.specialistRun?.childId === ref.childId || tool.agentId === ref.childId) return id;
    }
  }
  return null;
}

/**
 * Task 10/11: turns a run record's `notes` (the ledger's full, ordered steer
 * history) into Activity-trail 'note' segments, appending only the ones this
 * card has never seen. Idempotent by construction: every SPECIALIST_RUN_CHANGED
 * carries the WHOLE notes array, not just a delta, so re-processing the same
 * run twice (a replayed attach, an unrelated status-only push) must not
 * duplicate a row already there.
 *
 * Task 11 judgment call (kept over the plan's "drop every note segment and
 * rebuild wholesale from run.notes"): a rebuild has no way to tell a stale,
 * out-of-order run event from the latest one, so a stale resend landing after
 * a newer live update (a plausible replay-then-live race; see the reducer test
 * of the same name) would silently DELETE a note row already on screen.
 * Append-by-id can only ever grow the list, so a resend with fewer notes can't
 * regress one already shown.
 *
 * ROADMAP L259 has since given SpecialistRunView a monotonic `seq`, and the
 * reducer now drops a straggler before it reaches here — so the rebuild is no
 * longer structurally impossible. It stays append-by-id anyway: `seq` is
 * absent on a card replayed from an older build, and append-by-id is safe
 * with or without a stamp. Trade-off: a note removed or edited server-side would not be
 * reflected here — accepted, because SpecialistNote's own contract is an
 * append-only steer history (never mutated after being written).
 *
 * Fix (Task 11): the id used to be `sa-note-${childId}-${note.at}` — two
 * notes landed in the same millisecond collided on id and the second was
 * silently deduped away as "already known". Keyed on the note's INDEX in the
 * array instead, matching the spec's stated id scheme; safe because the
 * ledger always resends the full, append-only notes array, so index i keeps
 * naming the same note across calls.
 *
 * Fix (2026-09-01 investigation, notes not interleaved): an unseen note used
 * to be APPENDED to the tail. Live that is usually where it belongs — nothing
 * later has arrived yet — but on a replay (reattach, restart, a late run push)
 * every tool row is already on the card, so a note sent mid-run showed up
 * AFTER tool calls that happened after it, and the trail lied as an audit log.
 * Now the note is inserted before the first segment stamped LATER than it
 * (every child segment carries the transcript event's own time since this
 * fix; a note carries the ledger's). A note later than everything still
 * appends, so the live path is unchanged. A segment with no stamp (an older
 * event shape) is never ordered against — it just keeps its place. Ids stay
 * index-based, so the resend idempotence above is untouched: placement only
 * ever happens the FIRST time a note is seen.
 *
 * Review fix (2026-09-04, F2/F6): the invariant is now TWO-sided. Child rows
 * (tool/text/thinking) go through the same insertByTime as notes, so a row
 * that reaches the reducer AFTER a note stamped later than it (transcript
 * events are rAF-batched, the ledger push is synchronous — a one-frame
 * window) slots before that note instead of landing below it. With every
 * stamped segment inserted by time the list stays time-ordered, which is what
 * the "first later segment" lookup silently assumed.
 */

/** Index of the LAST segment matching `pred`, or -1. */
function lastIndexWhere(segments: SubagentSegment[], pred: (s: SubagentSegment) => boolean): number {
  for (let i = segments.length - 1; i >= 0; i--) if (pred(segments[i])) return i;
  return -1;
}

/**
 * Insert a child segment at its time position, IN PLACE. The one ordering rule
 * for a specialist's Activity trail (see reconcileNoteSegments): a stamped
 * segment goes before the first segment stamped strictly LATER than it, else
 * at the tail — so equal stamps keep arrival order, and an unstamped segment
 * (an older event shape) is appended and never reordered, only skipped over.
 */
function insertByTime(segments: SubagentSegment[], seg: SubagentSegment): void {
  const t = seg.timestamp;
  const at = t === undefined ? -1 : segments.findIndex(s => s.timestamp !== undefined && s.timestamp > t);
  if (at < 0) segments.push(seg);
  else segments.splice(at, 0, seg);
}
function reconcileNoteSegments(
  existing: SubagentSegment[] | undefined,
  notes: SpecialistNote[] | undefined,
  childId: string,
): SubagentSegment[] | undefined {
  if (!notes || notes.length === 0) return existing;
  const known = new Set((existing ?? []).filter(s => s.type === 'note').map(s => s.id));
  let segs = existing;
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    const id = `sa-note-${childId}-${i}`;
    if (known.has(id)) continue;
    const seg: SubagentSegment = { type: 'note', id, content: note.text, from: note.from, timestamp: note.at };
    const list = [...(segs ?? [])];
    insertByTime(list, seg);
    segs = list;
    known.add(id);
  }
  return segs;
}

/** Specialists 1c: patch one tool segment (by requestId) inside every Task
 *  card. Returns null when no nested segment holds that requestId. */
function patchNestedAsk(
  toolCalls: Map<string, ToolCallState>,
  requestId: string,
  patch: (seg: Extract<SubagentSegment, { type: 'tool' }>) => Extract<SubagentSegment, { type: 'tool' }>,
  // Also match a running row a resolution already cleared of this id (batch 2: an expiry
  // that follows the resolution must still reach it).
  matchResolved = false,
): Map<string, ToolCallState> | null {
  for (const [id, tool] of toolCalls) {
    const segs = tool.subagentSegments;
    if (!segs) continue;
    const idx = segs.findIndex(s => s.type === 'tool'
      && (s.requestId === requestId || (matchResolved && s.status === 'running' && s.resolvedRequestId === requestId)));
    if (idx < 0) continue;
    const seg = segs[idx] as Extract<SubagentSegment, { type: 'tool' }>;
    const nextSegs = [...segs];
    nextSegs[idx] = patch(seg);
    const out = new Map(toolCalls);
    out.set(id, { ...tool, subagentSegments: nextSegs });
    return out;
  }
  return null;
}

/** A hydrated copy counts as empty when it carries no conversation at all — the blank
 *  slot a window seeds for every session it has heard of. */
function isEmptyCopy(ser: SerializedChatState['sessions'][number][1]): boolean {
  return (ser.timeline?.length ?? 0) === 0 && (ser.assistantTurns?.length ?? 0) === 0;
}

/**
 * Which of the phone's sessions a hydrate leaves as the phone's own copy (remote access
 * batch 2, design §6). The shim turns a non-empty answer into "may be out of date",
 * because a kept session's turn state is only as current as the phone's last event.
 * The ONE definition, used by HYDRATE_CHAT_STATE and by App's report to the shim.
 */
export function keptByHydrate(prev: ChatState, snapshot: SerializedChatState): string[] {
  if (snapshot.sessions.length === 0) return [...prev.keys()];
  if (!snapshot.degraded) return [];
  const replaced = new Set(snapshot.sessions.filter(([, ser]) => !isEmptyCopy(ser)).map(([id]) => id));
  return [...prev.keys()].filter((id) => !replaced.has(id));
}

/**
 * The phone's own unsent actions survive a hydrate (design §6, R2-13): pending user
 * bubbles and queued messages. Only the ones the computer's copy has NOT already echoed
 * — an echo the copy holds would otherwise show twice, because the reducer drops a
 * transcript message whose uuid the copy has already seen, so that pending bubble would
 * never clear.
 *
 * WHICH copy entries are unapplied echoes (T4 review, 4): user entries the phone never
 * saw (by transcript uuid) that come AFTER the last user entry it did see. Counting all
 * entries with the same text broke whenever the two copies had loaded older history to
 * different depths — a phone that scrolled further showed an echoed "yes" twice, and a
 * computer that scrolled further swallowed a freshly typed "continue". Unapplied echoes
 * are consumed oldest-first by pending bubbles, then queued rows, matching text the way
 * TRANSCRIPT_USER_MESSAGE confirms a bubble. A copy from a host that predates the uuid
 * counts every entry, as the phone had nothing better to go on.
 *
 * A first copy (no phone copy yet) adopts NO queued rows: the computer's queue is the
 * computer's own, not an action this phone took (T4 review, 12).
 */
function carryUnsent(prev: SessionChatState | undefined, copy: SessionChatState): SessionChatState {
  if (!prev) return { ...copy, queuedMessages: [] };
  const seen = prev.seenUuids;
  let lastKnown = -1;
  copy.timeline.forEach((e, i) => {
    if (e.kind === 'user' && !e.pending && e.uuid && seen.has(e.uuid)) lastKnown = i;
  });
  const unapplied = new Map<string, number>();
  copy.timeline.forEach((e, i) => {
    if (i <= lastKnown || e.kind !== 'user' || e.pending || e.injected) return;
    if (e.uuid && seen.has(e.uuid)) return;
    unapplied.set(e.message.content, (unapplied.get(e.message.content) ?? 0) + 1);
  });
  const consume = (text: string) => {
    const n = unapplied.get(text) ?? 0;
    if (n <= 0) return false;
    unapplied.set(text, n - 1);
    return true;
  };
  const carried = prev.timeline.filter((e) => e.kind === 'user' && e.pending && !consume(e.message.content));
  const queuedMessages = prev.queuedMessages.filter((q) => !consume(q.content));
  return { ...copy, timeline: carried.length ? [...copy.timeline, ...carried] : copy.timeline, queuedMessages };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  const next = new Map(state);

  switch (action.type) {
    case 'RESET': {
      return new Map();
    }

    case 'HYDRATE_CHAT_STATE': {
      // Fix: an empty snapshot is what the host sends when its renderer times
      // out (chat-snapshot.ts TIMEOUT_MS) or serialization throws — NOT a
      // signal that there are no sessions. Applying it blanked a reconnecting
      // client's entire chat with no error surfaced. Never replace real state
      // with nothing.
      if (action.sessions.sessions.length === 0) {
        console.warn('[chat-reducer] ignoring empty chat:hydrate snapshot');
        return state;
      }
      try {
        const copies = deserializeChatState(action.sessions);
        const hydrated = (s: SessionChatState): SessionChatState => ({ ...s, history: { ...s.history, hydrated: true } });
        // Remote access batch 2 (design §6, R1-1): a COMPLETE copy replaces the whole
        // state — the computer's copy is the only source (§4). An INCOMPLETE one replaces
        // only the sessions it holds with a non-empty copy, keeps the phone's copy of
        // every other and deletes nothing: a window that did not answer must not empty
        // the phone (contract R3). Both keep the phone's own unsent actions, and every
        // delivered session is marked so the phone never loads a first page on top of it.
        if (!action.sessions.degraded) {
          const out: ChatState = new Map();
          for (const [id, ser] of action.sessions.sessions) {
            const merged = carryUnsent(state.get(id), copies.get(id)!);
            // A blank copy is not a delivery (T4 review, 5): a window that gave up loading
            // that conversation's first page sends it empty, and marking it would stop the
            // phone from loading its own.
            out.set(id, isEmptyCopy(ser) ? merged : hydrated(merged));
          }
          return out;
        }
        const out: ChatState = new Map(state);
        for (const [id, ser] of action.sessions.sessions) {
          const copy = copies.get(id)!;
          if (!isEmptyCopy(ser)) out.set(id, hydrated(carryUnsent(state.get(id), copy)));
          else if (!out.has(id)) out.set(id, copy);   // a blank slot, not a delivered copy
        }
        return out;
      } catch (err) {
        console.error('[chat-reducer] HYDRATE_CHAT_STATE deserialize failed:', err);
        return state;
      }
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
        // Exact attachment paths (when provided) so the bubble can pill them
        // even when a path contains spaces. Content stays the space-joined
        // string — the transcript dedup matches on content, don't change it.
        ...(action.attachments?.length ? { attachments: action.attachments } : {}),
      };

      // Task 12: the queued-send branch that used to live here (append a
      // pending+queued bubble without touching turn state) is gone — a
      // queued native send now dispatches QUEUED_MESSAGE_ADDED instead of
      // USER_PROMPT (see InputBar.tsx), which never touches the timeline at
      // all. USER_PROMPT is unconditionally the 'sent' path again.
      next.set(action.sessionId, {
        ...session,
        timeline: [...session.timeline, { kind: 'user', message, pending: true }],
        isThinking: true,
        // A message sent while a reply is still streaming does not end that reply: Claude
        // Code records the message at the next turn boundary, and TRANSCRIPT_USER_MESSAGE
        // starts the new turn then. Clearing the turn here split the streaming reply in
        // two on the sending device only (tests/chat-order-sender-matches-receiver.test.ts).
        currentGroupId: session.currentTurnId ? session.currentGroupId : null,
        currentTurnId: session.currentTurnId,
        // Typing again after a provider error is the retry — clear the banner
        // (attentionState + errorMessage) so a fresh turn starts clean.
        attentionState: 'ok',
        errorMessage: null,
        stallWarning: null,
        // A new turn cannot start already parked.
        stalledSince: null,
        // Parity with TRANSCRIPT_SKILL_INVOKED: a new turn must not inherit the
        // previous one's prefill percentage.
        promptProcessing: null,
      });
      return next;
    }

    // Task 12: native send acked 'queued' — add to the docked-strip list.
    // Deliberately does NOT touch the timeline or turn/group/isThinking state
    // (that was the Task 3/11 bug: an enqueue-time timeline bubble froze
    // above content the still-streaming prior turn hadn't emitted yet).
    case 'QUEUED_MESSAGE_ADDED': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      next.set(action.sessionId, {
        ...session,
        queuedMessages: [
          ...session.queuedMessages,
          { queueId: action.queueId, content: action.content, timestamp: action.timestamp },
        ],
      });
      return next;
    }

    // Task 12 (replaces QUEUED_PROMPT_CANCELED): removes a queuedMessages
    // entry by queueId. Dispatched by the strip's Cancel/Edit handlers on
    // BOTH native:queue-remove outcomes (see App.tsx) — success (the row is
    // genuinely gone) and too-late (the row's counterpart is about to land,
    // or already has landed, in the timeline via TRANSCRIPT_USER_MESSAGE's
    // drain-side removal below, so removing it here too is a harmless
    // possible-no-op that guarantees the strip row doesn't linger). No-op
    // (not an error) when the id isn't found.
    case 'QUEUED_MESSAGE_REMOVED': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      const idx = session.queuedMessages.findIndex((q) => q.queueId === action.queueId);
      if (idx === -1) return state;
      const queuedMessages = [
        ...session.queuedMessages.slice(0, idx),
        ...session.queuedMessages.slice(idx + 1),
      ];
      next.set(action.sessionId, { ...session, queuedMessages });
      return next;
    }

    case 'SHOW_PROMPT': {
      let session = next.get(action.sessionId);
      if (!session) {
        session = createSessionChatState();
        next.set(action.sessionId, session);
      }

      const timeline = appendAbovePending(
        session.timeline.filter((e) => !(e.kind === 'prompt' && e.prompt.promptId === action.promptId)),
        {
          kind: 'prompt',
          prompt: {
            promptId: action.promptId,
            title: action.title,
            description: action.description,
            buttons: action.buttons,
          },
        },
      );

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

    // Native runtime: a provider/stream failure ended the turn. endTurn()
    // resets attentionState to 'ok' and clears errorMessage; we override with
    // 'error' + the message AFTER the spread — same spread-then-override
    // pattern SESSION_PROCESS_EXITED uses for 'session-died'.
    case 'NATIVE_SESSION_ERROR': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      next.set(action.sessionId, {
        ...session,
        ...endTurn(session, action.message),
        attentionState: 'error',
        errorMessage: action.message,
      });
      return next;
    }

    // Step 3 (2026-08-17, broadened): the session's STARTING context — the full
    // accounting the session-start panel renders (system prompt, project
    // instructions as-truncated, skills, tools, dropped MCP servers). Session
    // level (not a timeline entry) so it survives resume. No-op when unchanged.
    case 'SESSION_CONTEXT': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      const ctx = action.context ?? null;
      if (JSON.stringify(session.sessionContext) === JSON.stringify(ctx)) return state;
      next.set(action.sessionId, { ...session, sessionContext: ctx });
      return next;
    }

    // Native model residency changed (loaded/loading/sleeping/unloaded). Purely
    // informational — does NOT touch the turn/attention machinery. Drives the
    // ModelLoadingBar (unloaded → reload; loading → loading indicator).
    case 'NATIVE_MODEL_STATE_CHANGED': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      const loadedBytes = action.loadedBytes ?? null;
      // Latches true the first time the model reaches 'loaded'. The Reload prompt
      // keys on this so a fresh session's initial 'unloaded'/'loading' (before its
      // eager load completes) shows the loading bar, not a spurious Reload button.
      const everResident = session.modelEverResident || action.state === 'loaded';
      // No-op unless state, model, load-progress bytes, OR the ever-resident latch
      // changed (bytes climb while state stays 'loading', and must re-render).
      if (session.modelState === action.state
          && session.modelInfo?.modelId === action.modelId
          && session.modelLoadedBytes === loadedBytes
          && session.modelEverResident === everResident) return state;
      next.set(action.sessionId, {
        ...session,
        modelState: action.state,
        modelInfo: { modelId: action.modelId, sizeBytes: action.sizeBytes },
        modelLoadedBytes: loadedBytes,
        modelEverResident: everResident,
      });
      return next;
    }

    // Plan 2b: another device took over this session's lease. See the inline
    // comment below — as of the "Moved Gate" follow-up this only ends the turn
    // cleanly; the user-facing surface moved to App.tsx's MovedGate.
    case 'SESSION_MOVED': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      // Plan 2b "Moved Gate" (2026-07-14): SESSION_MOVED now ONLY ends the
      // in-flight turn cleanly (endTurn — attention resets to 'ok', NOT a
      // terminal error). It NO LONGER appends a timeline marker: the holder side
      // destroys the session immediately after (SESSION_REMOVE wipes the whole
      // chat state, so any appended marker was deleted back-to-back and never
      // rendered). The user-facing "this session was taken over on <device>"
      // surface is now App.tsx's MovedGate (a full-page gate over the session),
      // driven off the enriched session:moved push — not this reducer.
      next.set(action.sessionId, { ...session, ...endTurn(session) });
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

    case 'TRANSCRIPT_THINKING_HEARTBEAT': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      // Three heartbeat shapes, in descending severity:
      //   stalled     → the turn is parked. RED dot, card on screen.
      //   stallWarning→ stage 1, "may be wrong, I don't know". AMBER dot.
      //   plain       → activity resumed. Clears both.
      //
      // Fix (2026-08-16): the warning branch used to set 'ok', so the dot stayed
      // GREEN for the whole countdown — the app asserting health while telling
      // the user it may be hanging. 'stuck' is the state that means exactly
      // "something may be wrong and I don't know", which is what a warning is.
      const attentionState = action.stalled ? 'stalled'
        : action.stallWarning ? 'stuck'
        : 'ok';
      next.set(action.sessionId, {
        ...session,
        lastActivityAt: Date.now(),
        attentionState,
        stallWarning: action.stallWarning ?? null,
        // Stamped once and held: a repeat heartbeat must not restart the
        // count-up, so an already-parked session keeps its original stamp.
        //
        // Fix (M8, whole-branch review 2026-08-16): the held-stamp rule used to
        // be `session.stalledSince ?? Date.now()` with no check on the state it
        // was held FROM. `stalledSince` is only ever read while attentionState
        // is 'stalled' (AttentionBanner is the sole consumer). Fourteen places
        // in this file write `attentionState: 'ok'` and only five of them also
        // clear the stamp — the other nine (both TRANSCRIPT_USER_MESSAGE
        // branches, both NATIVE_TOOL_PREPARING branches, both TRANSCRIPT_TOOL_USE
        // branches, TRANSCRIPT_TOOL_RESULT, and both PERMISSION_REQUEST
        // branches) leave it set. Any of those landing between two parks left
        // the SECOND card counting from the FIRST park, so a turn that parked,
        // resumed, and parked again would read "no response for 6m 12s" three
        // seconds in. Gating on the state the stamp belongs to fixes the whole
        // family at the ONE place the field is written, instead of adding nine
        // `stalledSince: null` lines and forgetting the tenth.
        stalledSince: action.stalled
          ? (session.attentionState === 'stalled' ? (session.stalledSince ?? Date.now()) : Date.now())
          : null,
        // Same lifetime rule as stallWarning: present on the announcing heartbeat,
        // cleared by the next plain one (which the first real chunk triggers).
        //
        // EXCEPT when this heartbeat is a stall warning or the stalled card:
        // neither carries promptProcessing of its own, and nulling it there
        // wiped the progress readout mid-prefill, so the percentage appeared to
        // reset itself (Destin, 2026-07-26). A stall means "still waiting", not
        // "prefill ended" — the reading it was showing is still the truth.
        promptProcessing: action.promptProcessing
          ?? ((action.stallWarning || action.stalled) ? session.promptProcessing : null),
      });
      return next;
    }

    // Manual stall Retry: erase the abandoned attempt's segments from the
    // current turn BEFORE its re-run streams. Without this the re-run's deltas
    // merge into the same segment by partId and the user reads the half
    // sentence twice — which is exactly why the AUTOMATIC retry has always
    // refused to run after content streamed.
    case 'NATIVE_PARTS_DROPPED': {
      const session = next.get(action.sessionId);
      if (!session || !session.currentTurnId) return state;
      const turn = session.assistantTurns.get(session.currentTurnId);
      if (!turn) return state;
      const drop = new Set(action.partIds);
      // Fix (cross-task review defect): part ids are NOT unique within a turn.
      // The AI SDK's part id falls back to the literal 'text-0' when the
      // provider omits one, and a turn can span multiple steps (each tool
      // call starts a new step), so the SAME id can legitimately appear on
      // an earlier, already-finished step's text as well as on the abandoned
      // attempt being retried. A plain `.filter()` over the whole segment
      // list — the old approach — deletes every match, including finished
      // paragraphs and tool calls the user already read/ran. That is worse
      // than the duplicate-text bug this erase exists to prevent.
      //
      // The abandoned attempt's segments are always the MOST RECENT ones in
      // the turn, so walk from the END and remove only the TRAILING run of
      // matching segments, stopping at the first one that doesn't match.
      // Everything before that boundary is earlier, finished work and must
      // survive untouched — a tool-group (or plan) segment carries no
      // partId at all, so it always counts as non-matching and stops the
      // walk, which is what keeps this safe: a tool-group segment always
      // separates one text step from the next.
      let cut = turn.segments.length;
      while (cut > 0) {
        const seg = turn.segments[cut - 1];
        const matches = (seg.type === 'text' || seg.type === 'reasoning')
          && !!seg.partId && drop.has(seg.partId);
        if (!matches) break;
        cut--;
      }
      const segments = turn.segments.slice(0, cut);
      if (segments.length === turn.segments.length) return state;
      const assistantTurns = new Map(session.assistantTurns);
      assistantTurns.set(session.currentTurnId, { ...turn, segments });
      next.set(action.sessionId, { ...session, assistantTurns });
      return next;
    }

    // --- Transcript watcher actions ---

    case 'TRANSCRIPT_USER_MESSAGE': {
      // Subagent briefing: Claude Code writes the parent's Task prompt as the
      // first user-role line of the subagent's JSONL. The SubagentWatcher
      // stamps those events with parentAgentToolUseId. Drop them here — the
      // briefing is already visible in the parent Agent card's Briefing
      // section, so appending it to the main timeline created a duplicate
      // "message sent by the user" bubble. Mirrors the guard that
      // TRANSCRIPT_ASSISTANT_TEXT / TOOL_USE / TOOL_RESULT already have.
      if (action.parentAgentToolUseId) return state;
      const session = next.get(action.sessionId);
      if (!session) return state;

      // Replay/live dedup: a renderer-crash reload replays this session's
      // transcript from disk while live events still arrive. If this uuid was
      // already applied, drop it — otherwise it appends a duplicate bubble
      // (there is no pending match on the second delivery). See seenUuids.
      if (action.uuid && session.seenUuids.has(action.uuid)) return state;
      const seenUuids = action.uuid
        ? new Set(session.seenUuids).add(action.uuid)
        : session.seenUuids;

      // Task 12 (drain-side removal): independent of whether a pending
      // TIMELINE bubble matches below — clear the OLDEST queuedMessages entry
      // with matching content, if any. WHY independent rather than gated on
      // confirmedIdx: a `sent` message never wrote a queuedMessages entry (no
      // QUEUED_MESSAGE_ADDED fired for it), so this scan simply finds nothing
      // and is a no-op on that path — running it unconditionally is correct,
      // not "unconditionally-but-harmless-because-usually-empty." A `queued`
      // message, symmetrically, never has a pending bubble to match (Task 12
      // stopped writing one), so it can ONLY be found here, never in the
      // confirmedIdx scan — that's what makes the no-pending-match fallback
      // below the sole place a queued message's timeline entry gets created,
      // at its true (end-of-timeline) position. Oldest-content-match mirrors
      // the pending-bubble dedup's own discipline (rapid-fire duplicates).
      //
      // Caveat (review finding, traced all orderings): "the two scans never
      // collide" only holds when contents are DISTINCT across the pending
      // bubble and the queued list. If the SAME text was both sent immediately
      // (a pending bubble) AND separately queued (a list entry) — e.g. "hi"
      // typed twice in a row, once while idle and once while a turn was
      // in-flight — this dispatch's list scan runs unconditionally regardless
      // of WHICH of the two "hi"s this particular transcript event confirms.
      // If it confirms the sent one, the list scan still removes the oldest
      // queued "hi" row from the STRIP even though that queued message's own
      // drain event hasn't arrived on the host yet. The eventual TIMELINE
      // outcome is still correct — that queued message still gets its own
      // TRANSCRIPT_USER_MESSAGE later, finds no pending bubble (already
      // consumed), and appends at the true end-of-timeline position via the
      // fallback below, same as always. The only visible effect is a
      // duplicate-content STRIP ROW disappearing one drain early (an
      // under-count for the span between the two events, not a lost or
      // mis-positioned message) — an acceptable renderer-local display quirk
      // for a scenario the old bubble-badge design had no better answer for
      // either (two identical bubbles were already visually indistinguishable
      // there too).
      let queuedMessages = session.queuedMessages;
      const queuedIdx = queuedMessages.findIndex((q) => q.content === action.text);
      if (queuedIdx !== -1) {
        queuedMessages = [
          ...queuedMessages.slice(0, queuedIdx),
          ...queuedMessages.slice(queuedIdx + 1),
        ];
      }

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
          sameUserMessage(entry.message, action.text)
        ) {
          confirmedIdx = i;
          break;
        }
      }

      if (confirmedIdx >= 0) {
        const entry = session.timeline[confirmedIdx];
        if (entry.kind !== 'user') return state; // type-narrowing safety
        // Confirming clears `pending`. Rebuilt object (rather than spreading
        // entry) so any stale extra field is dropped, not carried forward —
        // this arm only ever matches a `sent`-path bubble (Task 12: a queued
        // send no longer writes one at all), so in practice there's nothing
        // stale to drop today, but the rebuild-not-spread discipline stays.
        const confirmed: TimelineEntry = {
          kind: 'user',
          message: entry.message,
          pending: false,
          uuid: action.uuid,
        };
        // Placed where the transcript recorded it — after everything already confirmed,
        // above the bubbles still waiting — not left where it was drawn at send time
        // (see appendAbovePending).
        const timeline = appendAbovePending(
          [...session.timeline.slice(0, confirmedIdx), ...session.timeline.slice(confirmedIdx + 1)],
          confirmed,
        );
        next.set(action.sessionId, {
          ...session,
          timeline,
          seenUuids,
          queuedMessages,
          // A confirmed slash command leaves the turn state as the send left it (see below).
          ...(action.slashCommand ? {} : {
            isThinking: true,
            currentGroupId: null,
            currentTurnId: null,
            attentionState: 'ok' as const,
          }),
        });
        return next;
      }

      // G-1: a finished background command's notice folds into the Bash card
      // that started it — one turn may carry several (D8). The model still
      // reads this turn, so the turn boundary below is kept; only the bubble
      // is not appended. A record the live push already set is never
      // overwritten (it has the real tail); a missing or still-'running' one
      // is filled from the meta so a resumed transcript reads correctly.
      if (action.injected === 'shell-complete' && action.injectedMeta?.kind === 'shell') {
        const toolCalls = new Map(session.toolCalls);
        let folded = false;
        for (const r of action.injectedMeta.runs) {
          const card = toolCalls.get(r.toolUseId);
          if (!card) continue;
          folded = true;
          if (card.shellRun && card.shellRun.status !== 'running') continue;
          const startedAt = card.shellRun?.startedAt ?? action.timestamp - r.elapsedMs;
          toolCalls.set(r.toolUseId, {
            ...card,
            shellRun: {
              toolUseId: r.toolUseId, shellId: r.shellId,
              status: r.stopReason ? 'stopped' : 'exited', exitCode: r.exitCode, stopReason: r.stopReason,
              detached: card.shellRun?.detached, startedAt, endedAt: startedAt + r.elapsedMs,
              tail: card.shellRun?.tail ?? '', logPath: r.logPath,
            },
          });
        }
        if (folded) {
          next.set(action.sessionId, {
            ...session, toolCalls, seenUuids, queuedMessages,
            isThinking: true, currentGroupId: null, currentTurnId: null, attentionState: 'ok',
          });
          return next;
        }
      }

      // Specialists 1c: a BACKGROUND specialist's delivered report folds back
      // into the Task card that hired it (Destin's 1b directive — background
      // and foreground render alike; the foreground report is that card's
      // tool result). The parent model still reads this turn as its input, so
      // the turn boundary below (isThinking, fresh turn) is kept; only the
      // bubble is not appended. Falls through to the standalone card when the
      // launching Task card is not on this timeline (older sessions, a report
      // replayed without its card).
      // G-1: a shell-complete turn carries the OTHER meta shape and is folded
      // into its Bash card above — never into a specialist card.
      if (action.injected && action.injectedMeta && action.injectedMeta.kind !== 'shell') {
        const cardId = findSpecialistCard(session.toolCalls, {
          parentToolCallId: action.injectedMeta.parentToolCallId,
          childId: action.injectedMeta.childId,
        });
        if (cardId) {
          const card = session.toolCalls.get(cardId)!;
          const toolCalls = new Map(session.toolCalls);
          toolCalls.set(cardId, {
            ...card,
            specialistReport: {
              text: action.text,
              status: action.injectedMeta.status,
              steps: action.injectedMeta.steps,
              timestamp: action.timestamp,
            },
          });
          next.set(action.sessionId, {
            ...session,
            toolCalls,
            seenUuids,
            queuedMessages,
            isThinking: true,
            currentGroupId: null,
            currentTurnId: null,
            attentionState: 'ok',
          });
          return next;
        }
      }

      // Drop the redundant `/compact` echo (see isCompactCommandEcho) while
      // keeping every other effect of the event — turn state, seenUuids, queue
      // drain — since those are what tell the rest of the UI a turn is running.
      // This sits BELOW the confirm arm on purpose: a bubble that already
      // exists optimistically must still be confirmed, or it stays `pending`
      // forever and useSubmitConfirmation fires a stray recovery keystroke.
      // The /clear echo too, when read from its command tags: the clear draws its own marker.
      const suppressBubble = isCompactCommandEcho(action.text)
        || (action.slashCommand === true && /^\/clear(\s|$)/.test(action.text.trim()));

      // No pending match — a queued message being drained (Task 12's true-
      // position confirm: this is the ONLY place its timeline entry gets
      // created, at the end), a remote/replay client, or the user typed
      // directly into the terminal. Append as a new confirmed entry.
      const message = {
        id: nextMessageId(),
        role: 'user' as const,
        content: action.text,
        timestamp: action.timestamp,
      };

      next.set(action.sessionId, {
        ...session,
        // `injected` rides only this append path on purpose: a host-injected
        // turn never has an optimistic pending bubble to confirm (nobody typed
        // it), so it can only ever land here.
        timeline: suppressBubble ? session.timeline : appendAbovePending(session.timeline, {
          kind: 'user', message, pending: false, uuid: action.uuid,
          ...(action.injected ? { injected: action.injected } : {}),
          ...(action.injectedMeta ? { injectedMeta: action.injectedMeta } : {}),
        }),
        seenUuids,
        queuedMessages,
        // A slash command starts no turn: many commands get no reply, and a device that did not
        // send it would stay "thinking" with nothing to end it (2026-09-11 order investigation).
        ...(action.slashCommand ? {} : {
          isThinking: true,
          currentGroupId: null,
          currentTurnId: null,
          // Fresh activity from the transcript → chat view is back in sync,
          // so any stale attention banner should disappear.
          attentionState: 'ok' as const,
        }),
      });
      return next;
    }

    case 'TRANSCRIPT_ASSISTANT_TEXT': {
      // Subagent event: route into the parent Agent tool's nested timeline.
      if (action.parentAgentToolUseId) return applySubagentEvent(state, action);
      const session = next.get(action.sessionId);
      if (!session) return state;

      // Replay/live dedup (see seenUuids): drop a text line already applied.
      // CC uuids are stable per line; native deltas each get a unique uuid, so
      // this only fires on a genuine replay/live overlap — never on distinct
      // streaming deltas (which merge by partId below).
      if (action.uuid && session.seenUuids.has(action.uuid)) return state;
      const seenUuids = action.uuid
        ? new Set(session.seenUuids).add(action.uuid)
        : session.seenUuids;

      // Fix (2026-09-02, bubble grouping): some models stream NEWLINE-ONLY text
      // chunks between and after the tool calls they compose (DeepSeek V4 Flash
      // over OpenRouter, seen live). Each one used to open a new text segment —
      // and every text segment opens a bubble — so three tools in one step
      // rendered as three bubbles, a bare empty bubble followed the last tool,
      // and a stop pressed during the next step's "\n" put "Interrupted." in a
      // bubble of its own. Whitespace that cannot join an open paragraph carries
      // nothing, so it is dropped HERE, at the segment list every renderer
      // (chat, buddy feed, remote) reads — not hidden downstream. Whitespace
      // inside an open paragraph still merges: paragraph breaks must survive.
      // Claude Code's watcher trims whole blocks, so this only fires on the
      // native runtime and on replayed native history. Counted as activity
      // (not output): nothing filled a bubble, so the thinking indicator stays.
      // Pinned by tests/bubble-grouping-scenarios.test.tsx.
      if (isBlankDelta(action.text) && !mergesIntoOpenSegment(session, 'text', action.partId)) {
        next.set(action.sessionId, { ...session, seenUuids, lastActivityAt: Date.now() });
        return next;
      }

      const { assistantTurns, timeline, currentTurnId } = getOrCreateTurn(session);
      const turn = assistantTurns.get(currentTurnId)!;
      // Native runtime: same-partId deltas merge into the last text segment
      // (identical semantics to the reasoning path). No partId → CC's
      // whole-block append, unchanged.
      let segments = turn.segments;
      const lastIdx = segments.length - 1;
      const last = lastIdx >= 0 ? segments[lastIdx] : null;
      if (action.partId && last && last.type === 'text' && last.partId === action.partId) {
        segments = [...segments.slice(0, lastIdx), { ...last, content: last.content + action.text }];
      } else {
        segments = [...segments, { type: 'text', content: action.text, messageId: nextMessageId(), partId: action.partId }];
      }
      // Task 2.4: Capture model on first text of the turn so the model pill is
      // visible while the turn is in-flight. `?? turn.model` preserves the
      // existing value when a later text chunk arrives without a model, so we
      // never clobber a previously-captured model with null.
      assistantTurns.set(currentTurnId, {
        ...turn,
        segments,
        model: action.model ?? turn.model,
      });

      next.set(action.sessionId, {
        ...session, assistantTurns, timeline, currentTurnId, seenUuids,
        currentGroupId: null, // next tool_use creates a new group
        lastActivityAt: Date.now(),
        // Visible OUTPUT arrived (not merely activity). The thinking indicator
        // suppresses itself while this is fresh — a filling bubble is already proof
        // the model is alive, so a spinner beside it is noise.
        lastOutputAt: Date.now(),
        attentionState: 'ok',
        // Real answer text resumed → dismiss any pending stall countdown.
        stallWarning: null,
        stalledSince: null,
        // Output means PREFILL IS OVER. Leaving the readout set let it resurface
        // during any generation pause longer than the indicator's 2s streaming
        // window, showing "Reading your prompt — N%" mid-generation — the exact
        // thing that copy is not supposed to do (2026-07-28 audit).
        promptProcessing: null,
      });
      return next;
    }

    // Streaming reasoning chunk with text payload. Reasoning arrives as
    // per-token deltas merged into one segment by partId — UNLIKE the
    // TRANSCRIPT_ASSISTANT_TEXT path, which appends each event as a whole
    // block in its own new segment.
    case 'TRANSCRIPT_ASSISTANT_REASONING': {
      // Specialists 1c: a child's reasoning goes into its Task card, not here.
      if (action.parentAgentToolUseId) return applySubagentEvent(state, action);
      const session = next.get(action.sessionId);
      if (!session) return state;

      // Same whitespace rule as TRANSCRIPT_ASSISTANT_TEXT above: a blank
      // reasoning chunk that cannot join open reasoning would render as a
      // "Show reasoning" toggle over nothing.
      if (isBlankDelta(action.text) && !mergesIntoOpenSegment(session, 'reasoning', action.partId)) {
        next.set(action.sessionId, { ...session, lastActivityAt: Date.now() });
        return next;
      }

      const { assistantTurns, timeline, currentTurnId } = getOrCreateTurn(session);
      const turn = assistantTurns.get(currentTurnId)!;
      let segments = turn.segments;
      const lastIdx = segments.length - 1;
      const last = lastIdx >= 0 ? segments[lastIdx] : null;
      if (
        action.partId
        && last
        && last.type === 'reasoning'
        && last.partId === action.partId
      ) {
        const merged = { ...last, content: last.content + action.text };
        segments = [...segments.slice(0, lastIdx), merged];
      } else {
        segments = [
          ...segments,
          { type: 'reasoning', content: action.text, messageId: nextMessageId(), partId: action.partId },
        ];
      }
      assistantTurns.set(currentTurnId, { ...turn, segments });

      next.set(action.sessionId, {
        ...session, assistantTurns, timeline, currentTurnId,
        currentGroupId: null,
        lastActivityAt: Date.now(),
        // Visible OUTPUT arrived (not merely activity). The thinking indicator
        // suppresses itself while this is fresh — a filling bubble is already proof
        // the model is alive, so a spinner beside it is noise.
        lastOutputAt: Date.now(),
        attentionState: 'ok',
        // Real reasoning resumed → dismiss any pending stall countdown.
        stallWarning: null,
        stalledSince: null,
        // Same as the text path: reasoning IS output, so prefill has ended.
        promptProcessing: null,
      });
      return next;
    }

    case 'NATIVE_TOOL_PREPARING': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      const toolCalls = new Map(session.toolCalls);
      const existing = toolCalls.get(action.toolCallId);

      if (action.cleared) {
        // Withdraw a card the stall retry abandoned. No-op unless the entry is
        // still preparing — a real tool card must never be removed here.
        const toolGroups = new Map(session.toolGroups);
        const assistantTurns = new Map(session.assistantTurns);
        if (!removePreparingTool(toolCalls, toolGroups, assistantTurns, action.toolCallId)) {
          return state;
        }
        const activeTurnToolIds = new Set(session.activeTurnToolIds);
        activeTurnToolIds.delete(action.toolCallId);
        next.set(action.sessionId, {
          ...session, toolCalls, toolGroups, assistantTurns, activeTurnToolIds,
          lastActivityAt: Date.now(),
        });
        return next;
      }

      if (existing) {
        // Progress update only. Never touch status, group, or position — the
        // card's identity and slot must survive until the real tool-use lands.
        if (!existing.preparing) return state;
        toolCalls.set(action.toolCallId, { ...existing, preparingChars: action.chars });
        next.set(action.sessionId, { ...session, toolCalls, lastActivityAt: Date.now(), attentionState: 'ok' });
        return next;
      }

      // input:{} because ToolCallState.input is non-optional; the real input
      // arrives with TRANSCRIPT_TOOL_USE, which overwrites this entry wholesale.
      toolCalls.set(action.toolCallId, {
        toolUseId: action.toolCallId,
        toolName: action.toolName,
        input: {},
        status: 'running',
        preparing: true,
        preparingChars: action.chars,
      });
      const { assistantTurns, timeline, toolGroups, currentGroupId, currentTurnId } =
        placeToolInCurrentGroup(session, action.toolCallId);
      const activeTurnToolIds = new Set(session.activeTurnToolIds);
      activeTurnToolIds.add(action.toolCallId);
      next.set(action.sessionId, {
        ...session, toolCalls, toolGroups, assistantTurns, timeline,
        currentGroupId, currentTurnId, activeTurnToolIds,
        lastActivityAt: Date.now(),
        attentionState: 'ok',
      });
      return next;
    }

    case 'TRANSCRIPT_TOOL_USE': {
      // Subagent event: route into the parent Agent tool's nested timeline.
      if (action.parentAgentToolUseId) return applySubagentEvent(state, action);
      const session = next.get(action.sessionId);
      if (!session) return state;

      const toolCalls = new Map(session.toolCalls);

      // Check for a synthetic permission entry (perm-*) that matches this tool.
      // When the hook arrives before the transcript, a synthetic entry is created
      // with awaiting-approval status. Replace it with the real tool, preserving
      // the permission state and group placement.
      // Fix: a placeholder ANSWERED before the transcript caught up must still
      // be reclaimed. PERMISSION_RESPONDED returns it to 'running', which used
      // to make this merge condition false forever — the placeholder was never
      // replaced, so no TRANSCRIPT_TOOL_RESULT (keyed on the real toolUseId)
      // could ever close it, and it sat 'running' for the rest of the session
      // catching every later PERMISSION_REQUEST of the same name via that
      // matcher's tier-2 fallback and rendering ITS old input.
      // Prefer an identical-input placeholder so two same-name asks in flight
      // can't reclaim each other's card.
      // An ANSWERED placeholder is only reclaimed on an exact input match. Its
      // requestId is already spent, so name alone cannot tell "the tool_use I
      // am still waiting for" from "a later same-name call" — and reclaiming
      // the wrong one would delete the earlier card and drop the later tool
      // into its timeline slot. A still-awaiting placeholder keeps the original
      // name-only fallback: its requestId is live, so it IS the pending ask.
      let syntheticFirst: string | null = null;
      let syntheticExact: string | null = null;
      const incomingInput = action.toolInput ? stableStringify(action.toolInput) : null;
      for (const [synId, synTool] of toolCalls) {
        if (!synId.startsWith('perm-')) continue;
        if (synTool.toolName !== action.toolName) continue;
        const answered = synTool.status === 'running';
        if (synTool.status !== 'awaiting-approval' && !answered) continue;
        const exact = incomingInput !== null && synTool.input
          && stableStringify(synTool.input) === incomingInput;
        if (exact) { syntheticExact = synId; break; }
        if (!answered && syntheticFirst === null) syntheticFirst = synId;
      }
      const reclaimId = syntheticExact ?? syntheticFirst;

      let mergedSynthetic = false;
      for (const [synId, synTool] of toolCalls) {
        if (synId === reclaimId) {
          // Replace synthetic with real tool, preserving permission state
          toolCalls.delete(synId);
          toolCalls.set(action.toolUseId, {
            toolUseId: action.toolUseId,
            toolName: action.toolName,
            input: action.toolInput,
            status: synTool.status,
            requestId: synTool.requestId,
            // Batch 2: a resolution recorded on the synthetic card survives the real
            // tool-use replacing it — the note, and the id a later expiry needs.
            answeredElsewhere: synTool.answeredElsewhere,
            resolvedRequestId: synTool.resolvedRequestId,
            permissionSuggestions: synTool.permissionSuggestions,
            denyListed: synTool.denyListed,
            // Carried for the same reason as denyListed: ToolCard gates the
            // "Always allow" button on it, so losing it here would re-offer a
            // grant the engine can never honor.
            external: synTool.external,
            // Carried so the full-auto safety-stop footer survives the
            // synthetic→real tool-id handover (spec 2026-08-12, M5 2b).
            permissionMode: synTool.permissionMode,
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

      // Fix (2026-08-16, Specialists 1b Test 1 hang — a master bug from the
      // preparing-card merge, not specialist-specific): a preparing card is
      // placed under the REAL tool id with status 'running', and the ask for
      // that very call can bind to it BEFORE this event lands — main emits
      // tool-use then the ask, but the renderer batches transcript events into
      // an animation frame while hook events dispatch immediately, so the
      // reducer sees NATIVE_TOOL_PREPARING → PERMISSION_REQUEST →
      // TRANSCRIPT_TOOL_USE. Overwriting wholesale here reset the card to
      // 'running' and dropped its requestId: no Allow/Deny buttons ever
      // rendered, and the turn hung on an ask nobody could answer. Carry the
      // ask over exactly as the synthetic-reclaim branch above does; every
      // other superseded card (no ask yet) still becomes a plain running tool.
      const superseded = toolCalls.get(action.toolUseId);
      const carriedAsk = superseded?.status === 'awaiting-approval' && superseded.requestId
        ? {
            status: 'awaiting-approval' as const,
            requestId: superseded.requestId,
            permissionSuggestions: superseded.permissionSuggestions,
            denyListed: superseded.denyListed,
            external: superseded.external,
            permissionMode: superseded.permissionMode,
          }
        : { status: 'running' as const, answeredElsewhere: superseded?.answeredElsewhere, resolvedRequestId: superseded?.resolvedRequestId };
      toolCalls.set(action.toolUseId, {
        toolUseId: action.toolUseId,
        toolName: action.toolName,
        input: action.toolInput,
        ...carriedAsk,
      });

      // Placement is idempotent by toolUseId (see placeToolInCurrentGroup), so
      // a re-emit — or a preparing card the native runtime already placed under
      // this same id — is superseded IN PLACE rather than duplicated.
      const placed = placeToolInCurrentGroup(session, action.toolUseId);
      let { assistantTurns } = placed;
      const { timeline, toolGroups, currentGroupId, currentTurnId } = placed;

      // ExitPlanMode: inject plan markdown as its own bubble BEFORE the
      // tool-group, so the full plan is visible in chat view (not just the
      // approval buttons). injectPlanSegment is idempotent by toolUseId, and
      // splices before the group it is given, so placing first is safe.
      if (action.toolName === 'ExitPlanMode') {
        assistantTurns = injectPlanSegment(
          assistantTurns,
          currentTurnId,
          action.toolUseId,
          action.toolInput,
          currentGroupId ?? undefined,
        );
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
      // Subagent event: route into the parent Agent tool's nested timeline.
      if (action.parentAgentToolUseId) return applySubagentEvent(state, action);
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

      // Count edited lines ONCE. A tool-result can be delivered twice (a
      // renderer reload replays the transcript while the live stream is still
      // arriving — see seenUuids' comment), and Map.set absorbs the duplicate
      // silently, so the guard is "this call had no patch yet", not a uuid.
      //
      // Fix (Finding 1, 2026-08-26): also require `existing` itself, not just
      // `!existing?.structuredPatch`. If the tool-use for this id was never
      // observed (a dropped/malformed transcript line, which this codebase
      // treats as real — see the watcher re-emit comments above), `existing`
      // is undefined and the old guard was vacuously true on EVERY delivery,
      // so a duplicate of an orphan result counted its lines twice. A rare
      // missed orphan now contributes an incomplete number; a duplicate would
      // have invented one — and this whole feature exists to stop the status
      // bar showing numbers that aren't true.
      const totals = existing && action.structuredPatch && !existing.structuredPatch
        ? addPatchLines(session.totals, action.structuredPatch)
        : session.totals;

      next.set(action.sessionId, {
        ...session, toolCalls, totals, lastActivityAt: Date.now(),
        attentionState: 'ok',
      });
      return next;
    }

    case 'TRANSCRIPT_SKILL_INVOKED': {
      const session = state.get(action.sessionId);
      if (!session) return state;
      // Dedup on uuid like every other transcript-fed entry: this event replays
      // on resume, and a second card would imply the skill ran twice.
      if (session.seenUuids?.has(action.uuid)) return state;
      const next = new Map(state);
      next.set(action.sessionId, {
        ...session,
        seenUuids: new Set([...(session.seenUuids ?? []), action.uuid]),
        // A skill invocation IS a turn start, so it must set the same state
        // TRANSCRIPT_USER_MESSAGE does — otherwise nothing tells the UI a turn
        // began and the thinking indicator, prompt-processing progress and stall
        // watchdog all stay dormant while the model works (Destin, 2026-07-28:
        // "needs to act as a user message and begin the thinking indicator").
        isThinking: true,
        currentGroupId: null,
        currentTurnId: null,
        attentionState: 'ok',
        // Cleared here, unlike TRANSCRIPT_USER_MESSAGE, because a typed message
        // gets these cleared a beat earlier by USER_PROMPT's optimistic dispatch.
        // A skill has no optimistic path, so without this a stale error banner or
        // stall warning would sit on top of a healthy new turn.
        errorMessage: null,
        stallWarning: null,
        // A skill invocation is a new turn start — same reasoning as above.
        stalledSince: null,
        // Belt-and-braces: a previous turn's prefill progress must not be
        // mistaken for this turn's (the next assistant-thinking event replaces it).
        promptProcessing: null,
        timeline: appendAbovePending(session.timeline, {
          kind: 'skill-invocation' as const,
          id: `skill-${action.uuid}`,
          skillId: action.skillId,
          displayName: action.displayName,
          ...(action.args ? { args: action.args } : {}),
          ...(action.skillPath ? { skillPath: action.skillPath } : {}),
          timestamp: action.timestamp,
        }),
      });
      return next;
    }

    case 'TRANSCRIPT_TURN_COMPLETE': {
      // A sub-agent's end_turn must NOT reach into parent state. Without
      // this guard the parent turn's `model` gets overwritten with the
      // sub-agent's model (the status-bar pill silently flips, and the
      // drift-reconciliation effect in App.tsx persists it via
      // setPreference), and endTurn() prematurely tears down the parent's
      // in-flight turn — flagging the still-running Task tool as failed
      // and tripping the attention banner. Mirrors the same guard on
      // TRANSCRIPT_ASSISTANT_TEXT / TOOL_USE / TOOL_RESULT above. We don't
      // delegate to applySubagentEvent here because a sub-agent's end_turn
      // produces no visible nested segment — the parent's own tool-result
      // for the Task tool is what completes the agent in the UI.
      if (action.parentAgentToolUseId) return state;
      const session = next.get(action.sessionId);
      if (!session) return state;

      // Attach completion metadata to the completing turn before clearing
      // turn-scoped state via endTurn(). currentTurnId is the in-flight turn;
      // if it's already null (turn-complete arrived before any assistant
      // content), an ABNORMAL stopReason mints a segment-less turn to carry
      // it — see below. Resolve WHICH turn gets stamped first, then stamp
      // once, so the mint path can never drift from the normal path's field
      // policy (it did, briefly: `model: action.model` vs `?? turn.model`).
      // Shared predicate (chat-types.ts): the mint below and the render gates
      // must agree on what "abnormal" means, or a minted turn gets dropped —
      // or a droppable one minted.
      const abnormalStop = abnormalStopReason(action.stopReason);
      let assistantTurns = new Map(session.assistantTurns);
      let timeline = session.timeline;
      let seenUuids = session.seenUuids;
      let targetTurnId = session.currentTurnId;
      let mintedTimestamp: number | null = null;
      if (!targetTurnId && abnormalStop && !session.seenUuids.has(action.uuid)) {
        // Empty-step recovery (spec 2026-08-21, decision 4): assistant turns
        // are minted by CONTENT actions, so a turn whose every step was
        // contentless has no entry to carry its honest stopReason — the
        // worst-case shape of the empty_response bug would still render as
        // unexplained silence. Create the (segment-less) turn here so the
        // footer has something to attach to. Normal completions keep the
        // long-standing skip: an end_turn with no content carries no signal
        // worth a timeline row.
        // The seenUuids guard keeps this branch IDEMPOTENT: the watcher's
        // re-emit contract and re-dock replay both re-deliver turn-complete
        // (readNewLines: "the reducer absorbs them"), and content actions are
        // uuid-deduped on replay so currentTurnId stays null — without the
        // guard every replay would append a fresh ghost turn + timeline row.
        const created = getOrCreateTurn(session);
        assistantTurns = created.assistantTurns;
        timeline = created.timeline;
        targetTurnId = created.currentTurnId;
        // Replay delivers the original event: stamp the turn with the event's
        // own time, not Date.now() (which would show the re-dock time).
        mintedTimestamp = action.timestamp;
      }
      // Recorded for the stamp path, the mint path AND the totals below.
      //
      // Originally this was `if (abnormalStop)`: a live abnormal completion
      // stamped onto a content turn must not re-mint as a ghost when the same
      // event replays into existing state (content actions get deduped, so the
      // replayed turn-complete arrives with currentTurnId null).
      //
      // It is now unconditional, because the totals accumulation below needs
      // the same protection and normal end_turn is the common case. The
      // watcher's re-emit contract and re-dock replay both RE-DELIVER
      // turn-complete (readNewLines: "the reducer absorbs them"), and
      // addTurnUsage is not idempotent — a re-dock would have added the turn's
      // tokens a second time. That was latent until now only because nothing
      // read a Claude Code session's totals; the In:/Out:/Cached: chips do.
      // Widening the set cannot disturb the mint branch, which additionally
      // requires abnormalStop.
      const alreadyCounted = session.seenUuids.has(action.uuid);
      seenUuids = alreadyCounted ? seenUuids : new Set(session.seenUuids).add(action.uuid);
      if (targetTurnId) {
        const turn = assistantTurns.get(targetTurnId);
        if (turn) {
          assistantTurns.set(targetTurnId, {
            ...turn,
            stopReason: action.stopReason,
            // Preserve any model already captured on the turn (e.g. from
            // assistant-text in Task 2.4) — only override when the action
            // carries one. The two should agree when both are present.
            model: action.model ?? turn.model,
            anthropicRequestId: action.anthropicRequestId,
            usage: action.usage,
            ...(mintedTimestamp !== null ? { timestamp: mintedTimestamp } : {}),
          });
        }
      }

      // Session totals (spec §2). A SUBAGENT's turn-complete is skipped on
      // purpose: a specialist's spend arrives once, as a subagent-usage event
      // carrying the whole run (native-session-host.ts), and counting both
      // would double it. Everything else — including a Claude Code turn,
      // which carries no costUsd and so contributes tokens only — accumulates.
      //
      // Fix (Finding 3, 2026-08-26): this used to be a ternary keyed on
      // `action.parentAgentToolUseId`, but that branch can never be true here —
      // the identical `if (action.parentAgentToolUseId) return state;` guard at
      // the top of this case already exits before this line is ever reached. A
      // specialist's own turn-complete never reaches here. This matters because
      // a later change will deliver a specialist's whole run as its own event;
      // counting both that event AND a (currently impossible) subagent
      // turn-complete here would double a user's tokens and cost.
      // `alreadyCounted` (above) is what makes this safe to run on a replayed
      // event: the tokens are added exactly once per turn uuid, no matter how
      // many times the watcher re-delivers it.
      const totals = alreadyCounted ? session.totals : addTurnUsage(session.totals, action.usage ?? {});

      next.set(action.sessionId, { ...session, timeline, seenUuids, totals, ...endTurn(session, undefined, assistantTurns) });
      return next;
    }

    // One finished specialist's TOTAL spend, folded into the PARENT's totals
    // (spec §2). This is the other half of the WHY block just above: the
    // child's own turn-complete is never counted, so this event is where a
    // delegated run's tokens and dollars enter the numbers — exactly once.
    //
    // Deliberately does NOT delegate to applySubagentEvent even though it
    // carries parentAgentToolUseId. That helper builds the nested CARD's
    // segments; this event has nothing to draw. It is bookkeeping, not
    // conversation: no timeline entry, no turn state touched, so a background
    // specialist that finishes between the parent's turns cannot end a turn
    // that isn't running.
    case 'TRANSCRIPT_SUBAGENT_USAGE': {
      const session = state.get(action.sessionId);
      // ORPHAN guard: a report for a session this window doesn't hold changes
      // nothing, and must never MINT one — a ghost conversation whose only
      // content is a dollar figure would be worse than a missing number.
      // Returning `state` itself (not the `next` copy) keeps the
      // useSyncExternalStore snapshot referentially stable on a no-op.
      if (!session) {
        // Task 23 item 3. Dropping this silently loses a real dollar figure:
        // the specialist's tokens and cost are then counted NOWHERE, and the
        // parent's total is quietly short with nothing to trace it back to.
        // It should be impossible (SESSION_INIT runs before any transcript
        // event reaches the reducer), so if it ever happens this line is the
        // only trace anyone will have.
        //
        // WHY here and NOT on the dedup branch below: a second delivery of the
        // same report is EXPECTED — a resume replays the parent's record while
        // the live stream may still be delivering. Warning there would print
        // during ordinary healthy use, which is how a warning stops being read.
        console.warn(`[chat] subagent-usage arrived for session ${action.sessionId}, which this window does not hold — that specialist's tokens and cost are counted nowhere`);
        return state;
      }
      // Task 25 item 3 — deliberately silent, unlike the missing-session branch
      // above. emitSubagentUsage types `usage` as required, so a missing one is
      // not a lost dollar figure: it is a malformed or legacy persisted event
      // that never carried tokens or cost to begin with. Nothing to count means
      // nothing to warn about — this is not a fourth silent hole.
      if (!action.usage) return state;
      // DEDUP on uuid: resume replays the parent's whole record while the live
      // stream may still be delivering, and counting one specialist twice
      // would double the session's reported cost.
      if (session.seenUuids.has(action.uuid)) return state;
      next.set(action.sessionId, {
        ...session,
        totals: addSubagentUsage(session.totals, action.usage),
        seenUuids: new Set(session.seenUuids).add(action.uuid),
      });
      return next;
    }

    case 'TRANSCRIPT_INTERRUPT': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      // User interrupted (ESC or equivalent): mirror TRANSCRIPT_TURN_COMPLETE
      // but hardcode stopReason='interrupted' so the AssistantTurnBubble
      // footer renders "Interrupted" under the affected turn. Then endTurn()
      // clears turn-scoped state and flips in-flight tools in this turn to
      // failed with error 'Turn interrupted' (vs. 'Turn ended' for normal
      // completion) so the tool card distinguishes user-cancelled.
      const interruptingTurnId = session.currentTurnId;
      const assistantTurns = new Map(session.assistantTurns);
      if (interruptingTurnId) {
        const turn = assistantTurns.get(interruptingTurnId);
        if (turn) {
          assistantTurns.set(interruptingTurnId, {
            ...turn,
            stopReason: 'interrupted',
          });
        }
      }

      next.set(action.sessionId, {
        ...session,
        ...endTurn(session, 'Turn interrupted', assistantTurns),
      });
      return next;
    }

    case 'TRANSCRIPT_REPLAY_COMPLETE': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      // A live re-dock replays the same history while a tool is genuinely
      // running. Only main can tell the two apart, and only for native
      // sessions (`entry.inFlight`); it reports false when it cannot affirm
      // idleness, so an unknown session is left exactly as it was.
      // G-1 (spec §5.7): applied whether or not the session is idle — it only
      // touches cards that got NO live record from the replay just before this.
      const orphaned = markOrphanedShellRuns(session.toolCalls);
      const withShells = orphaned ? { ...session, toolCalls: orphaned } : session;
      if (!action.sessionIdle) {
        if (!orphaned) return state;
        next.set(action.sessionId, withShells);
        return next;
      }
      // Reuse endTurn rather than inventing a second notion of "tool that never
      // finished" — it fails orphaned running/awaiting cards AND clears the
      // in-flight turn state (isThinking, currentTurnId), which replay had left
      // looking like a live turn.
      // The message is deliberately not "complete": we do not know whether the
      // tool finished before the process died, and a card claiming success for
      // work that may never have run is the misleading-success failure
      // docs/error-message-standards.md exists to prevent.
      // NOTE the asymmetry with NATIVE_SESSION_ERROR, which spreads endTurn()
      // and then RE-ASSERTS attentionState/errorMessage. This spread does not,
      // so it resets attentionState to 'ok' and clears errorMessage — which
      // would wipe an error banner and unblock the input gate
      // (pty-input-gate.ts keys on attentionState !== 'ok').
      // Safe today only because no replay lands on a session holding an error:
      // onOwnershipLost dispatches SESSION_REMOVE, which deletes the state, so
      // every re-dock replays into a fresh slot. If that ever changes, this
      // needs the same re-assert NATIVE_SESSION_ERROR does.
      next.set(action.sessionId, {
        ...withShells,
        ...endTurn(withShells, 'Session was closed while this was running'),
      });
      return next;
    }

    case 'PERMISSION_REQUEST': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      // Specialists 1c: an ask a specialist CHILD raised nests under the Task
      // card that hired it — never a top-level card, and never bound to one of
      // the PARENT's own running tools by name (a background child's Bash ask
      // arriving while the parent runs its own Bash would otherwise hijack
      // the parent's card: a consent bug). Same two-tier match as below, but
      // over the card's segments; unmatched → a synthetic `sa-perm-` segment
      // the child's real tool-use event reclaims (applySubagentEvent).
      if (action.specialist) {
        const cardId = findSpecialistCard(session.toolCalls, {
          parentToolCallId: action.specialist.parentToolCallId,
          childId: action.specialist.childId,
        });
        if (cardId) {
          const card = session.toolCalls.get(cardId)!;
          const segs = card.subagentSegments ? [...card.subagentSegments] : [];
          if (segs.some(s => s.type === 'tool' && s.requestId === action.requestId)) return state;
          const wanted = action.input ? stableStringify(action.input) : null;
          let inputIdx = -1;
          let nameIdx = -1;
          for (let i = 0; i < segs.length; i++) {
            const seg = segs[i];
            if (seg.type !== 'tool' || seg.status !== 'running' || seg.toolName !== action.toolName) continue;
            if (nameIdx === -1) nameIdx = i;
            if (wanted !== null && stableStringify(seg.input) === wanted) { inputIdx = i; break; }
          }
          const askFields = {
            status: 'awaiting-approval' as const,
            requestId: action.requestId,
            denyListed: action.denyListed,
            external: action.external,
            permissionMode: action.permissionMode,
          };
          const target = inputIdx >= 0 ? inputIdx : nameIdx;
          if (target >= 0) {
            const seg = segs[target] as Extract<SubagentSegment, { type: 'tool' }>;
            segs[target] = {
              ...seg,
              ...askFields,
              ...(target === nameIdx && inputIdx === -1 && action.input && Object.keys(action.input).length > 0
                ? { input: action.input } : {}),
            };
          } else {
            segs.push({
              type: 'tool',
              id: `sa-perm-${action.requestId}`,
              toolUseId: `sa-perm-${action.requestId}`,
              toolName: action.toolName,
              input: action.input,
              ...askFields,
            });
          }
          const toolCalls = new Map(session.toolCalls);
          toolCalls.set(cardId, { ...card, subagentSegments: segs });
          next.set(action.sessionId, { ...session, toolCalls, attentionState: 'ok' });
          return next;
        }
        // No card to nest under (a routed ask replayed onto a timeline without
        // its Task card) — fall through to the top-level path rather than lose
        // an answerable ask. It still says who asked, via ToolCard's specialist
        // label (the action's specialist field is preserved on the card).
      }

      // Find the matching running tool. Match order, most → least specific:
      //   1. same name AND identical input — disambiguates parallel same-name
      //      tools (e.g. two Bash calls in one batch). Without it the approval
      //      card rendered tool A's input while its buttons approved tool B's
      //      command.
      //   2. first running tool with the same name (hook payload and
      //      transcript input shapes can differ — degrade safely)
      // There is deliberately NO name-agnostic third tier. Until 2026-08-09 an
      // `anyRunningId` fallback bound the ask to the first running tool of ANY
      // name, so an ask that arrived before its own tool_use event hijacked an
      // unrelated card: the card kept saying "Bash" while its buttons approved
      // Read (Destin, M1–M3 dogfood). That fallback was the ORIGINAL naive
      // implementation — its own comment called it "the arbitrary
      // first-running-tool fallback" — and tiers 1 and 2 were added in front of
      // it without ever removing it, so it was vestigial, not load-bearing.
      // Showing one tool's identity on a card that authorizes another is a
      // CONSENT bug: the honest fallback is the synthetic card below, which
      // describes the ask's own payload and is reclaimed by TRANSCRIPT_TOOL_USE
      // when the real event lands.
      // (An older requestId pass was unreachable — a running tool never carried
      // a requestId; PERMISSION_RESPONDED clears it. That is no longer quite
      // true: a card whose ask was overwritten keeps the requestId while
      // reverting to 'running', which is exactly the stale binding the loop
      // directly below detects and clears.)
      const toolCalls = new Map(session.toolCalls);

      // This action is REPEATABLE (2026-08-16): main re-announces every
      // still-pending ask on a heartbeat, so a card that never rendered — or
      // that a later event overwrote — heals itself instead of hanging the turn
      // forever on an ask nobody can answer. Two consequences, both handled
      // here BEFORE the match loop, because the loop only ever looks at
      // 'running' tools and cannot see either case:
      //   • Already bound and awaiting → nothing to do. Return `state` itself
      //     (not a rebuilt Map): a fresh object every few seconds would
      //     re-render the timeline for no change.
      //   • Held by a card in any OTHER status → that binding is stale, and
      //     tier 2 (name-only) would otherwise hand this same requestId to a
      //     SECOND running card, putting Allow/Deny on two cards for one ask.
      //     Drop the dead requestId so the match below can re-bind cleanly.
      for (const [id, tool] of toolCalls) {
        if (tool.requestId !== action.requestId) continue;
        if (tool.status === 'awaiting-approval') return state;
        toolCalls.set(id, { ...tool, requestId: undefined });
      }

      let inputMatchId: string | null = null;
      let nameMatchId: string | null = null;
      const wantedInput = action.input ? stableStringify(action.input) : null;
      for (const [id, tool] of toolCalls) {
        if (tool.status !== 'running') continue;
        if (tool.toolName === action.toolName) {
          if (nameMatchId === null) nameMatchId = id;
          if (wantedInput !== null && tool.input
              && stableStringify(tool.input) === wantedInput) {
            inputMatchId = id;
            break;
          }
        }
      }
      const targetId = inputMatchId ?? nameMatchId;
      let found = false;
      if (targetId !== null) {
        const tool = toolCalls.get(targetId)!;
        toolCalls.set(targetId, {
          ...tool,
          status: 'awaiting-approval',
          requestId: action.requestId,
          // A new ask on this card: the previous one's "answered elsewhere" note is
          // about a different question (T2 review, 10).
          answeredElsewhere: undefined,
          resolvedRequestId: undefined,
          // Fix: the card must show the input THIS request is about. Tier 2
          // binds to a card matched only by NAME, so its input belongs to an
          // earlier call — that is how the second AskUserQuestion of a session
          // re-displayed the first one's question and options while the
          // terminal showed the correct one. For AskUserQuestion this is a
          // correctness bug, not just a cosmetic one: AskUserQuestionCard
          // echoes tool.input.questions back in updatedInput.
          // Both surviving tiers match on tool NAME, so this only ever refreshes
          // the input of a card that already names the right tool. (This clause
          // used to carry a carve-out for a name-agnostic third tier; that tier
          // was deleted 2026-08-09 — see the match-order comment above.)
          // hook-dispatcher defaults a missing tool_input to `{}`, so require a
          // non-empty payload or we would blank out a good card.
          ...(targetId === nameMatchId && inputMatchId === null
              && action.input && Object.keys(action.input).length > 0
                ? { input: action.input } : {}),
          permissionSuggestions: action.permissionSuggestions,
          denyListed: action.denyListed,
          external: action.external,
          permissionMode: action.permissionMode,
          ...(action.specialist ? { specialist: action.specialist } : {}),
        });
        found = true;
      }

      if (!found) {
        // (The "never synthesize a SECOND placeholder for a requestId we
        // already hold" guard that used to live here moved ABOVE the match
        // loop in the 2026-08-16 heartbeat change — it has to run before tier 2
        // can bind a second card, not only when tier 2 misses. By this line
        // nothing holds action.requestId: it was either returned early as an
        // intact ask, or cleared as a stale binding.)

        // Permission hook arrived before transcript watcher — create synthetic tool entry
        const syntheticId = `perm-${action.requestId}`;
        toolCalls.set(syntheticId, {
          toolUseId: syntheticId,
          toolName: action.toolName,
          input: action.input,
          status: 'awaiting-approval',
          requestId: action.requestId,
          permissionSuggestions: action.permissionSuggestions,
          denyListed: action.denyListed,
          external: action.external,
          permissionMode: action.permissionMode,
          ...(action.specialist ? { specialist: action.specialist } : {}),
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

      // Specialists 1c: the answered ask may be nested in a Task card.
      {
        const nested = patchNestedAsk(session.toolCalls, action.requestId, (seg) => ({
          ...seg, status: 'running', requestId: undefined, askHeld: undefined,
        }));
        if (nested) { next.set(action.sessionId, { ...session, toolCalls: nested }); return next; }
      }

      const toolCalls = new Map(session.toolCalls);
      // Deliberately NO clearing of an "answered elsewhere" note here (T2 re-review, 2):
      // every answering device BROADCASTS this action, and on a watching device it lands
      // after the host's resolution — the note is true there. The answering device never
      // gets the note in the first place: a native ask's resolution is hidden by the shim
      // while the answer is in flight, and a Claude Code ask replies first.
      for (const [id, tool] of toolCalls) {
        if (tool.status === 'awaiting-approval' && tool.requestId === action.requestId) {
          // Fix: native budget gates (max_steps / doom_loop) are synthetic asks
          // with NO real tool execution behind them — no TRANSCRIPT_TOOL_RESULT
          // ever arrives to close the card. Leaving it 'running' orphans it, and
          // endTurn() then force-fails it 'Turn ended' on a normal finish.
          // (This used to also cite PERMISSION_REQUEST's tier-3 "first running
          // tool of any name" fallback reusing the stale card. That tier was
          // deleted 2026-08-09 — see the match-order comment in
          // PERMISSION_REQUEST. The carve-out below is still needed for the
          // endTurn reason alone.)
          // Close it 'complete' on any response instead (PERMISSION_RESPONDED
          // can't tell Yes from No — it carries only the requestId). Keyed on
          // toolName, not the perm- id prefix, which would wrongly close real
          // tools whose hook merely beat the transcript.
          const isBudgetGate = tool.toolName === 'max_steps' || tool.toolName === 'doom_loop';
          toolCalls.set(id, { ...tool, status: isBudgetGate ? 'complete' : 'running', requestId: undefined });
          break;
        }
      }

      next.set(action.sessionId, { ...session, toolCalls });
      return next;
    }

    case 'PERMISSION_EXPIRED': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      // Specialists 1c: nested variant of the same expiry.
      {
        const nested = patchNestedAsk(session.toolCalls, action.requestId, (seg) => ({
          ...seg,
          status: 'failed',
          requestId: undefined,
          resolvedRequestId: undefined,
          error: 'This request closed before an answer reached it.', // was transport jargon that also claimed no answer was sent — tests/permission-expired-wording.test.ts
        }), /* matchResolved */ true);
        if (nested) { next.set(action.sessionId, { ...session, toolCalls: nested }); return next; }
      }

      const toolCalls = new Map(session.toolCalls);
      for (const [id, tool] of toolCalls) {
        const heldHere = tool.status === 'awaiting-approval' && tool.requestId === action.requestId;
        // T2 review (2): a cancelled native ask arrives as Resolved THEN Expired, and the
        // resolution has already moved the card to running with the "answered" note. The
        // expiry is the truth — nobody answered — so it must still reach that card.
        // Matched by the kept id alone: a desktop window clears a resolution silently (no
        // note), and the expiry must reach that card too.
        const clearedByResolution = tool.status === 'running' && tool.resolvedRequestId === action.requestId;
        if (heldHere || clearedByResolution) {
          toolCalls.set(id, {
            ...tool,
            status: 'failed',
            requestId: undefined,
            // The note and the kept id go with the truth: nobody answered (T2 review).
            answeredElsewhere: undefined,
            resolvedRequestId: undefined,
            error: 'This request closed before an answer reached it.', // was transport jargon that also claimed no answer was sent — tests/permission-expired-wording.test.ts
          });
          break;
        }
      }

      next.set(action.sessionId, { ...session, toolCalls });
      return next;
    }

    case 'PERMISSION_RESOLVED_ELSEWHERE':
    case 'PERMISSION_REPLAY_COMPLETE': {
      // Remote access batch 2 (§7, "consent does not lie"): an ask the computer
      // (or another phone) answered while this client could not see it. The
      // card goes back to 'running' with `answeredElsewhere` — the same shape an
      // overwritten ask takes (see PERMISSION_REQUEST's stale-binding loop) —
      // never 'failed', never a message about a socket: nothing failed, and no
      // socket closed. The result arrives through the transcript or a Refresh.
      const session = next.get(action.sessionId);
      if (!session) return state;
      const single = action.type === 'PERMISSION_RESOLVED_ELSEWHERE' ? action.requestId : null;
      const silent = action.type === 'PERMISSION_RESOLVED_ELSEWHERE' && action.silent === true;
      const pending = action.type === 'PERMISSION_REPLAY_COMPLETE' ? new Set(action.pendingRequestIds) : null;
      const isResolved = (requestId: string | undefined) =>
        !!requestId && (single !== null ? requestId === single : !pending!.has(requestId));

      let toolCalls: Map<string, ToolCallState> | null = null;
      // Nested (specialist) asks first — same clearing PERMISSION_RESPONDED does.
      if (single !== null) {
        const nested = patchNestedAsk(session.toolCalls, single, (seg) => ({
          ...seg, status: 'running', requestId: undefined, askHeld: undefined, resolvedRequestId: seg.requestId,
        }));
        if (nested) { next.set(action.sessionId, { ...session, toolCalls: nested }); return next; }
      }
      for (const [id, tool] of session.toolCalls) {
        if (tool.status !== 'awaiting-approval' || !isResolved(tool.requestId)) continue;
        toolCalls ??= new Map(session.toolCalls);
        // A budget gate has no tool behind it and no result coming — close it, as
        // PERMISSION_RESPONDED does, so endTurn cannot fail it later.
        const isBudgetGate = tool.toolName === 'max_steps' || tool.toolName === 'doom_loop';
        toolCalls.set(id, {
          ...tool,
          status: isBudgetGate ? 'complete' : 'running',
          requestId: undefined,
          answeredElsewhere: isBudgetGate || silent ? undefined : true,
          resolvedRequestId: isBudgetGate ? undefined : tool.requestId,
        });
      }
      // Replay-complete covers nested specialist asks too (T2 review, 8): a nested ask
      // answered while the phone was away must not keep live-looking buttons.
      if (pending) {
        for (const tool of session.toolCalls.values()) {
          for (const seg of tool.subagentSegments ?? []) {
            if (seg.type !== 'tool' || seg.status !== 'awaiting-approval' || !seg.requestId || pending.has(seg.requestId)) continue;
            const patched = patchNestedAsk(toolCalls ?? session.toolCalls, seg.requestId, (s) => ({
              ...s, status: 'running', requestId: undefined, askHeld: undefined, resolvedRequestId: s.requestId,
            }));
            if (patched) toolCalls = patched;
          }
        }
      }
      if (!toolCalls) return state;                 // nothing was awaiting: same reference, no re-render
      next.set(action.sessionId, { ...session, toolCalls });
      return next;
    }

    case 'PERMISSION_HELD': {
      // Specialists 1c: the 5-minute hold elapsed — the ask stays answerable,
      // the row just says the helper carried on without it.
      const session = next.get(action.sessionId);
      if (!session) return state;
      const nested = patchNestedAsk(session.toolCalls, action.requestId, (seg) => ({ ...seg, askHeld: true }));
      if (!nested) return state;
      next.set(action.sessionId, { ...session, toolCalls: nested });
      return next;
    }

    case 'SHELL_RUN_CHANGED': {
      // Background Bash (G-1): the run record lands on the Bash card that
      // started it, keyed by toolUseId. The card must already exist (the tool
      // use precedes every run event); a record for an unknown card is dropped.
      const session = next.get(action.sessionId);
      if (!session) return state;
      const card = session.toolCalls.get(action.run.toolUseId);
      if (!card) return state;
      const toolCalls = new Map(session.toolCalls);
      toolCalls.set(card.toolUseId, { ...card, shellRun: action.run });
      next.set(action.sessionId, { ...session, toolCalls });
      return next;
    }
    case 'SPECIALIST_RUN_CHANGED': {
      // Specialists 1c: the ledger record lands on the launching Task card.
      // The card must already exist (the Task tool-use event precedes every
      // ledger write, and replay splices child events after it) — a record for
      // an unknown card is dropped, not parked, same as applySubagentEvent.
      const session = next.get(action.sessionId);
      if (!session) return state;
      const cardId = findSpecialistCard(session.toolCalls, {
        parentToolCallId: action.run.parentToolCallId,
        childId: action.run.childId,
      });
      if (!cardId) return state;
      const card = session.toolCalls.get(cardId)!;
      // Task 11 short-circuit: the delivery bookkeeping (claim / mark-
      // attempted / confirm / release) legitimately rewrites the ledger
      // record and fires the change listener on EVERY step of that cycle,
      // but toRunView (main process) strips those delivery-only fields before
      // it ever reaches here — so one delivery cycle can push up to four
      // byte-identical views. Absorb them here (reducer), not at the emit
      // path, by comparing the incoming view to what the card already holds
      // and returning the SAME state object when nothing actually changed.
      // stableStringify (key-order-independent) is this file's existing
      // idiom for structural comparison — reused rather than adding a deps.
      //
      // ROADMAP L259: `seq` is bumped on EVERY projection, so it must be
      // excluded from that structural comparison or the short-circuit above
      // would never fire again. It is compared separately, just below.
      if (card.specialistRun && stableStringify(withoutSeq(action.run)) === stableStringify(withoutSeq(card.specialistRun))) {
        return state;
      }
      // ROADMAP L259: every push overwrites the WHOLE run record, and until
      // now the reducer applied whichever arrived LAST — so a stale
      // specialists:event landing after a newer one for the same run (a
      // replay-then-live race, or a slow IPC hop) could revert a card that
      // already read "completed" back to "running", with nothing later to
      // correct it. `seq` is monotonic per projection, so an incoming view
      // that is not strictly newer than what the card holds is a straggler.
      // Both sides must carry a stamp: a card replayed from a build without
      // one cannot be ordered, and refusing an update there would freeze it.
      if (
        card.specialistRun
        && action.run.seq !== undefined
        && card.specialistRun.seq !== undefined
        && action.run.seq <= card.specialistRun.seq
      ) {
        return state;
      }
      const toolCalls = new Map(session.toolCalls);
      toolCalls.set(cardId, {
        ...card,
        specialistRun: action.run,
        agentId: card.agentId ?? action.run.childId,
        agentType: card.agentType ?? action.run.agentType,
        // Task 10: notes moved from a dedicated steer action onto the run
        // record itself (spec: one 'run' event, no separate 'note' kind). The
        // ledger always sends the FULL notes list, so this rebuilds the
        // Activity-trail 'note' segments from it rather than appending one at
        // a time — reconcileNoteSegments skips any note already present.
        subagentSegments: reconcileNoteSegments(card.subagentSegments, action.run.notes, action.run.childId),
      });
      next.set(action.sessionId, { ...session, toolCalls });
      return next;
    }

    // --- Paged history (perf cycle 2) ------------------------------------
    // Replaces HISTORY_LOADED, which fetched the WHOLE transcript behind a "See
    // previous messages" button and rebuilt it as flat `hist-` bubbles with no
    // tool cards. Pages carry real TranscriptEvents, so a card from history is
    // byte-for-byte a card from the live stream.

    case 'HISTORY_PAGE_REQUESTED': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      next.set(action.sessionId, { ...session, history: { ...session.history, loading: true } });
      return next;
    }

    case 'HISTORY_PAGE_FAILED': {
      // Keep the cursor: the page is still there, the fetch just failed, and the
      // sentinel will retry when the user scrolls.
      const session = next.get(action.sessionId);
      if (!session) return state;
      next.set(action.sessionId, { ...session, history: { ...session.history, loading: false } });
      return next;
    }

    case 'HISTORY_PAGE_LOADED': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      // Build this page's own timeline on a SCRATCH state by replaying its
      // events through the very same per-event cases the live path uses, then
      // prepend. Nothing here knows how to render a tool card or a turn — it
      // reuses what already does, which is why a paged card cannot drift from a
      // live one.
      //
      // Ids stay counter-based (nextMessageId/nextTurnId/nextGroupId are module
      // counters that only ever increase), so a prepended page can never collide
      // with what is already on screen even though it is OLDER.
      let scratch: ChatState = new Map();
      // Seed the scratch state's seenUuids from the LIVE session so the
      // per-event handlers' existing uuid dedup fires during the replay.
      // Without this a message that is already on screen — one the user sent a
      // moment ago, now also present in the transcript the page was read from —
      // is rebuilt on the empty scratch and PREPENDED as a second bubble.
      // (Caught by the perf rig's native-chat screenshot: two identical prompts.)
      scratch.set(action.sessionId, { ...createSessionChatState(), seenUuids: new Set(session.seenUuids) });
      for (const ev of action.events) {
        const pageAction = pageEventToAction(ev);
        if (pageAction) scratch = chatReducer(scratch, pageAction);
      }
      const pageSess = scratch.get(action.sessionId)!;

      next.set(action.sessionId, {
        ...session,
        timeline: [...pageSess.timeline, ...session.timeline],
        // Union the maps page-first so a live entry always wins over a replayed
        // one for the same key (it is the fresher of the two).
        toolCalls: new Map([...pageSess.toolCalls, ...session.toolCalls]),
        toolGroups: new Map([...pageSess.toolGroups, ...session.toolGroups]),
        assistantTurns: new Map([...pageSess.assistantTurns, ...session.assistantTurns]),
        seenUuids: new Set([...session.seenUuids, ...pageSess.seenUuids]),
        // Fold in what this page counted. session-totals' contract was "rebuilt
        // for free when a resumed session replays its record", which paging
        // broke — the scratch replay accumulates the page's usage and it would
        // otherwise be thrown away, so a resumed session showed no totals at all.
        totals: mergeTotals(session.totals, pageSess.totals),
        history: { cursor: action.cursor, hasMore: action.hasMore, loading: false },
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
        timeline: appendAbovePending(session.timeline, { kind: 'usage-card', snapshot: action.snapshot }),
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
      // Native auto-compaction (action.auto) has no compactionPending to satisfy —
      // it fired spontaneously, not from /compact — so it bypasses this guard. For
      // the manual/CC path the guard still drops stale/spurious events (notably CC
      // resume-from-summary, which must NOT insert a marker).
      if (!session.compactionPending && !action.auto) return state; // Stale event — ignore
      const before = session.compactionPending?.beforeContextTokens ?? null;
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
              // Attaches the CC-produced summary text so the otherwise-thin
              // marker can click-to-expand inline. Absent on aborted/watchdog
              // completions (no summary available).
              ...(action.summary ? { summary: action.summary } : {}),
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
        timeline: appendAbovePending(session.timeline, { kind: 'copy-picker', id: action.id, options: action.options }),
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
        // APPEND the boundary — do not replace the timeline. Clearing resets the
        // MODEL'S context, not the user's ability to read what they said
        // (Destin, 2026-07-28: "/clear ... seems to completely wipe the visible
        // timeline ... we should ensure it works like /compact and leaves the
        // messages visible but faded"). /compact already had the right shape:
        // keep everything, mark the boundary, fade what is no longer in context.
        // ChatView renders entries above a 'clear' marker exactly as it renders
        // entries above a 'compact' one.
        //
        // This also de-fangs the reason CLEAR_TIMELINE was called irreversible:
        // nothing is destroyed, so a clear the runtime later refuses costs a
        // stray marker rather than a conversation.
        timeline: [
          ...session.timeline,
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

    // Same divider shape as CLEAR_TIMELINE, just for a typed `/model <alias>`
    // command — see slash-command-dispatcher.ts for why this never touches
    // isThinking (the command is Claude-Code-local and never produces a turn
    // to end one with).
    case 'MODEL_SWITCH_MARKER': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      next.set(action.sessionId, {
        ...session,
        timeline: [
          ...session.timeline,
          {
            kind: 'system-marker',
            marker: {
              id: action.markerId,
              timestamp: action.timestamp,
              label: action.label,
              variant: 'model',
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
