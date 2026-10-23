// The ONE place that knows the words the Claude Code queue adds around what the person typed.
// claude-queue-input.ts builds the "wire" with these; transcript-watcher.ts takes them back off, so the chat
// shows the person's own words and file chips instead of the instructions Claude Code received.

const READ_PREFIX = 'Read this entire file: ';
const READ_FOOTER = 'Use Read before answering; read large text in chunks if needed. If a file is unavailable or cannot be read, say so. Do not assume the file contents were supplied automatically.';
const ATTACHED = 'Attached: ';

/**
 * Assemble the wire. `mentioned` = files the person named with @ (each gets the read instruction Destin chose, 2026-10-19);
 * `attached` = files attached to the message (pasted images, dropped or picked files).
 * WHY attachments go at the END as plain "Attached:" lines (Destin, 2026-10-22): the read instruction was meant for @ references
 * only, and a message that STARTS with a bare path sent mid-reply was held until the reply ended (2026-10-19 probe).
 */
export function formatQueueWire(body: string, mentioned: readonly string[], attached: readonly string[]): string {
  let wire = body;
  if (mentioned.length) wire = mentioned.map(file => READ_PREFIX + JSON.stringify(file)).join('\n') + '\n' + READ_FOOTER + '\n\n' + wire;
  if (attached.length) wire = wire + (wire ? '\n\n' : '') + attached.map(file => ATTACHED + JSON.stringify(file)).join('\n');
  return wire;
}

/** One `"…"` path as formatQueueWire wrote it (a JSON string), or null. */
function quotedPath(text: string): string | null {
  if (!text.startsWith('"') || !text.endsWith('"')) return null;
  try { const value = JSON.parse(text); return typeof value === 'string' && value ? value : null; } catch { return null; }
}

/**
 * Take formatQueueWire's additions back off a recorded prompt. Text that does not carry them exactly comes back unchanged
 * with no files, so an ordinary message that merely mentions "Attached:" is never altered.
 */
export function parseQueueWire(text: string): { text: string; attached: string[] } {
  if (!text.includes(ATTACHED + '"') && !text.startsWith(READ_PREFIX)) return { text, attached: [] }; // the common case, no splitting
  let body = text;
  if (body.startsWith(READ_PREFIX)) {
    const footerAt = body.indexOf('\n' + READ_FOOTER + '\n\n');
    const lines = footerAt > 0 ? body.slice(0, footerAt).split('\n') : [];
    if (lines.length && lines.every(line => line.startsWith(READ_PREFIX) && quotedPath(line.slice(READ_PREFIX.length)) !== null)) {
      body = body.slice(footerAt + READ_FOOTER.length + 3);
    }
  }
  const attached: string[] = [];
  const lines = body.split('\n');
  let first = lines.length;
  while (first > 0) {
    const line = lines[first - 1];
    const file = line.startsWith(ATTACHED) ? quotedPath(line.slice(ATTACHED.length)) : null;
    if (file === null) break;
    attached.unshift(file); first--;
  }
  if (!attached.length) return { text: body, attached };
  // The attachment block is separated by a blank line, or is the whole message (files sent with no words).
  if (first === 0) return { text: '', attached };
  if (first >= 2 && lines[first - 1] === '') return { text: lines.slice(0, first - 1).join('\n'), attached };
  return { text: body, attached: [] };
}
