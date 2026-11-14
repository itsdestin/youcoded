// Sizing a tool result to the room left in the model's window (fault 1, 2026-11-08).
// WHY: Read caps at 100,000 characters regardless of the model, so on a 32k local window one file
// (52,733 characters, ~15-18k tokens) filled what was left and the next request could not be sent.
// The cut happens BEFORE the result enters history and the transcript, so what the user sees, what
// the model sees and what a reopened chat rebuilds are all the same text (a history-only cut would
// disagree with the saved event). The model is told it was cut and how to ask for the rest.
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { spillDirFor, sweepOldSpillFilesOnce } from './tools/spill-paths';

/** Characters per token used ONLY to turn room into a cap. Deliberately pessimistic (the history
 *  estimator uses 4): code measured ~3 on the real chats, and an over-cut is recoverable (the notice
 *  says how to read more) while an over-fit is not. */
const CAP_CHARS_PER_TOKEN = 3;
/** The model always gets at least this much, however little room is left; compaction (not a
 *  zero-length result) is the way out of a nearly-full window. */
const MIN_RESULT_CHARS = 2_000;

export interface RoomCapOpts {
  /** The tool's own "how to get the rest" sentence (FIT_MORE_HINT); absent for tools that cannot narrow. */
  hint?: string;
  /** Keep only the beginning. For a FILE (Read): what follows the cut is the next offset, and the
   *  file's own end is not where the answer usually is. Everything else keeps both ends. */
  headOnly?: boolean;
  /** Where the whole, uncut result was saved, when it was (see capResultAndSave). */
  savedPath?: string;
}

/** Cap `text` to `roomTokens`. Returns `text` untouched when it fits.
 *
 *  WHY both ends (2026-11-12, review deck 2 Q-1): this cut used to keep the beginning only. Every
 *  tool's own limit already keeps both ends (tools/truncate.ts, 80/20) and Bash ends with its exit
 *  code and the path of its saved full output — so in a nearly full chat this second cut threw away
 *  exactly the lines a failing command's error and that path are on. Same 80/20 split as truncate.ts. */
export function capResultToRoom(text: string, roomTokens: number, opts: RoomCapOpts = {}): string {
  const allowed = Math.max(MIN_RESULT_CHARS, Math.floor(roomTokens * CAP_CHARS_PER_TOKEN));
  if (text.length <= allowed) return text;
  const dropped = text.length - allowed;
  const saved = opts.savedPath ? ` The whole result is saved at ${opts.savedPath} — Read it with offset/limit.` : '';
  const why = `because only ${allowed.toLocaleString()} fit in the room left in this model's context window.${saved}${opts.hint ? ` ${opts.hint}.` : ''}`;
  if (opts.headOnly) {
    return `${text.slice(0, allowed)}\n\n[truncated — ${dropped.toLocaleString()} more characters were dropped ${why}]`;
  }
  const head = Math.ceil(allowed * 0.8);
  return `${text.slice(0, head)}\n\n[truncated — ${dropped.toLocaleString()} characters from the middle were dropped ${why}]\n\n${text.slice(text.length - (allowed - head))}`;
}

/** Tools whose whole result is NOT worth saving when it is cut: Read's result is a file that is
 *  already on disk, and Bash saves its own full output before this cut ever sees it (its result
 *  here is only the short both-ends preview that names that file). */
const NO_SAVE = new Set(['Read', 'Bash', 'BashOutput']);

/** capResultToRoom, plus: when a result is cut, its whole text is first written to this chat's
 *  spill folder so nothing is lost and no tool has to be run twice.
 *
 *  WHY (2026-11-12, review deck 2 Q-1): a search, a web page or an MCP answer that was cut could
 *  only be recovered by running the tool again — not always possible (a page changes, a call has
 *  side effects) and never free. Claude Code, OpenCode and Hermes all keep the whole result on disk
 *  and show a preview. The folder is the one Bash already spills into: the path guard lets the
 *  model Read from it without asking, and the 7-day sweep cleans it. A failed write only loses
 *  the saved copy — the cut result still goes to the model, with no path named. */
export async function capResultAndSave(sessionId: string, toolName: string, text: string, roomTokens: number, hint?: string): Promise<string> {
  const headOnly = toolName === 'Read';
  const cut = capResultToRoom(text, roomTokens, { hint, headOnly });
  if (cut === text || NO_SAVE.has(toolName)) return cut;
  let savedPath: string | undefined;
  try {
    const dir = spillDirFor(sessionId);
    // Async on purpose: the main process serves every window, so it never blocks on disk.
    await fs.promises.mkdir(dir, { recursive: true });
    sweepOldSpillFilesOnce();
    savedPath = path.join(dir, `result-${toolName.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}-${randomUUID()}.txt`);
    await fs.promises.writeFile(savedPath, text);
  } catch {
    savedPath = undefined;
  }
  return capResultToRoom(text, roomTokens, { hint, headOnly, savedPath });
}
