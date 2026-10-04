import type { TranscriptEvent } from '../../shared/types';
import type { ChatAction } from './chat-types';
import { clearDividerId } from '../../shared/divider-ids';

/**
 * ONE transcript event -> the reducer actions that draw it.
 *
 * This is the single translator behind three screens that used to each keep a
 * hand-mirrored copy (and drifted: the buddy once missed `replay-complete`, and
 * once the tool timestamp):
 *  - the main window's live stream (App.tsx), `live: true`;
 *  - the buddy window's live stream (BubbleFeed.tsx), `live: true`, through the SAME
 *    listener (state/screen-feed.ts); it skips no event type;
 *  - a history page read off disk (`pageEventToAction`), `live: false`.
 *
 * Pure on purpose: no store, no refs, no batching. The callers keep those
 * (App's rAF batcher and its direct-dispatch set stay in App) and pass in the two
 * facts this function would otherwise have to read from live state.
 *
 * `live: false` is a page replayed from disk, i.e. HISTORY. It returns nothing
 * for conditions that only mean something while a turn is running: heartbeats and
 * progress payloads, `session-error`, `replay-complete`, the compaction MARKER
 * (only the window that ran /compact draws one) and the /clear gauge re-base.
 * Replaying "the model is thinking" from disk would park a turn that finished
 * hours ago, and replaying an error would re-raise a banner the user already
 * moved past. The one heartbeat-shaped event that DOES replay is the saved retry
 * marker (`dropPart`): it shapes what the answer is, so history applies it too.
 * The bookkeeping half of `compact-summary` (what the summarize call
 * cost, the window it left behind) DOES replay, so totals survive a reopen.
 *
 * Unknown types return []. Kotlin's runtime also sends a flat 'streaming-text'
 * the renderer has never handled, and a future producer may add one: a screen
 * must ignore what it does not know, never throw inside an IPC listener.
 */
export interface EventToActionOptions {
  /** A live stream (true) or a history page (false). See above. */
  live: boolean;
  /**
   * Live only. Did THIS window just run /compact and is it waiting on the
   * summary? Gates the marker for a manual compaction. A native automatic
   * compaction draws one regardless (it has no pending flag to satisfy).
   */
  compactionPending?: boolean;
  /**
   * Live only. Claude Code's statusline reading of the context window, used for
   * the marker's "after" figure when the event carries no figure of its own.
   * The buddy has no statusline, so it passes null.
   */
  fallbackContextTokens?: number | null;
}

export function eventToAction(event: TranscriptEvent, opts: EventToActionOptions): ChatAction[] {
  // `data ?? {}`: replay-complete (and a malformed line) can arrive with no data bag;
  // the old live switches guarded that case-by-case with `data?.`.
  // WHY the cast: the type says `data` is always there, but this is the wire
  // boundary (IPC / remote socket / disk page) where a malformed line can lack it.
  // Substituting `{}` keeps every case's existing `?? ''` / `|| {}` default working.
  const ev = (event.data ? event : { ...event, data: {} }) as TranscriptEvent;
  const sessionId = ev.sessionId;
  const { uuid, timestamp } = ev;

  // WHY switch on `ev.type` (not a copy of it in a local): only the property
  // access narrows `ev.data` to the one payload this case's type carries.
  switch (ev.type) {
    case 'user-message':
      // WHY nothing: a user message with no text would draw an empty bubble. The old
      // live paths threw on it (inside the batch, drawing nothing) and no producer
      // sends one, so "draw nothing" is what a user saw before. Every path agrees.
      if (!ev.data.text) return [];
      return [{
        type: 'TRANSCRIPT_USER_MESSAGE',
        sessionId,
        uuid,
        text: ev.data.text,
        timestamp,
        // A slash command read from its command tags starts no turn (chat-reducer).
        slashCommand: ev.data.slashCommand,
        // Host-injected turn marker (a delivered specialist report) + its header.
        injected: ev.data.injected,
        injectedMeta: ev.data.injectedMeta,
        // The subagent stamp lets the reducer tell a briefing written into a
        // subagent's own file from a real user prompt, and drop the former (it is
        // already shown on the parent's Agent card).
        parentAgentToolUseId: ev.data.parentAgentToolUseId,
        agentId: ev.data.agentId,
      } as ChatAction];

    case 'user-interrupt':
      return [{
        type: 'TRANSCRIPT_INTERRUPT',
        sessionId,
        uuid,
        timestamp,
        // Claude Code names the kind; the native runtime omits it.
        kind: ev.data.kind,
        // Native only: what the abandoned turn already spent. No turn-complete
        // follows an interrupt, so this is the only place those tokens count. Also
        // replayed from a page and deduped by uuid, so a resumed session's totals
        // include interrupted turns.
        usage: ev.data.usage,
      } as ChatAction];

    case 'assistant-text':
      return [{
        type: 'TRANSCRIPT_ASSISTANT_TEXT',
        sessionId,
        uuid,
        text: ev.data.text ?? '',
        timestamp,
        // Per-message model, so the reducer can stamp turn.model on a turn's first text.
        model: ev.data.model,
        // Native runtime: per-token delta id; the same partId merges into the last segment.
        partId: ev.data.partId,
        // The stamp routes a subagent's text into the parent's Agent card instead
        // of the main timeline.
        parentAgentToolUseId: ev.data.parentAgentToolUseId,
        agentId: ev.data.agentId,
      } as ChatAction];

    case 'assistant-thinking': {
      // Text = real reasoning content: a collapsible card, and history worth keeping.
      // Truthiness (not typeof) on purpose: an empty string stays a heartbeat.
      if (ev.data.text) {
        return [{
          type: 'TRANSCRIPT_ASSISTANT_REASONING',
          sessionId,
          uuid,
          text: ev.data.text,
          timestamp,
          partId: ev.data.partId,
          // A child's stamped reasoning routes into its Task card, not the parent's bubble.
          parentAgentToolUseId: ev.data.parentAgentToolUseId,
        } as ChatAction];
      }
      // A saved retry marker is a record of what the answer IS, not a live condition,
      // so it replays on a history page too. WHY: the marker comes AFTER the part it
      // discards and is stored on disk; skipping it on pages made a reopened
      // conversation show the discarded half-answer glued in front of the real one
      // (same part id merges them). Applied on the scratch state, it removes parts the
      // page already drew. Pages cut only at a user message and a retry stays inside
      // one turn, so its target is on this page; the exception (one turn over the page
      // byte cap) finds no open turn and the reducer ignores it.
      if (!opts.live) {
        return ev.data.dropPart
          ? [{ type: 'NATIVE_PARTS_DROPPED', sessionId, partIds: ev.data.dropPart.partIds } as ChatAction]
          : [];
      }
      // No text = a lifecycle heartbeat. LIVE only, see the header.
      const out: ChatAction[] = [];
      // Argument-generation progress: draw/update the preparing tool card.
      // IN ADDITION to the heartbeat, not instead of it: the heartbeat's
      // promptProcessing:null is the right outcome here (prefill is over once
      // arguments are streaming), and suppressing it would strand the previous
      // phase's progress line on screen.
      if (ev.data.toolPreparing) {
        out.push({
          type: 'NATIVE_TOOL_PREPARING',
          sessionId,
          toolCallId: ev.data.toolPreparing.toolCallId,
          toolName: ev.data.toolPreparing.toolName,
          chars: ev.data.toolPreparing.chars,
          cleared: ev.data.toolPreparing.cleared,
        } as ChatAction);
      }
      // Erase an abandoned half-written sentence BEFORE the heartbeat below
      // parks/clears the turn. If this ran after a retry's new text landed it
      // would erase the retried content instead of the stale one. ORDER MATTERS.
      if (ev.data.dropPart) {
        out.push({ type: 'NATIVE_PARTS_DROPPED', sessionId, partIds: ev.data.dropPart.partIds } as ChatAction);
      }
      out.push({
        type: 'TRANSCRIPT_THINKING_HEARTBEAT',
        sessionId,
        // The source stamp/uuid lets the reducer ignore a late attach that would
        // undo a newer live measurement; display-only.
        usageProgress: ev.data.usageProgress,
        uuid,
        timestamp,
        // Native watchdog: stallWarning drives the countdown, `stalled` parks
        // the turn, and a plain heartbeat clears both.
        stallWarning: ev.data.stallWarning,
        stalled: ev.data.stalled,
        promptProcessing: ev.data.promptProcessing,
      } as ChatAction);
      return out;
    }

    case 'tool-use': {
      // Built WITHOUT the `as ChatAction` the other cases use, so the compiler checks
      // it against the action's real shape: `timestamp` is required there, and a
      // missing one (the buddy once dropped it) is a build error, not a visual bug.
      // The event data is typed now (M5), so no `!` is needed on the ids.
      const action: Extract<ChatAction, { type: 'TRANSCRIPT_TOOL_USE' }> = {
        type: 'TRANSCRIPT_TOOL_USE',
        sessionId,
        uuid,
        toolUseId: ev.data.toolUseId,
        toolName: ev.data.toolName,
        toolInput: ev.data.toolInput || {},
        // A specialist's mid-run note is placed among its tool rows by time
        // (reconcileNoteSegments); the top-level card ignores it.
        timestamp,
        parentAgentToolUseId: ev.data.parentAgentToolUseId,
        agentId: ev.data.agentId,
      };
      return [action];
    }

    case 'tool-result':
      return [{
        type: 'TRANSCRIPT_TOOL_RESULT',
        sessionId,
        uuid,
        toolUseId: ev.data.toolUseId,
        result: ev.data.toolResult || '',
        isError: ev.data.isError || false,
        structuredPatch: ev.data.structuredPatch,
        backgroundTaskId: ev.data.backgroundTaskId,
        resumedTaskId: ev.data.resumedTaskId,
        parentAgentToolUseId: ev.data.parentAgentToolUseId,
        agentId: ev.data.agentId,
      } as ChatAction];

    case 'background-task':
      // Claude Code: background work a card launched has ended. The only signal
      // that it did (the card's own result was just the launch receipt). It only
      // settles a card, so it replays from a page too.
      if (!ev.data.backgroundTask) return [];
      return [{
        type: 'TRANSCRIPT_BACKGROUND_TASK',
        sessionId,
        uuid,
        toolUseId: ev.data.toolUseId,
        taskIds: ev.data.backgroundTask.taskIds,
        status: ev.data.backgroundTask.status,
        summary: ev.data.backgroundTask.summary,
        result: ev.data.backgroundTask.result,
        parentAgentToolUseId: ev.data.parentAgentToolUseId,
      } as ChatAction];

    case 'replay-complete':
      // End of a transcript replay: reap cards the history left 'running'.
      // Synthesized by the replay handler in main, never parsed from a transcript,
      // so a page never contains it. sessionIdle false means main could not affirm
      // the session is idle (live re-dock, or a CC session) and the reducer leaves
      // everything alone.
      if (!opts.live) return [];
      return [{ type: 'TRANSCRIPT_REPLAY_COMPLETE', sessionId, sessionIdle: ev.data.sessionIdle === true }];

    case 'turn-complete':
      // Forward the whole metadata payload; coalesce undefined -> null because the
      // action type wants (string | null), not optional. Native StatusBar chips
      // read this usage through the reducer, for desktop and remote alike.
      return [{
        type: 'TRANSCRIPT_TURN_COMPLETE',
        sessionId,
        uuid,
        timestamp,
        stopReason: ev.data.stopReason ?? null,
        model: ev.data.model ?? null,
        anthropicRequestId: ev.data.anthropicRequestId ?? null,
        usage: ev.data.usage ?? null,
        // The stamp lets the reducer drop a sub-agent's end_turn instead of
        // overwriting the parent's turn.model and ending the parent's turn.
        parentAgentToolUseId: ev.data.parentAgentToolUseId,
        agentId: ev.data.agentId,
      } as ChatAction];

    case 'subagent-usage':
      // A delegated run's whole spend. Pure bookkeeping: no timeline, no turn
      // state, no subagent segments. Persisted on the PARENT's record, so it
      // replays from a page (the reducer dedups on uuid, and a page seeds its
      // scratch state with the live seenUuids, so overlap cannot double-count).
      return [{
        type: 'TRANSCRIPT_SUBAGENT_USAGE',
        sessionId,
        uuid,
        timestamp,
        usage: ev.data.usage ?? null,
        parentAgentToolUseId: ev.data.parentAgentToolUseId,
        agentId: ev.data.agentId,
      } as ChatAction];

    case 'session-error':
      // Native runtime only: a provider/stream failure. Ends the turn and raises
      // the 'error' banner. LIVE only: replaying it would re-raise a banner for a
      // failure the user already saw. (Accepted consequence: its usage does not
      // replay, so a resumed session's totals are short by a failed turn.)
      if (!opts.live) return [];
      return [{
        type: 'NATIVE_SESSION_ERROR',
        sessionId,
        timestamp,
        message: ev.data.text ?? 'The model request failed.',
        errorCode: ev.data.errorCode,
        // A turn that died mid-flight still spent what its completed steps spent;
        // the uuid lets the reducer count that once.
        uuid,
        usage: ev.data.usage,
      } as ChatAction];

    case 'skill-invoked':
      // /skill-name. The instructions in ev.data.body are deliberately NOT forwarded:
      // they belong to the model's history, not the timeline (26k characters of
      // SKILL.md as a user bubble, Destin 2026-07-28).
      return [{
        type: 'TRANSCRIPT_SKILL_INVOKED',
        sessionId,
        uuid,
        timestamp,
        skillId: ev.data.skillId ?? 'skill',
        displayName: ev.data.displayName ?? ev.data.skillId ?? 'Skill',
        args: ev.data.args,
        skillPath: ev.data.skillPath,
      } as ChatAction];

    case 'context-clear': {
      // The durable /clear barrier (native runtime). It also fires during history
      // replay, which is what makes a resumed session show the post-clear view the
      // user left behind instead of resurrecting the old conversation.
      // WHY the divider is drawn here only on a PAGE (sync-fix6): live, the computer's record says "Conversation cleared" itself (a `session:live` clear
      // with this same id, main/session-live.ts nativeCleared), so one line comes from ONE source on every screen and reaches a screen that opens later.
      // This live action only resets the turn. A history page has no record behind it, so it still draws the line; the shared id makes a page and a
      // live line for the same clear one line.
      const out: ChatAction[] = [{ type: 'CLEAR_TIMELINE', sessionId, markerId: opts.live ? undefined : clearDividerId(uuid), timestamp }];
      // The barrier drops the whole conversation from the model's window, so the
      // gauge moves with it: no turn runs to re-measure. LIVE only; a page's
      // gauge is the live session's own value.
      if (opts.live && ev.data.contextUsedAfter !== undefined) {
        out.push({ type: 'NATIVE_HISTORY_REWRITTEN', sessionId, uuid, contextUsedTokens: ev.data.contextUsedAfter } as ChatAction);
      }
      return out;
    }

    case 'compact-summary': {
      const out: ChatAction[] = [];
      // Bookkeeping first, and OUTSIDE the marker guard below: the window this
      // rewrite left behind and the summarize call's own bill are true whether or
      // not this window draws a marker. Replays from a page; HISTORY_PAGE_LOADED
      // discards the re-based occupancy so an OLDER page's compaction cannot stomp
      // the current gauge.
      if (ev.data.contextUsedAfter !== undefined || ev.data.usage) {
        out.push({
          type: 'NATIVE_HISTORY_REWRITTEN',
          sessionId,
          uuid,
          contextUsedTokens: ev.data.contextUsedAfter ?? null,
          usage: ev.data.usage,
        } as ChatAction);
      }
      // The MARKER is live only: a page is history, and a compaction that happened
      // in another window or a past run must not draw a fresh marker now. A manual
      // /compact needs compactionPending; a native automatic compaction is
      // spontaneous (~all history was just summarized away) so it always draws one.
      if (opts.live && (opts.compactionPending || ev.data.autoCompaction)) {
        out.push({
          type: 'COMPACTION_COMPLETE',
          sessionId,
          // A re-docked window replays the same event; a stable event uuid lets the
          // reducer discard the duplicate marker while keeping the turn.
          markerId: `compact-done-${uuid}`,
          // The harness's own pair wins where it exists. The statusline is Claude
          // Code's and a NATIVE session never writes it.
          afterContextTokens: ev.data.contextUsedAfter ?? opts.fallbackContextTokens ?? null,
          beforeContextTokens: ev.data.contextUsedBefore,
          // Summary text makes the marker click-to-expand.
          ...(ev.data.summary ? { summary: ev.data.summary } : {}),
          ...(ev.data.autoCompaction ? { auto: true } : {}),
          // Native only: where the kept tail starts, so only older messages dim.
          ...(ev.data.retainedFromUuid !== undefined ? { retainedFromUuid: ev.data.retainedFromUuid } : {}),
        } as ChatAction);
      }
      return out;
    }

    default: {
      // Compile-time: adding a TranscriptEventType without a case above fails the
      // build here. Runtime: an unknown type (Kotlin's 'streaming-text') is ignored.
      const unhandled: never = ev;
      void unhandled;
      return [];
    }
  }
}
