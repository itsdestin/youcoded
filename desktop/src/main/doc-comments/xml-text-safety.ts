// Shared XML 1.0 well-formedness guard for user/assistant-authored comment
// text — docs/active/reviews/2026-09-27-doc-comments-xlsx-t12-t13-review.md
// F1 (High). XML 1.0 forbids the control characters U+0000-U+0008,
// U+000B-U+000C, and U+000E-U+001F anywhere in a well-formed document (tab
// U+0009, LF U+000A, CR U+000D are the only C0 codepoints allowed) — EVEN as
// a numeric character reference, so escaping can never make an illegal
// codepoint legal; only refusing (or stripping) it can.
//
// Confirmed empirically (the review's own probe, reproduced independently
// before this fix): neither docx-comments.ts's `mutateAddComment`/
// `mutateReplyToComment` nor xlsx-comments.ts's `mutateAddXlsxComment`/
// `mutateReplyToXlsxComment` refused or escaped a raw control byte in
// comment/reply text — both wrote it straight into `<text>`/`<w:t>`,
// producing syntactically invalid XML. The app's own verify-after-write step
// didn't catch it either: `linkedom` re-parses the same invalid byte back
// out unchanged, so verification reported success and kept the corrupted
// bytes.
//
// WHY REFUSE rather than silently strip: this codebase's own "never invent
// an error cause, but do refuse what you know is unsafe" posture
// (docs/error-message-standards.md), and stripping would mean the text this
// app's own UI already showed (optimistically, before the write even
// finished) no longer matches what actually landed on disk — the same
// "nothing silently lost" principle the design's own R6 contract already
// requires of comment content generally. Tab/LF/CR are explicitly EXCLUDED
// from the forbidden set and always pass through untouched — a multi-line
// reply or a pasted table row must keep working.
//
// Shared by docx-comments.ts and xlsx-comments.ts rather than re-derived per
// module: what "illegal" means here is a fact about the XML 1.0 spec, not a
// per-format policy choice, so the two independently-maintained write
// modules (kept independent everywhere else — see write-pipeline.ts's own
// header for why) must not be allowed to silently diverge on this one
// shared fact. DocxComments.kt (Android's own Word writer) ports the same
// character class as its own `ILLEGAL_XML_CHAR_REGEX` — see that file's own
// doc comment for why Kotlin's failure mode without this check is a crash
// (an uncaught `TransformerException`), not silent corruption like
// linkedom's. XlsxComments.kt (Android's Excel port) has no write path yet
// (T19 unbuilt) — nothing to apply this to there until it does.
const ILLEGAL_XML_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

export function hasIllegalXmlChars(text: string): boolean {
  return ILLEGAL_XML_CHAR_RE.test(text);
}
