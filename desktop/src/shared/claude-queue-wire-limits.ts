// Shared by preparation and the delivery adapter: limits apply AFTER file-path instructions are assembled.
export const CLAUDE_QUEUE_WIRE_LIMITS = {
  maxCharacters: 262_144,
  // JSON string encoding is measured, leaving room inside the bridge's 1 MiB envelope for identity/lease metadata.
  maxJsonBytes: 512 * 1024,
} as const;

// WHY (2026-10-22): characters Claude Code's message box silently drops when text is put in (measured on CLI 2.1.309,
// test-conpty/probe-composer-fill.mjs). A wire holding one never read back exactly, so the message sat in the box
// "Unconfirmed". Regular-expression character classes; keep in step with docs/cc-dependencies.md.
// ALWAYS dropped: preparation strips these from what the person typed (the model would never have received them).
export const CLAUDE_QUEUE_COMPOSER_DROPPED = '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u00AD\\u034F\\u200B\\u200E\\u2060\\uFEFF]';
// Dropped only outside a real joining context (kept inside emoji sequences, Persian, Indic): never stripped by the host,
// only tolerated by the plugin's ownership check, which then submits the exact original bytes.
export const CLAUDE_QUEUE_COMPOSER_MAY_DROP = '[\\u200C\\u200D]';

// WHY (2026-11-10, card #246): Claude Code's box SHOWS text over 10,000 characters shortened — the first 500, then
// "[...Truncated text #N +L lines...]" (L = line breaks in the hidden middle), then the last 500 — while Enter still
// submits the whole text (measured on CLI 2.1.322, test-conpty/probe-composer-long.mjs). The queue's read-back must
// recognise that exact shape as its own, or every message over 10,000 characters sits in the box "Unconfirmed".
// Keep in step with docs/cc-dependencies.md ("Queued native composer transport").
export const CLAUDE_QUEUE_COMPOSER_SHORTEN = { over: 10_000, keep: 500 } as const;
