// session-live-types.ts — the shared lines and live facts a session's record publishes (`session:live`), one-core R5-4a.
//
// WHY (2026-10-01 one-core R5-4a): the facts below used to be worked out by EACH screen — the message that is queued on the
// computer showed only on the screen that sent it, "Switched to Opus" and "Conversation cleared" only on the screen that typed the
// command, the compaction spinner only on the screen that typed /compact, a usage-limit card wherever that screen's own terminal scan
// happened to notice it. The computer now says each of them ONCE, as a numbered event in the session's record, so every screen draws the
// same line in the same place and a screen that opens later is handed the ones that are still true (main/session-open.ts).
//
import type { InputBlock } from './cc-input-focus';
import type { NativeStartupState } from './native-startup';
import type { BrowserPrompt } from './browser-types';

// Types only: nothing here runs. In shared/ because the renderer reads them and renderer code does not import from main/.

/** One message waiting behind the running turn (native sessions): what the docked strip draws. */
export interface QueuedItem { queueId: string; content: string; timestamp: number; sendEpoch?: string; sendId?: string; attachments?: string[]; status?: 'waiting' | 'delivering' | 'uncertain'; editing?: boolean; paused?: boolean; /** One plain sentence about THIS message (why it waits or was not sent). */ notice?: string }

export interface PromptCardButton { label: string; input: string; submitInput?: string; pick?: { signature: string; index: number } }

export type SessionLiveBody =
  /** Confirmed addressed API abort: lifecycle only, not a fabricated transcript/history record. */
  | { kind: 'stop-confirmed'; id: string; userUuid: string; at: number }
  /** History may be open while optional tool connections are not ready for a turn. */
  | { kind: 'native-startup'; state: NativeStartupState }
  /** The queue as it is NOW (a snapshot, so a screen that missed events is right after the next one). Native sessions only. */
  | { kind: 'queue'; queue: QueuedItem[]; queueIdentity?: { queueId: string; sendEpoch: string }; paused?: boolean; /** Recent sends and the transcript line each became (Claude Code queue). */ bound?: { sendId: string; uuid: string }[] }
  /** The session's model changed: the raw model id or alias the chip is drawn from. */
  | { kind: 'model'; model: string }
  /** The thin "Model switched to Opus" divider. `id` is deterministic, so a replay cannot draw it twice. */
  | { kind: 'model-switch'; id: string; label: string; /** when the host drew it (ms), so a replay shows the time it happened, not the time of the fill */ at?: number }
  /** Claude Code refused the model switch the host announced: take that divider back. */
  | { kind: 'model-switch-retract'; id: string }
  /** The thin "Conversation cleared" divider (both runtimes: the record says it for Claude Code from the SessionStart hook and for native from the `context-clear` event; the transcript event itself only resets the turn). */
  | { kind: 'clear'; id: string; /** when it happened (ms); see model-switch */ at?: number }
  /** A compaction began: draw the spinner. The "Compacted" note itself comes from the transcript's own compaction line. */
  | { kind: 'compact-start'; id: string; startedAt?: number }
  /** A compaction ended WITHOUT a summary line (stopped or refused): take the spinner away. */
  | { kind: 'compact-end'; id: string; outcome: 'cancelled' | 'failed' }
  /** A card for a question Claude Code is asking in its own terminal (usage limit, trust folder, resume, ...). */
  | { kind: 'prompt-show'; promptId: string; title: string; description?: string; buttons: PromptCardButton[]; defaultIndex?: number }
  | { kind: 'prompt-dismiss'; promptId: string }
  /**
   * The computer's own reading of a Claude Code turn: "may be stuck" (the spinner stopped moving, or nothing at all came from Claude Code),
   * or back to ok. Sent only when it changes; the computer is the ONLY writer of this reading (one-core R5-4b).
   */
  | { kind: 'attention'; state: 'ok' | 'stuck' }
  /**
   * What holds the keyboard of a Claude Code session's terminal, as the computer reads it off the screen (shared/cc-input-focus.ts): a pop-up or full-screen view,
   * another mode that takes typing (history search, the agents view), or `null` = Claude Code's own message box is live. Sent only when it changes.
   * WHY here (sync with master's popups work, 2026-10-01): master's chat-send gate read the window's own terminal, so a phone (which has no terminal) could never
   * refuse a send typed into an open "Switch model?" confirmation. The computer is the ONLY reader (main/session-screens.ts); every screen's gate asks this.
   */
  | { kind: 'input-block'; block: InputBlock | null }
  /**
   * The assistant's Browser is waiting on the person (a site permission, a "final step", a home-network address, a hand-off), or `null` once the
   * card is answered or withdrawn. WHY a session fact (2026-10-26, notify-user plan Part 1): the Browser's own state push reaches only the
   * computer's windows, so the conversation's light never went red and a phone never saw the card (card #205). Every screen now gets it.
   */
  | { kind: 'browser-ask'; prompt: BrowserPrompt | null };

export type SessionLive = { sessionId: string } & SessionLiveBody;


