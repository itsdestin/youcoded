// session-live-types.ts — the shared lines and live facts a session's record publishes (`session:live`), one-core R5-4a.
//
// WHY (2026-10-01 one-core R5-4a): the facts below used to be worked out by EACH screen — the message that is queued on the
// computer showed only on the screen that sent it, "Switched to Opus" and "Conversation cleared" only on the screen that typed the
// command, the compaction spinner only on the screen that typed /compact, a usage-limit card wherever that screen's own terminal scan
// happened to notice it. The computer now says each of them ONCE, as a numbered event in the session's record, so every screen draws the
// same line in the same place and a screen that opens later is handed the ones that are still true (main/session-open.ts).
//
// Types only: nothing here runs. In shared/ because the renderer reads them and renderer code does not import from main/.

/** One message waiting behind the running turn (native sessions): what the docked strip draws. */
interface QueuedItem { queueId: string; content: string; timestamp: number }

export interface PromptCardButton { label: string; input: string; submitInput?: string; pick?: { signature: string; index: number } }

export type SessionLiveBody =
  /** The queue as it is NOW (a snapshot, so a screen that missed events is right after the next one). Native sessions only. */
  | { kind: 'queue'; queue: QueuedItem[] }
  /** The session's model changed: the raw model id or alias the chip is drawn from. */
  | { kind: 'model'; model: string }
  /** The thin "Model switched to Opus" divider. `id` is deterministic, so a replay cannot draw it twice. */
  | { kind: 'model-switch'; id: string; label: string }
  /** Claude Code refused the model switch the host announced: take that divider back. */
  | { kind: 'model-switch-retract'; id: string }
  /** The thin "Conversation cleared" divider (Claude Code; a native clear is already a transcript event). */
  | { kind: 'clear'; id: string }
  /** A compaction began: draw the spinner. The "Compacted" note itself comes from the transcript's own compaction line. */
  | { kind: 'compact-start'; id: string }
  /** A compaction ended WITHOUT a summary line (stopped or refused): take the spinner away. */
  | { kind: 'compact-end'; id: string; outcome: 'cancelled' | 'failed' }
  /** A card for a question Claude Code is asking in its own terminal (usage limit, trust folder, resume, ...). */
  | { kind: 'prompt-show'; promptId: string; title: string; description?: string; buttons: PromptCardButton[]; defaultIndex?: number }
  | { kind: 'prompt-dismiss'; promptId: string };

export type SessionLive = { sessionId: string } & SessionLiveBody;

/** What a computer window tells the host about a card it saw in the terminal (`session:prompt-report`). */
export type PromptReport =
  | { sessionId: string; action: 'show'; promptId: string; title: string; description?: string; buttons: PromptCardButton[]; defaultIndex?: number }
  | { sessionId: string; action: 'dismiss'; promptId: string }
  /** A computer window's first read of its terminal: the menus on screen right now; the host dismisses any open card not among them. */
  | { sessionId: string; action: 'sync'; seen: string[] };
