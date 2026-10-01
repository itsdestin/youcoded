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
// Electron-free and injected, like publish.ts: tests drive it with a record and a fake publish.
import type { Publish } from './publish';
import type { SessionRecords } from './session-record';
import { detectPermissionMode } from '../shared/permission-mode-detect';
import { claudeAliasForModelId, CLAUDE_ALIAS_LABELS } from '../shared/model-ids';
import { IPC } from '../shared/backend-contract';
import type { PromptReport, SessionLiveBody } from '../shared/session-live-types';

/** Typed into the terminal as a whole write: `/model opus[1m]` + Enter. A write that is only part of a line never matches. */
const MODEL_COMMAND_RE = /^\/model[ \t]+(\S+)[ \t]*\r?$/;
/** `/compact` with or without focus instructions after it. */
const COMPACT_COMMAND_RE = /^\/compact(?:[ \t][^\r\n]*)?\r?$/;

/** A compaction with no event of any kind for this long has stopped (the screens' own watchdog used this number). */
export const COMPACT_IDLE_LIMIT_MS = 180_000;
const COMPACT_CHECK_MS = 30_000;

export interface SessionLiveDeps {
  publish: Publish;
  records: Pick<SessionRecords, 'facts' | 'hasPrompt' | 'isCompacting'>;
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
        this.live(sessionId, { kind: 'model', model: alias });
        if (notice === 'model-switch') this.live(sessionId, { kind: 'model-switch', id: this.nextId('model-switch'), label: `Model switched to ${CLAUDE_ALIAS_LABELS[alias]}` });
      }
      return;
    }
    if (COMPACT_COMMAND_RE.test(text)) this.compactStarted(sessionId);
  }

  /**
   * Claude Code's SessionStart hook fired. `source` is Claude Code's own field (startup | resume | clear | compact):
   * a `clear` is a "Conversation cleared" line on every screen. The id is the NEW conversation's id, so a replayed hook cannot draw two.
   */
  noteSessionStart(sessionId: string, source: unknown, claudeSessionId: unknown): void {
    if (source !== 'clear' || !this.deps.isClaude(sessionId)) return;
    this.live(sessionId, { kind: 'clear', id: `clear-${typeof claudeSessionId === 'string' && claudeSessionId ? claudeSessionId : this.nextId('clear')}` });
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
    this.lastCompactStart.delete(sessionId);
  }

  /**
   * A computer window saw a card in its terminal (usage limit, trust folder, resume ...) and says so. The host publishes it ONCE however
   * many windows report the same card, as a numbered event, so every screen draws it in the same place; a screen that opens later is handed
   * the cards still open (record.liveFill).
   */
  reportPrompt(report: PromptReport): { ok: boolean } {
    if (!report || typeof report.sessionId !== 'string' || !report.sessionId) return { ok: false };
    if (typeof report.promptId !== 'string' || !report.promptId) return { ok: false };
    if (report.action === 'dismiss') {
      // A dismissal of a card that is not open says nothing new (a second window reporting the same menu going away).
      if (!this.deps.records.hasPrompt(report.sessionId, report.promptId)) return { ok: true };
      this.live(report.sessionId, { kind: 'prompt-dismiss', promptId: report.promptId });
      return { ok: true };
    }
    if (report.action !== 'show' || typeof report.title !== 'string' || !Array.isArray(report.buttons)) return { ok: false };
    if (this.deps.records.hasPrompt(report.sessionId, report.promptId)) return { ok: true };
    this.live(report.sessionId, {
      kind: 'prompt-show', promptId: report.promptId, title: report.title,
      ...(report.description !== undefined ? { description: report.description } : {}),
      buttons: report.buttons,
      ...(report.defaultIndex !== undefined ? { defaultIndex: report.defaultIndex } : {}),
    });
    return { ok: true };
  }
}
