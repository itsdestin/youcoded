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
// Two kinds of prose line, and the difference matters:
//   `text`           — a fixture-only annotation for the tool gallery. NOT dispatched;
//                      it exists to label a tool card, not to be part of a timeline.
//   `assistant_text` — a real assistant turn. Dispatched as TRANSCRIPT_ASSISTANT_TEXT,
//                      alongside `user_message` -> USER_PROMPT, so a conversation
//                      fixture replays the same action sequence a live session
//                      produces (spec §3.3).
// `loadFixture` returns those dispatched actions in `LoadResult.actions` for the
// workbench to replay into the live reducer on boot.

import { chatReducer } from '../../state/chat-reducer';
import type { ChatState, ChatAction, ToolCallState } from '../../state/chat-types';

const SANDBOX_SESSION_ID = 'sandbox';

// ChatState is a Map<string, SessionChatState> (chat-types.ts:357), so an
// empty Map is the initial state. SESSION_INIT seeds the session — without it,
// TRANSCRIPT_TOOL_USE/RESULT bail out because `session` is missing.
function makeInitialState(sessionId: string): ChatState {
  return chatReducer(new Map(), { type: 'SESSION_INIT', sessionId });
}

export type FixtureBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: ToolCallState };

export interface LoadResult {
  blocks: FixtureBlock[];
  /** Every action this loader dispatched, in order. The workbench replays these
   *  into the live reducer on boot (seed-chat.ts) — the same action sequence a
   *  real session produces, so reducer drift surfaces here automatically
   *  (spec §3.3). Must stay complete: an action dispatched but not pushed makes
   *  the replayed timeline differ from the one built here. */
  actions: ChatAction[];
  error?: string;
}

export interface LoadOptions {
  /**
   * Replay `{"type":"stalled"}` lines. **Off by default**, and that default is
   * the fix for M9 (whole-branch review, 2026-08-16): the stalled line lived
   * unconditionally in `native.jsonl`, which is the SHARED native-session
   * fixture every workbench scenario shows, so every scenario opened with the
   * red "Provider may have stalled" card sitting over the one native
   * conversation — including the scenarios being reviewed for something else
   * entirely. The parked card is now something you switch ON (the workbench
   * toolbar's "Stalled turn" toggle → `?stalled=1`) when you want to look at
   * it. A skipped stalled line leaves the rest of the fixture intact, so the
   * default view is the same conversation, just not parked.
   */
  includeStalled?: boolean;
  /** Replay `{"type":"session_error", "optIn":"planLimit", …}` lines — the
   *  used-up-ChatGPT-plan card (design 2026-09-04). Off by default for the same
   *  reason as `includeStalled`: the chatgpt fixture is the shared ChatGPT
   *  session, and an error card over it belongs to one review, not every one.
   *  `?planLimit=1` turns it on. A session_error line with no `optIn` always
   *  replays. */
  includePlanLimit?: boolean;
}

// Fixed base timestamp, not Date.now(): fixtures must replay identically on
// every load, and a moving clock makes bubble grouping non-reproducible.
const FIXTURE_T0 = 1_753_800_000_000;

/** A fixture line's own `timestamp` (epoch ms) when it has one, else the
 *  synthetic clock every other action here uses — one second per action, so
 *  fixture order IS time order and a note's `at` can be placed among rows. */
function fixtureTime(parsed: { timestamp?: unknown; elapsedMs?: unknown }, index: number): number {
  // `elapsedMs` anchors a line to LOAD time — "this happened N ms ago" — the
  // same trick a RUNNING specialist_run record uses below, and for the same
  // reason: a Claude Code subagent card takes its start time from its first
  // stamped segment, so a fixed FIXTURE_T0 makes a still-working helper read
  // "Working · 9680h 0m" instead of a plausible runtime. Settled records keep
  // fixed stamps and stay reproducible.
  if (typeof parsed.elapsedMs === 'number') return Date.now() - parsed.elapsedMs;
  return typeof parsed.timestamp === 'number' ? parsed.timestamp : FIXTURE_T0 + index * 1000;
}

/**
 * @param sessionId Which session the emitted actions target. Defaults to the
 *   sandbox id for the tool gallery; the workbench passes a real seeded session
 *   so the replayed actions land on the timeline the strip is showing. Stamping
 *   it here rather than rewriting actions afterwards keeps each action a
 *   well-typed member of the ChatAction union — a `{...a, sessionId}` spread
 *   widens it into something TS will not accept.
 */
export function loadFixture(
  name: string,
  raw: string,
  sessionId: string = SANDBOX_SESSION_ID,
  opts: LoadOptions = {},
): LoadResult {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);

  try {
    let state = makeInitialState(sessionId);
    const blocks: FixtureBlock[] = [];
    const actions: ChatAction[] = [];

    for (const line of lines) {
      const parsed = JSON.parse(line);

      if (parsed.type === 'text' && typeof parsed.text === 'string') {
        // Text lines are fixture annotations only — append directly, no reducer.
        blocks.push({ kind: 'text', text: parsed.text });
      } else if (parsed.type === 'user_message' && typeof parsed.text === 'string') {
        // WHY USER_PROMPT and not TRANSCRIPT_USER_MESSAGE: the optimistic path
        // is the one a live session takes first, and it is what puts the bubble
        // on the timeline. See desktop/CLAUDE.md "Chat View Data Flow" #3.
        // Field is `content`, not `text` (chat-types.ts:319-326).
        const action: ChatAction = {
          type: 'USER_PROMPT',
          sessionId,
          content: parsed.text,
          timestamp: FIXTURE_T0 + actions.length * 1000,
        };
        state = chatReducer(state, action);
        actions.push(action);
      } else if (parsed.type === 'turn_complete') {
        // Without this a seeded conversation is frozen MID-TURN: the thinking
        // chip ("Contemplating…") and the stop button stay up forever, which
        // the landing page's live embed showed to every visitor. Mirrors
        // App.tsx's 'turn-complete' dispatch (metadata null — a fixture has none).
        const action: ChatAction = {
          type: 'TRANSCRIPT_TURN_COMPLETE',
          sessionId,
          uuid: `${name}-end-${actions.length}`,
          timestamp: FIXTURE_T0 + actions.length * 1000,
          // `stopReason` lets a fixture end abnormally (max_tokens, refusal…)
          // so the footer under the last bubble can be reviewed.
          stopReason: typeof parsed.stopReason === 'string' ? parsed.stopReason : 'end_turn',
          model: null,
          anthropicRequestId: null,
          usage: null,
        };
        state = chatReducer(state, action);
        actions.push(action);
      } else if (parsed.type === 'assistant_text' && typeof parsed.text === 'string') {
        const action: ChatAction = {
          type: 'TRANSCRIPT_ASSISTANT_TEXT',
          sessionId,
          uuid: `${name}-txt-${actions.length}`,
          text: parsed.text,
          timestamp: FIXTURE_T0 + actions.length * 1000,
          // Native runtime streams per-delta with a partId (same id → merge
          // into the open segment). Omit it for Claude Code's whole-block
          // shape. Bubble-grouping fixtures (fixtures/bubbles/) need the
          // native shape to reproduce the newline-chunk splitting bug.
          ...(typeof parsed.partId === 'string' ? { partId: parsed.partId } : {}),
        };
        state = chatReducer(state, action);
        actions.push(action);
      } else if (parsed.type === 'assistant_reasoning' && typeof parsed.text === 'string') {
        // The model's chain of thought (native runtime) — the collapsed
        // "Show reasoning" disclosure at the top of a bubble.
        const action: ChatAction = {
          type: 'TRANSCRIPT_ASSISTANT_REASONING',
          sessionId,
          uuid: `${name}-rsn-${actions.length}`,
          text: parsed.text,
          timestamp: FIXTURE_T0 + actions.length * 1000,
          ...(typeof parsed.partId === 'string' ? { partId: parsed.partId } : {}),
        };
        state = chatReducer(state, action);
        actions.push(action);
      } else if (parsed.type === 'interrupt') {
        // The user pressed Stop. Mirrors App.tsx's 'user-interrupt' dispatch:
        // the open turn gets stopReason 'interrupted' (the "Interrupted."
        // footer) and in-flight tools fail with 'Turn interrupted'.
        const action: ChatAction = {
          type: 'TRANSCRIPT_INTERRUPT',
          sessionId,
          uuid: `${name}-int-${actions.length}`,
          timestamp: FIXTURE_T0 + actions.length * 1000,
          kind: 'plain',
        };
        state = chatReducer(state, action);
        actions.push(action);
      } else if (parsed.type === 'stalled') {
        // Parks the turn so the stalled card can be looked at in the workbench.
        // No backend involved — this is the same action the native heartbeat
        // produces, replayed through the real reducer.
        //
        // OPT-IN (see LoadOptions.includeStalled). Skipped rather than removed
        // from the fixture so the parked turn stays one toolbar toggle away
        // instead of needing the fixture edited back in by hand.
        if (!opts.includeStalled) continue;
        const action: ChatAction = {
          type: 'TRANSCRIPT_THINKING_HEARTBEAT',
          sessionId,
          stalled: true,
        };
        state = chatReducer(state, action);
        actions.push(action);
      } else if (parsed.type === 'session_error' && typeof parsed.text === 'string') {
        // The provider failed the turn: same action App dispatches for a
        // 'session-error' transcript event, replayed through the real reducer
        // so the error banner (and its plan-limit variant) is reviewable.
        if (parsed.optIn === 'planLimit' && !opts.includePlanLimit) continue;
        const action: ChatAction = { type: 'NATIVE_SESSION_ERROR', sessionId, message: parsed.text };
        state = chatReducer(state, action);
        actions.push(action);
      } else if (parsed.type === 'session_context') {
        // Step 3 (2026-08-17, broadened): a session's STARTING context. Replays
        // the same SESSION_CONTEXT action the host will fire, so the session
        // context panel + strip render in the workbench through the real
        // reducer. Works for cloud (full) and local (trimmed) sessions alike.
        const action: ChatAction = {
          type: 'SESSION_CONTEXT',
          sessionId,
          context: parsed.context ?? null,
        };
        state = chatReducer(state, action);
        actions.push(action);
      } else if (parsed.type === 'tool_use') {
        const action: ChatAction = {
          type: 'TRANSCRIPT_TOOL_USE',
          sessionId,
          uuid: `${name}-use-${parsed.id}`,
          toolUseId: parsed.id,
          toolName: parsed.name,
          toolInput: parsed.input ?? {},
          // Review fix (2026-09-04, F5): stamped like the text/interrupt lines
          // above so a specialist card mocked here can show a note interleaved
          // with its rows — the fixture's own time when a line carries one,
          // else the same synthetic clock the other actions use.
          timestamp: fixtureTime(parsed, actions.length),
        };
        state = chatReducer(state, action);
        actions.push(action);
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
          sessionId,
          uuid: `${name}-res-${parsed.tool_use_id}`,
          toolUseId: parsed.tool_use_id,
          result: content,
          isError: parsed.is_error === true,
        };
        state = chatReducer(state, action);
        actions.push(action);
        // Emit the tool block in fixture source order (not reducer-map order).
        const session = state.get(sessionId);
        const tool = session?.toolCalls.get(parsed.tool_use_id);
        if (tool) blocks.push({ kind: 'tool', tool });
      } else if (parsed.type === 'permission_request') {
        // WHY: the awaiting-approval state is the ONE tool-card state no
        // tool_result can express — the tool is paused waiting on the user, so
        // there's no result line to key off of. We synthesize the same
        // PERMISSION_REQUEST action the hook relay fires in a live session so
        // the sandbox renders the real approval card (Yes / No / Always-allow).
        // The reducer pairs a request to a RUNNING tool by name+input (not by
        // id), so we recover those from the tool_use line the fixture just
        // dispatched (looked up by tool_use_id) and hand them to the action.
        const before = state.get(sessionId);
        const pending = before?.toolCalls.get(parsed.tool_use_id);
        const action: ChatAction = {
          type: 'PERMISSION_REQUEST',
          sessionId,
          toolName: pending?.toolName ?? parsed.tool_name ?? 'Bash',
          input: (pending?.input as Record<string, unknown>) ?? {},
          requestId: parsed.requestId,
          // denyListed:true → the destructive-deny-list rule won; ToolCard
          // gates the "Always allow" strip behind a consequence warning.
          denyListed: parsed.denyListed === true,
        };
        state = chatReducer(state, action);
        actions.push(action);
        // awaiting-approval is a TERMINAL fixture state (no tool_result
        // follows), so emit the block here — the tool keeps its original
        // tool_use_id when a running tool is matched in place.
        const after = state.get(sessionId);
        const tool = after?.toolCalls.get(parsed.tool_use_id);
        if (tool) blocks.push({ kind: 'tool', tool });
      } else if (parsed.type === 'subagent_text' || parsed.type === 'subagent_thinking') {
        // Specialists 1c: a child's stamped text/reasoning → nested segment on
        // the parent Task card (`parent` = the Task tool_use id).
        // fixtureTime, not the raw synthetic clock, so these lines can carry
        // `elapsedMs` like the tool lines below — a running helper's segments
        // have to sit near NOW or its card states a runtime in years.
        const at = fixtureTime(parsed, actions.length);
        const action: ChatAction = parsed.type === 'subagent_text'
          ? {
              type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId,
              uuid: `${name}-satxt-${actions.length}`, text: parsed.text,
              timestamp: at,
              parentAgentToolUseId: parsed.parent,
            }
          : {
              type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId,
              uuid: `${name}-sathk-${actions.length}`, text: parsed.text,
              timestamp: at,
              parentAgentToolUseId: parsed.parent,
            };
        state = chatReducer(state, action);
        actions.push(action);
      } else if (parsed.type === 'subagent_tool_use') {
        const action: ChatAction = {
          type: 'TRANSCRIPT_TOOL_USE', sessionId,
          uuid: `${name}-sause-${parsed.id}`, toolUseId: parsed.id,
          toolName: parsed.name, toolInput: parsed.input ?? {},
          timestamp: fixtureTime(parsed, actions.length), // as for tool_use above (F5)
          parentAgentToolUseId: parsed.parent,
        };
        state = chatReducer(state, action);
        actions.push(action);
      } else if (parsed.type === 'subagent_tool_result') {
        const content = typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed.content);
        const action: ChatAction = {
          type: 'TRANSCRIPT_TOOL_RESULT', sessionId,
          uuid: `${name}-sares-${parsed.tool_use_id}`, toolUseId: parsed.tool_use_id,
          result: content, isError: parsed.is_error === true,
          parentAgentToolUseId: parsed.parent,
        };
        state = chatReducer(state, action);
        actions.push(action);
      } else if (parsed.type === 'subagent_permission_request') {
        // Specialists 1c: a CHILD's routed ask. Nests under the parent Task
        // card (specialist.parentToolCallId) — the reducer binds it to the
        // running segment named by tool_use_id, else mints a placeholder.
        const before = state.get(sessionId);
        const parentCard = before?.toolCalls.get(parsed.parent);
        const seg = parentCard?.subagentSegments?.find(
          (x) => x.type === 'tool' && x.toolUseId === parsed.tool_use_id,
        ) as Extract<import('../../../shared/types').SubagentSegment, { type: 'tool' }> | undefined;
        const action: ChatAction = {
          type: 'PERMISSION_REQUEST', sessionId,
          toolName: seg?.toolName ?? parsed.tool_name ?? 'Bash',
          input: seg?.input ?? parsed.input ?? {},
          requestId: parsed.requestId,
          denyListed: parsed.denyListed === true,
          external: parsed.external === true,
          permissionMode: parsed.permissionMode,
          specialist: { ...parsed.specialist, parentToolCallId: parsed.parent },
        };
        state = chatReducer(state, action);
        actions.push(action);
        if (parsed.held === true) {
          const heldAction: ChatAction = { type: 'PERMISSION_HELD', sessionId, requestId: parsed.requestId };
          state = chatReducer(state, heldAction);
          actions.push(heldAction);
        }
      } else if (parsed.type === 'specialist_run' && parsed.run) {
        // A RUNNING record's elapsed time is inherently live — the card ticks
        // against the wall clock — so a fixed startedAt would read "9189h" by
        // the time anyone looks. `elapsedMs` (default 90s) anchors it to load
        // time; settled records keep their fixed timestamps and stay
        // reproducible. The one deliberate non-determinism in this loader.
        const run = parsed.run.status === 'running'
          ? { ...parsed.run, startedAt: Date.now() - (parsed.run.elapsedMs ?? 90_000) }
          : parsed.run;
        delete run.elapsedMs;
        const action: ChatAction = { type: 'SPECIALIST_RUN_CHANGED', sessionId, run };
        state = chatReducer(state, action);
        actions.push(action);
      } else if (parsed.type === 'shell_run') {
        // Background Bash (G-1): the live run record for a Bash card. The
        // fixture gives `startedAgoMs` / `ranForMs` so the elapsed time reads
        // naturally whenever the gallery is opened.
        const startedAt = Date.now() - (parsed.startedAgoMs ?? 0);
        const action: ChatAction = {
          type: 'SHELL_RUN_CHANGED', sessionId,
          run: {
            toolUseId: parsed.tool_use_id, shellId: parsed.shellId ?? 'sh-1',
            status: parsed.status ?? 'running', exitCode: parsed.exitCode,
            stopReason: parsed.stopReason, detached: parsed.detached === true,
            startedAt, endedAt: parsed.ranForMs != null ? startedAt + parsed.ranForMs : undefined,
            tail: parsed.tail ?? '', logPath: parsed.logPath ?? '/tmp/youcoded-harness-bash-output/s1/bash-1.txt',
          },
        };
        state = chatReducer(state, action);
        actions.push(action);
      } else if (parsed.type === 'specialist_report') {
        // Specialists 1c: the host-injected user-role turn carrying a
        // BACKGROUND report — folds into the launching Task card.
        const action: ChatAction = {
          type: 'TRANSCRIPT_USER_MESSAGE', sessionId,
          uuid: `${name}-rep-${actions.length}`, text: parsed.text,
          timestamp: FIXTURE_T0 + actions.length * 1000,
          injected: 'specialist-report',
          injectedMeta: {
            childId: parsed.childId, title: parsed.title, agentType: parsed.agentType,
            description: parsed.description, status: parsed.status ?? 'completed',
            steps: parsed.steps, parentToolCallId: parsed.parent,
          },
        };
        state = chatReducer(state, action);
        actions.push(action);
      }
      // Unknown types are silently skipped (same policy as before).
    }

    // Specialists 1c: a block captured at tool_result time can go stale — a
    // background Task card's result is only the launch ack, and later lines
    // (child events, run records, the folded report) keep changing that card.
    // Re-read every tool block from the FINAL state so the gallery renders the
    // card as the timeline would. A no-op for fixtures nothing touches later.
    const finalSession = state.get(sessionId);
    const refreshed = blocks.map((b) =>
      b.kind === 'tool' && finalSession?.toolCalls.get(b.tool.toolUseId)
        ? { kind: 'tool' as const, tool: finalSession.toolCalls.get(b.tool.toolUseId)! }
        : b,
    );

    // A `tool_use` with no matching `tool_result`/`permission_request` line
    // never got a block above (the "wait for the matching tool_result" skip),
    // so a genuinely still-running tool — no approval needed, just mid-flight —
    // was silently invisible in the gallery; there was no fixture shape for
    // "spinner, no result yet" at all. Anything left over in toolCalls at the
    // end IS that state, so append it here. Appended in call order (a Map
    // preserves insertion order), not interleaved with its original text
    // line — good enough for "still running" fixtures, which put it last.
    const seenIds = new Set(refreshed.filter((b): b is Extract<FixtureBlock, { kind: 'tool' }> => b.kind === 'tool').map((b) => b.tool.toolUseId));
    const stillRunning: FixtureBlock[] = [];
    for (const tool of finalSession?.toolCalls.values() ?? []) {
      if (!seenIds.has(tool.toolUseId) && tool.status === 'running') {
        stillRunning.push({ kind: 'tool', tool });
      }
    }

    return { blocks: [...refreshed, ...stillRunning], actions };
  } catch (err) {
    return {
      blocks: [],
      actions: [],
      error: `parse error in ${name}: ${(err as Error).message}`,
    };
  }
}
