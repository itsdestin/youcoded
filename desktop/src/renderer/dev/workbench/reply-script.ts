// Plays a reply fixture back as the same events a real backend would send —
// `on.transcriptEvent` for the timeline and `on.hookEvent` for a permission
// ask — so a message typed into the workbench gets an answer. This is the
// "phase 2 live play-through" the workbench spec deferred; the landing-page
// embed needs it because a composer that swallows input reads as broken.
// The script does NOT emit a `user-message` event: the real app already
// renders the user's bubble optimistically the instant Enter is pressed
// (App's `USER_PROMPT` dispatch), so the script starts at the assistant's
// first line — emitting one here double-echoed the user's message.
//
// Fixture lines reuse the conversation-fixture vocabulary (fixture-loader.ts)
// plus `delay` (ms before the line) and two new kinds:
//   permission_request — emits a PermissionRequest hook event and PAUSES until
//                        session.respondToPermission(id) (mock-shim) resolves it
//   turn_complete      — ends the turn
// No Date.now(): timestamps are a counter so a replay is byte-identical.

export type ReplyLine =
  | { type: 'assistant_text'; text: string; delay?: number; model?: string }
  // A user bubble the SCRIPT puts on the timeline — for a turn nobody typed here
  // (the phone half of the sync loop receives the desktop's message). Never use
  // it for a message typed in this window: that bubble is already rendered.
  | { type: 'user_message'; text: string; delay?: number }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; delay?: number }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean; delay?: number }
  | { type: 'permission_request'; id: string; name: string; input: Record<string, unknown>; delay?: number }
  | { type: 'turn_complete'; delay?: number; model?: string };

export interface ReplySinks {
  transcript: (event: unknown) => void;
  hook: (event: unknown) => void;
  /** characters per second for streamed text; tests pass a large number */
  cps?: number;
  /** playback multiplier for the text AND each line's pause (`?replySpeed=`); 1 when absent */
  speed?: number;
}

export function parseReplyScript(raw: string): ReplyLine[] {
  return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as ReplyLine);
}

const pending = new Map<string, () => void>();
export function resolvePermission(requestId: string): boolean {
  const r = pending.get(requestId);
  if (!r) return false;
  pending.delete(requestId);
  r();
  return true;
}

let counter = 0;
const uid = () => `wb-ev-${++counter}`;
const stamp = () => 1_753_800_000_000 + counter * 1000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True for the control bytes App/useSubmitConfirmation send to a PTY session
 *  ('\r' submit, '\x1b' interrupt, '\x1b[Z' shift-tab). Those must never start
 *  a scripted reply. */
export function isControl(text: string): boolean {
  return text.trim().length === 0 || text.startsWith('\x1b') || text === '\r';
}

/** Split a fixture into turns — one per `turn_complete` (a trailing turn with
 *  no lines is dropped). The Nth message sent in a session plays turn N,
 *  wrapping at the end; a one-turn fixture therefore answers every message the
 *  same way, which is what the workbench did before turns existed. */
export function splitTurns(lines: ReplyLine[]): ReplyLine[][] {
  const turns: ReplyLine[][] = [[]];
  for (const l of lines) { turns[turns.length - 1].push(l); if (l.type === 'turn_complete') turns.push([]); }
  if (turns[turns.length - 1].length === 0) turns.pop();
  return turns;
}

export async function playReply(sessionId: string, text: string, script: ReplyLine[], sinks: ReplySinks): Promise<void> {
  if (isControl(text)) return;
  const t = (type: string, data: Record<string, unknown>) =>
    sinks.transcript({ type, sessionId, uuid: uid(), timestamp: stamp(), data });
  const speed = sinks.speed && sinks.speed > 0 ? sinks.speed : 1;
  const perChar = 1000 / ((sinks.cps ?? 40) * speed);

  for (const line of script) {
    await sleep((line.delay ?? 400) / speed);
    switch (line.type) {
      case 'assistant_text': {
        // One partId across the chunks: App.tsx merges same-partId deltas into
        // the last text segment, which is what makes it look like streaming.
        const partId = uid();
        const words = line.text.split(' ');
        for (let i = 0; i < words.length; i++) {
          t('assistant-text', { text: (i ? ' ' : '') + words[i], partId, model: line.model });
          await sleep(perChar * (words[i].length + 1));
        }
        break;
      }
      case 'user_message':
        t('user-message', { text: line.text });
        break;
      case 'tool_use':
        t('tool-use', { toolUseId: line.id, toolName: line.name, toolInput: line.input });
        break;
      case 'tool_result':
        t('tool-result', { toolUseId: line.tool_use_id, toolResult: line.content, isError: !!line.is_error });
        break;
      case 'permission_request': {
        sinks.hook({
          type: 'PermissionRequest', sessionId,
          payload: { tool_name: line.name, tool_input: line.input, _requestId: line.id, permissionMode: 'ask' },
        });
        await new Promise<void>((resolve) => pending.set(line.id, resolve));
        // The ask was for this tool call; a tool-use with the same id makes the
        // card show the work happening after approval.
        t('tool-use', { toolUseId: line.id, toolName: line.name, toolInput: line.input });
        break;
      }
      case 'turn_complete':
        t('turn-complete', { stopReason: 'end_turn', model: line.model ?? null });
        break;
      default:
        // A typo in a fixture must be loud, not a silently skipped beat.
        console.warn(`[workbench] reply script: unknown line type ${JSON.stringify((line as { type?: string }).type)} — skipped`);
    }
  }
}

/** The same fixture as a finished page of history — every line at once, no
 *  streaming, no permission pause — in the event shape `detach.requestTranscriptPage`
 *  returns (TranscriptEvent, the shape playReply streams). Used by the shim to
 *  answer the first-page load of a RESUMED session with a real conversation:
 *  the promo's phone beat takes over "econ midterm brief" and must show the
 *  brief, and before this the page came back empty. `userText`, when given,
 *  is the user bubble the fixture never carries (see the header). */
export function scriptToEvents(sessionId: string, lines: ReplyLine[], userText?: string): unknown[] {
  const out: unknown[] = [];
  const t = (type: string, data: Record<string, unknown>) =>
    out.push({ type, sessionId, uuid: uid(), timestamp: stamp(), data });
  if (userText) t('user-message', { text: userText });
  for (const line of lines) {
    switch (line.type) {
      case 'assistant_text': t('assistant-text', { text: line.text, partId: uid(), model: line.model }); break;
      case 'user_message': t('user-message', { text: line.text }); break;
      case 'tool_use': t('tool-use', { toolUseId: line.id, toolName: line.name, toolInput: line.input }); break;
      case 'tool_result': t('tool-result', { toolUseId: line.tool_use_id, toolResult: line.content, isError: !!line.is_error }); break;
      // In history the ask was answered long ago: only the call it became remains.
      case 'permission_request': t('tool-use', { toolUseId: line.id, toolName: line.name, toolInput: line.input }); break;
      case 'turn_complete': t('turn-complete', { stopReason: 'end_turn', model: line.model ?? null }); break;
    }
  }
  return out;
}
