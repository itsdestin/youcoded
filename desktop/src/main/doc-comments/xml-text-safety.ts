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

// WHY (2026-09-28 PR review): linkedom — the DOM both write modules parse and
// serialize with — happily writes an element or attribute whose namespace
// prefix was never declared (`<w:p w14:paraId="…">` inside a comments.xml
// with no `xmlns:w14`). That output is not well-formed XML: Word and Excel
// refuse or "repair" the file. The after-save verify re-reads with the same
// lenient linkedom, so it could not notice. This is the missing strict check:
// every prefix a part USES must be DECLARED somewhere in it. It is judged
// against the part's own original text (see `introducesUndeclaredPrefix`), so
// a file that already arrived broken never blocks an unrelated write.
// Only markup is scanned (text between tags is skipped), so a comment that
// happens to read "ratio:1=2" can never look like an attribute.
const TAG_RE = /<[^!?][^>]*>/g;
const TAG_NAME_PREFIX_RE = /^<\/?([A-Za-z_][\w.-]*):/;
const ATTR_PREFIX_RE = /\s([A-Za-z_][\w.-]*):[\w.-]+\s*=/g;
const DECLARED_PREFIX_RE = /\sxmlns:([A-Za-z_][\w.-]*)\s*=/g;

/** Prefixes `xml` uses on an element or attribute but never declares with
 *  `xmlns:<prefix>` (the reserved `xml`/`xmlns` prefixes excepted). A
 *  declaration anywhere in the part counts — a deliberately lenient reading,
 *  since this only has to catch prefixes that are declared NOWHERE. */
function undeclaredPrefixes(xml: string): Set<string> {
  const declared = new Set<string>(['xml', 'xmlns']);
  const used = new Set<string>();
  for (const [tag] of xml.matchAll(TAG_RE)) {
    for (const m of tag.matchAll(DECLARED_PREFIX_RE)) declared.add(m[1]);
    const name = TAG_NAME_PREFIX_RE.exec(tag);
    if (name) used.add(name[1]);
    for (const m of tag.matchAll(ATTR_PREFIX_RE)) used.add(m[1]);
  }
  return new Set([...used].filter((prefix) => !declared.has(prefix)));
}

/** True when `after` leaves a prefix undeclared that `before` (the same
 *  part's text before this write, or `null` for a brand-new part) did not. */
export function introducesUndeclaredPrefix(before: string | null, after: string): boolean {
  const already = before === null ? new Set<string>() : undeclaredPrefixes(before);
  for (const prefix of undeclaredPrefixes(after)) {
    if (!already.has(prefix)) return true;
  }
  return false;
}
