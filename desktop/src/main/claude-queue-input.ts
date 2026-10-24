import fs from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_QUEUE_WIRE_LIMITS, CLAUDE_QUEUE_COMPOSER_DROPPED } from '../shared/claude-queue-wire-limits';
import { formatQueueWire } from '../shared/claude-queue-wire';

interface QueueInput {
  text: string;
  attachments: readonly string[];
  cwd: string;
}

// WHY: Markdown code can use arbitrary delimiter lengths. Fixed triple/single regexes rewrite valid
// double-backtick spans and longer fences. Keep unmatched regions conservative and scan each region once.
function splitCode(text: string): string[] {
  const parts: string[] = []; let at = 0; let i = 0; let lineStart = 0;
  while (i < text.length) {
    if (text[i] === '\n') { lineStart = ++i; continue; }
    const delimiter = text[i];
    if (delimiter !== '`' && delimiter !== '~') { i++; continue; }
    let runEnd = i + 1;
    while (text[runEnd] === delimiter) runEnd++;
    const width = runEnd - i;
    const fence = width >= 3 && i - lineStart <= 3 && /^ *$/.test(text.slice(lineStart, i));
    if (delimiter === '~' && !fence) { i = runEnd; continue; }
    let end = text.length;
    if (fence) {
      let row = text.indexOf('\n', runEnd);
      while (row !== -1 && row + 1 < text.length) {
        const start = row + 1; const newline = text.indexOf('\n', start);
        const rowEnd = newline === -1 ? text.length : newline;
        let marker = start;
        while (marker - start < 3 && text[marker] === ' ') marker++;
        let close = marker;
        while (text[close] === delimiter) close++;
        if (close - marker >= width && /^\s*$/.test(text.slice(close, rowEnd))) { end = rowEnd; break; }
        row = newline;
      }
    } else {
      let next = text.indexOf('`', runEnd);
      while (next !== -1) {
        let close = next + 1;
        while (text[close] === '`') close++;
        if (close - next === width) { end = close; break; }
        next = text.indexOf('`', close);
      }
    }
    const code = text.slice(i, end);
    parts.push(text.slice(at, i), code);
    const newline = code.lastIndexOf('\n');
    if (newline !== -1) lineStart = i + newline + 1;
    at = i = end;
  }
  parts.push(text.slice(at));
  return parts;
}

function prepared(wireText: string, files: string[]): { wireText: string; files: string[] } {
  if (wireText.length > CLAUDE_QUEUE_WIRE_LIMITS.maxCharacters
    || Buffer.byteLength(JSON.stringify(wireText), 'utf8') > CLAUDE_QUEUE_WIRE_LIMITS.maxJsonBytes) {
    throw Error('Prepared queued message is too large; shorten it or remove file references.');
  }
  return { wireText, files };
}

/** Prepare literal user text, not synthetic transcript content or preloaded file data. */
export async function prepareClaudeQueueInput(input: QueueInput): Promise<{ wireText: string; files: string[] }> {
  const { text, attachments, cwd } = input;
  if (!path.isAbsolute(cwd)) throw Error('Queue working folder must be absolute');
  if (typeof text !== 'string' || text.includes('\0') || text.length > 262_144 || cwd.includes('\0')) throw Error('Invalid queued message');
  if (!Array.isArray(attachments) || attachments.length > 32) throw Error('Too many queued attachments');
  const files: string[] = [];
  const add = (file: string) => {
    if (!files.includes(file)) {
      if (files.length >= 32) throw Error('Too many queued file references');
      files.push(file);
    }
  };
  // Attached files and @-mentioned files get different wording (formatQueueWire); a file that is both is a mention.
  const attached: string[] = []; const mentioned: string[] = [];
  for (const attachment of attachments) {
    if (typeof attachment !== 'string' || !attachment || attachment.includes('\0') || attachment.length > 4096) throw Error('Invalid queued attachment');
    const file = path.resolve(cwd, attachment);
    let stat;
    try { stat = await fs.stat(file); } catch { throw Error('A queued attachment is unavailable: ' + attachment); }
    if (!stat.isFile()) throw Error('Queued attachment is not a file: ' + attachment);
    add(file); if (!attached.includes(file)) attached.push(file);
  }

  // WHY: only resolve real files outside code; an email, decorator example or nonexistent name is not proof of file intent.
  // The queue preserves the ORIGINAL text/attachments separately. This is the explicitly requested model-facing read instruction.
  const parts = splitCode(text);
  let candidates = 0;
  for (let n = 0; n < parts.length; n += 2) {
    const source = parts[n];
    const mentions = /(^|[\s(])@(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s<>()\[\]{}"'`,;!?]+))/gu;
    let result = ''; let at = 0;
    for (const match of source.matchAll(mentions)) {
      if (++candidates > 64) throw Error('Too many queued reference candidates');
      const candidate = match[2] ?? match[3] ?? match[4];
      if (candidate.length > 4096) continue;
      let selected: string | undefined; let suffix = '';
      const variants = [candidate];
      if (match[4] && /[.:]$/.test(candidate)) variants.push(candidate.slice(0, -1));
      for (const variant of variants) {
        const file = path.resolve(cwd, variant);
        try {
          if ((await fs.stat(file)).isFile()) { selected = file; suffix = candidate.slice(variant.length); break; }
        } catch { /* A mention that cannot be resolved remains literal; explicit attachments refuse above. */ }
      }
      if (!selected) continue;
      add(selected); if (!mentioned.includes(selected)) mentioned.push(selected);
      result += source.slice(at, match.index) + match[1] + JSON.stringify(selected) + suffix;
      at = match.index + match[0].length;
    }
    parts[n] = result + source.slice(at);
  }
  // WHY strip (2026-10-22): Claude Code's message box drops these characters, so a wire holding one never read back
  // exactly and the message sat in the box "Unconfirmed". The model would not have received them anyway.
  const body = parts.join('').replace(/\r\n?/g, '\n').replace(new RegExp(CLAUDE_QUEUE_COMPOSER_DROPPED, 'gu'), '');
  // WHY: leading bare paths can take a different native queue route. Explicit instructions reached the same running turn in real CLI probes.
  const wire = formatQueueWire(body, mentioned, attached.filter(file => !mentioned.includes(file)));
  // Never stage an empty box: Enter would do nothing and the send would sit unresolved.
  if (!wire.trim()) throw Error('Nothing to send: the message held only characters Claude Code cannot receive.');
  return prepared(wire, files);
}
