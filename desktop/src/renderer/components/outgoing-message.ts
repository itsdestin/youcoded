// Builds the two strings a chat send needs, from ONE sanitized source.
//
// Why (2026-07-09 stray-Enter fix): the optimistic bubble is confirmed by an
// EXACT content match against the transcript user message. The PTY send
// replaces newlines with spaces (so Shift+Enter text doesn't submit early in
// the TUI input bar). These two strings used to be derived separately — the
// bubble kept its newlines, the send didn't — so a multiline message could
// never be confirmed, its `pending` flag stayed set forever, and
// useSubmitConfirmation fired a stray recovery `\r` 8s later. Deriving both
// from the same sanitized string keeps the dedup match intact.

export interface OutgoingMessage {
  /** Optimistic bubble content — must equal what CC will echo in the transcript. */
  content: string;
  /** Text written to the PTY (a trailing `\r` is appended by the caller). */
  ptyText: string;
}

export function buildOutgoingMessage(
  rawText: string,
  filePaths: string[],
): OutgoingMessage | null {
  // WHY tabs too (2026-09-23): text copied from a table carries TABs between cells, and
  // Claude Code takes a tab written to the PTY as the Tab KEY — it recorded "Purpose\tPath"
  // as "PurposePath", so the bubble never matched, stayed pinned at the bottom, and the
  // recorded copy was drawn a second time at the top. One space per tab keeps the words apart.
  const sanitized = rawText.replace(/[\r\n]+/g, ' ').replace(/\t/g, ' ').trim();
  if (!sanitized && filePaths.length === 0) return null;
  return {
    content: [...filePaths, sanitized].filter(Boolean).join(' '),
    ptyText: sanitized,
  };
}
