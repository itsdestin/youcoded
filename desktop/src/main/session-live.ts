// session-live.ts — the computer's own reading of a Claude Code session's live facts (one-core R5-4a, seam S5).
//
// WHY (2026-10-01 one-core R5-4a): Claude Code keeps its permission mode, its model and its compaction in its own terminal and
// transcript, and every screen used to work them out for itself from the terminal text it happened to hold: a phone that connected after
// the mode footer had scrolled off showed the launch mode, the screen you did NOT type /compact on never showed the spinner, and
// "Switched to Opus" appeared only where it was typed. This file reads those signals ONCE, in the main process (which already relays every
// terminal byte, every input and every hook), and publishes each as a numbered event in the session's record (session-record.ts), so every
// screen draws the same thing in the same place.
//
// What it reads, and from what (each Claude Code-coupled signal has an entry in docs/cc-dependencies.md → "Live facts read in main"):
//   - the permission mode, from the footer text Claude Code prints after a Shift+Tab ("plan mode on", "accept edits on", ...)
//     in the terminal bytes — the same strings each screen used to scan (shared/permission-mode-detect.ts);
//   - /model <alias> and /compact, from what a screen TYPED into the terminal (the computer is the one that writes those bytes);
//   - "Conversation cleared", from the SessionStart hook's `source: "clear"` (Claude Code's own field, not terminal text).
//
// Cards a terminal shows and the "may be stuck" reading are found by main/session-screens.ts (the computer's own copy of each terminal) and
// published through this class, so there is one writer of each.
//
// Electron-free and injected, like publish.ts: tests drive it with a record and a fake publish.
import type { Publish } from './publish';
import type { SessionRecords } from './session-record';
import { detectPermissionMode } from '../shared/permission-mode-detect';
import { claudeAliasForModelId, CLAUDE_ALIAS_LABELS, isPlaceholderModelId } from '../shared/model-ids';
import { IPC } from '../shared/backend-contract';
import type { PromptCardButton, SessionLiveBody } from '../shared/session-live-types';

/** Typed into the terminal as a whole write: `/model opus[1m]` + Enter. A write that is only part of a line never matches. */
const MODEL_COMMAND_RE = /^\/model[ \t]+(\S+)[ \t]*\r?$/;
/** `/compact` with or without focus instructions, SUBMITTED: the Enter is required, so text pasted without it starts nothing (review fix, R5-4a). */
const COMPACT_COMMAND_RE = /^\/compact(?:[ \t][^\r\n]*)?\r$/;
/** `/clear` (or its aliases) submitted. */
const CLEAR_COMMAND_RE = /^\/(?:clear|reset|new)[ \t]*\r$/;
/** How long the host waits for Claude Code's own SessionStart `source: "clear"` before drawing the divider itself. */
const CLEAR_HOOK_WAIT_MS = 3000;
/** A hook `clear` this soon after the host drew its own is the same clear arriving late. */
const CLEAR_DEDUPE_MS = 15_000;
/** How long after a `/model` write a rejection printed in the terminal still counts as ITS answer. */
const MODEL_REJECT_WINDOW_MS = 8000;
/**
 * What Claude Code prints when it refuses a model. ASSUMED, not seen on a real capture (no refusal was captured; see docs/cc-dependencies.md
 * "Live facts read in main"): a line that names the model and says it is not found / invalid / unknown / not available. The reply's own model
 * (the next assistant message) is the backstop that does not depend on this wording.
 */
const MODEL_REJECT_RE = /model[^\n]{0,80}(?:not found|invalid|unknown|not available|unavailable|isn't available|does not exist|can't be used)|(?:invalid|unknown|unsupported)[^\n]{0,24}model/i;
/** Assistant output, a tool or a finished turn means Claude Code is past any menu it was showing (a menu blocks its input). */
const MOVED_ON_TYPES = new Set(['assistant-text', 'tool-use', 'turn-complete']);

/**
 * Does this chunk of terminal output say Claude Code REFUSED a model?
 *
 * WHY the rows are split first (2026-10-01, one-core R6-4 fix): Claude Code's screen redraws separate rows with a carriage return and a cursor-down
 * escape, never "\n". Stripping the escapes alone therefore glued neighbouring rows into one "line", and MODEL_REJECT_RE's `model[^\n]{0,80}unavailable`
 * matched Claude Code's own SUCCESS line ("Set model to Haiku 4.5 and saved as your default") followed by the footer row "auto mode unavailable".
 * The host then "took back" a switch that had worked: the divider vanished and the label went back to the old model (Destin's missing divider).
 */
function looksLikeModelRefusal(data: string): boolean {
  const rows = data
    .replace(/\x1b\[\d*(?:;\d*)?[HBEF]/g, '\n')   // cursor-home / down / next-line / previous-line: a new row starts here
    .replace(/\r/g, '\n')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');         // every other escape (colours, cursor-forward) just disappears
  return MODEL_REJECT_RE.test(rows);
}

/** A compaction with no event of any kind for this long has stopped (the screens' own watchdog used this number). */
export const COMPACT_IDLE_LIMIT_MS = 180_000;
const COMPACT_CHECK_MS = 30_000;

export interface SessionLiveDeps {
  publish: Publish;
  records: Pick<SessionRecords, 'facts' | 'hasPrompt' | 'isCompacting' | 'openPrompts'>;
  /** Is this a Claude Code session? (A native session's host says these things itself; a shell has none.) */
  isClaude(sessionId: string): boolean;
  now?: () => number;
  /** Timers are injectable so a test does not wait three minutes. */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void } | unknown;
  clearTimer?: (handle: unknown) => void;
}

export class SessionLiveFacts {
  private readonly now: () => number;
  private readonly timers = new Map<string, unknown>();
  private readonly lastCompactStart = new Map<string, string>();
  /** A typed /clear waiting for the hook, and when a divider was last drawn (the hook arriving late must not draw a second). */
  private readonly clearTimers = new Map<string, unknown>();
  private readonly lastClearAt = new Map<string, number>();
  /** A /model the host announced and has not yet seen confirmed: what to put back if Claude Code refused it. */
  private readonly pendingModel = new Map<string, { alias: string; prev: string | null; dividerId: string | null; at: number; turnStarted: boolean }>();
  private ids = 0;

  constructor(private readonly deps: SessionLiveDeps) {
    this.now = deps.now ?? Date.now;
  }

  private live(sessionId: string, body: SessionLiveBody): void {
    this.deps.publish(sessionId, IPC.SESSION_LIVE, { sessionId, ...body });
  }

  /** A deterministic-enough id: unique per session within a run, so a replay of the same event cannot draw a divider twice. */
  private nextId(kind: string): string { return `${kind}-${this.now()}-${++this.ids}`; }

  /**
   * One chunk of a Claude Code session's terminal output. Publishes the mode only when it CHANGED from what the record already holds,
   * so a footer that is redrawn forty times a second is one event, not forty.
   */
  noteOutput(sessionId: string, data: string): void {
    if (!this.deps.isClaude(sessionId)) return;
    const pm = this.pendingModel.get(sessionId);
    if (pm && !pm.turnStarted && this.now() - pm.at < MODEL_REJECT_WINDOW_MS && looksLikeModelRefusal(data)) this.rejectModel(sessionId);
    const mode = detectPermissionMode(data);
    if (!mode) return;
    const known = this.deps.records.facts(sessionId)?.permissionMode ?? null;
    if (known === mode) return;
    this.deps.publish(sessionId, IPC.SESSION_PERMISSION_MODE, { sessionId, mode });
  }

  /**
   * A screen wrote `text` into a Claude Code session's terminal. `notice` is the screen saying "this was typed as a command in the
   * chat" (as opposed to the model picker or the Shift+Space cycle, which write the same bytes): only a typed command draws the
   * "Model switched to ..." divider, exactly as before.
   */
  noteInput(sessionId: string, text: string, notice?: unknown): void {
    if (!this.deps.isClaude(sessionId) || typeof text !== 'string') return;
    const model = MODEL_COMMAND_RE.exec(text);
    if (model) {
      const alias = claudeAliasForModelId(model[1]);
      // Only a model we can NAME is announced: an unrecognised argument (a raw dated id, a typo) shows nothing honest.
      if (alias) {
        const dividerId = notice === 'model-switch' ? this.nextId('model-switch') : null;
        this.pendingModel.set(sessionId, { alias, prev: this.deps.records.facts(sessionId)?.model ?? null, dividerId, at: this.now(), turnStarted: false });
        this.live(sessionId, { kind: 'model', model: alias });
        if (dividerId) this.live(sessionId, { kind: 'model-switch', id: dividerId, label: `Model switched to ${CLAUDE_ALIAS_LABELS[alias]}` });
      }
      return;
    }
    if (COMPACT_COMMAND_RE.test(text)) { this.compactStarted(sessionId); return; }
    if (CLEAR_COMMAND_RE.test(text)) this.clearTyped(sessionId);
  }

  /**
   * Claude Code did not take the model switch (it said so in the terminal, or the next reply came from a different model): take back what the
   * host announced, so no screen keeps claiming it. The divider is retracted and the label goes back to the model the session was on.
   */
  private rejectModel(sessionId: string): void {
    const pm = this.pendingModel.get(sessionId);
    if (!pm) return;
    this.pendingModel.delete(sessionId);
    if (pm.dividerId) this.live(sessionId, { kind: 'model-switch-retract', id: pm.dividerId });
    if (pm.prev) this.live(sessionId, { kind: 'model', model: pm.prev });
  }

  /**
   * A transcript event for the session. Two jobs, both ending something the host raised:
   *  - a reply from a model other than the one just announced (after the next user message, so the turn that was already running
   *    does not count) means Claude Code refused the switch;
   *  - assistant output, a tool or a finished turn NEWER than an open prompt card means Claude Code is past that menu: the card is dismissed
   *    (a window that reloaded while the menu was up never reports its going away; review fix, R5-4a F2).
   */
  noteTranscript(sessionId: string, event: unknown): void {
    if (!this.deps.isClaude(sessionId)) return;
    const e = (event ?? {}) as { type?: string; timestamp?: number; data?: { model?: unknown; parentAgentToolUseId?: unknown; slashCommand?: unknown } };
    if (e.data?.parentAgentToolUseId) return;
    const pm = this.pendingModel.get(sessionId);
    if (pm) {
      if (e.type === 'user-message' && !e.data?.slashCommand) pm.turnStarted = true;
      else if (e.type === 'assistant-text' && pm.turnStarted && typeof e.data?.model === 'string' && !isPlaceholderModelId(e.data.model)) {
        const actual = claudeAliasForModelId(e.data.model);
        if (actual && actual !== pm.alias) this.rejectModel(sessionId); else if (actual) this.pendingModel.delete(sessionId);
      }
    }
    if (e.type && MOVED_ON_TYPES.has(e.type) && typeof e.timestamp === 'number') {
      for (const p of this.deps.records.openPrompts(sessionId)) {
        if (e.timestamp > p.at) this.live(sessionId, { kind: 'prompt-dismiss', promptId: p.promptId });
      }
    }
  }

  /**
   * A /clear was typed. Claude Code's SessionStart hook normally says so (noteSessionStart) within a moment; when it has not after
   * CLEAR_HOOK_WAIT_MS (hooks off, a dev instance, a Claude Code that sends no `source`), the host draws the divider itself so the
   * conversation never just stays on screen. A hook that arrives later is recognised as the same clear and draws nothing more.
   */
  private clearTyped(sessionId: string): void {
    if (this.clearTimers.has(sessionId)) return;
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.clearTimers.set(sessionId, set(() => {
      this.clearTimers.delete(sessionId);
      this.drawClear(sessionId, this.nextId('clear-typed'));
    }, CLEAR_HOOK_WAIT_MS));
  }

  private drawClear(sessionId: string, id: string): void {
    this.lastClearAt.set(sessionId, this.now());
    this.live(sessionId, { kind: 'clear', id });
  }

  /**
   * Claude Code's SessionStart hook fired. `source` is Claude Code's own field (startup | resume | clear | compact):
   * a `clear` is a "Conversation cleared" line on every screen. The id is the NEW conversation's id, so a replayed hook cannot draw two.
   */
  noteSessionStart(sessionId: string, source: unknown, claudeSessionId: unknown): void {
    if (source !== 'clear' || !this.deps.isClaude(sessionId)) return;
    const waiting = this.clearTimers.get(sessionId);
    if (waiting !== undefined) { (this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout)))(waiting); this.clearTimers.delete(sessionId); }
    // The host already drew this clear itself (the hook was late): nothing more to say.
    const last = this.lastClearAt.get(sessionId);
    if (waiting === undefined && last !== undefined && this.now() - last < CLEAR_DEDUPE_MS) return;
    this.drawClear(sessionId, `clear-${typeof claudeSessionId === 'string' && claudeSessionId ? claudeSessionId : this.nextId('clear')}`);
  }

  /** The host (native) or this file (Claude Code) began a compaction: draw the spinner everywhere, and watch that it ends. */
  compactStarted(sessionId: string, id: string = this.nextId('compact')): void {
    this.lastCompactStart.set(sessionId, id);
    this.live(sessionId, { kind: 'compact-start', id });
    this.armWatchdog(sessionId);
  }

  /** A compaction ended with no summary line to say so (stopped, refused, failed): the spinner goes. */
  compactEnded(sessionId: string, outcome: 'cancelled' | 'failed'): void {
    const id = this.lastCompactStart.get(sessionId) ?? this.nextId('compact');
    this.disarm(sessionId);
    this.live(sessionId, { kind: 'compact-end', id, outcome });
  }

  /**
   * Activity-aware, like the screens' own watchdog was: it only declares a compaction dead after COMPACT_IDLE_LIMIT_MS with no event at
   * all in the session (a long compaction on a big conversation keeps producing events), and the summary line clears the record's
   * `compacting` fact itself, so this fires only for a compaction that really stopped.
   */
  private armWatchdog(sessionId: string): void {
    this.disarm(sessionId);
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    const handle = set(() => {
      this.timers.delete(sessionId);
      const f = this.deps.records.facts(sessionId);
      if (!f) return;
      // `compacting` lives in the record: its summary line (or a shrink) has already cleared it when the compaction finished.
      if (!this.deps.records.isCompacting(sessionId)) return;
      if (this.now() - f.lastActivityAt >= COMPACT_IDLE_LIMIT_MS) { this.compactEnded(sessionId, 'failed'); return; }
      this.armWatchdog(sessionId);
    }, COMPACT_CHECK_MS);
    this.timers.set(sessionId, handle);
  }

  private disarm(sessionId: string): void {
    const t = this.timers.get(sessionId);
    if (t === undefined) return;
    (this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout)))(t);
    this.timers.delete(sessionId);
  }

  /** The session ended: nothing left to watch. */
  forget(sessionId: string): void {
    this.disarm(sessionId);
    const w = this.clearTimers.get(sessionId);
    if (w !== undefined) (this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout)))(w);
    this.clearTimers.delete(sessionId); this.lastClearAt.delete(sessionId); this.pendingModel.delete(sessionId);
    this.lastCompactStart.delete(sessionId);
  }

  /**
   * The computer's own reading of a terminal (main/session-screens.ts) found a card (usage limit, trust folder, resume ...). The host publishes it
   * ONCE, as a numbered event every screen draws in the same place; a screen that opens later is handed the cards still open (record.liveFill).
   * (Until R5-4b a computer window or a phone read the terminal and REPORTED the card; nothing outside the host can put a card in front of the
   * person at the computer any more.)
   */
  showPrompt(sessionId: string, card: { promptId: string; title: string; description?: string; buttons: PromptCardButton[]; defaultIndex?: number }): void {
    // One card per question: the same promptId, or another card with the same title, is already up.
    if (this.deps.records.hasPrompt(sessionId, card.promptId) || this.deps.records.openPrompts(sessionId).some((p) => p.title === card.title)) return;
    this.live(sessionId, { kind: 'prompt-show', ...card });
  }

  /** The menu a card was drawn for has left the terminal. A card that is not open says nothing new. */
  dismissPrompt(sessionId: string, promptId: string): void {
    if (!this.deps.records.hasPrompt(sessionId, promptId)) return;
    this.live(sessionId, { kind: 'prompt-dismiss', promptId });
  }

  /** The computer's "may be stuck" reading changed for a Claude Code turn (the only writer of it; see session-screens.ts). */
  attention(sessionId: string, state: 'ok' | 'stuck'): void {
    this.live(sessionId, { kind: 'attention', state });
  }
}
