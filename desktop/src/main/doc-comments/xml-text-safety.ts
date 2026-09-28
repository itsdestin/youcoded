// Shared XML 1.0 well-formedness guard for user/assistant-authored comment
// text — used by xlsx-comments.ts and docx-comments.ts (and ported to
// Android's DocxComments.kt). XML 1.0 forbids the control characters
// U+0000-U+0008, U+000B-U+000C, and U+000E-U+001F anywhere in a
// well-formed document (tab U+0009, LF U+000A, CR U+000D are the only C0
// codepoints allowed) — EVEN as a numeric character reference, so escaping
// can never make an illegal codepoint legal; only removing it can.
//
// Originally (commit ffda4b654) this REFUSED text containing one of these
// characters outright. Changed to STRIP them instead (2026-09-27): these
// characters arrive invisibly — almost always via paste from a PDF, a badly
// exported spreadsheet, or a legacy Windows-1252 document — so a user has no
// way to see the offending character, let alone remove it themselves. A
// refusal they cannot act on is strictly worse than silently dropping a
// handful of control bytes nobody can see, especially since the VISIBLE text
// is completely unaffected (tab/LF/CR — the only C0 codepoints anyone could
// intentionally type — are explicitly excluded from the strip and always
// pass through untouched, so a multi-line reply or a pasted table row keeps
// working exactly as before).
//
// Shared by docx-comments.ts and xlsx-comments.ts rather than re-derived per
// module: what "illegal" means here is a fact about the XML 1.0 spec, not a
// per-format policy choice, so the two independently-maintained write
// modules (kept independent everywhere else — see write-pipeline.ts's own
// header for why) must not be allowed to silently diverge on this one
// shared fact. DocxComments.kt (Android's own Word writer) ports the same
// character class as its own `stripIllegalXmlChars` — see that file's own
// doc comment for why Kotlin's failure mode without this check is a crash
// (an uncaught `TransformerException`), not silent corruption like
// linkedom's. XlsxComments.kt (Android's Excel port) has no write path yet
// (T19 unbuilt) — nothing to apply this to there until it does.
const ILLEGAL_XML_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

/** Removes every XML 1.0-illegal control character from `text`, leaving tab
 *  (U+0009), LF (U+000A) and CR (U+000D) — and everything else — untouched.
 *  Callers apply this to comment/reply text immediately before it's written
 *  into a docx/xlsx archive's XML; the caller's own response should return
 *  this stripped value (not the original) so the renderer shows exactly
 *  what landed on disk. */
export function stripIllegalXmlChars(text: string): string {
  return text.replace(ILLEGAL_XML_CHAR_RE, '');
}
