// F6 (T14 review): a shared marker for DOM text that is interaction STATE,
// not part of the document's own words — MarkdownContent.tsx's ChatImage
// placeholder ("Image from example.com · Show") is the first case, but any
// future one goes through the same attribute. Two independent walkers read
// text out of a rendered document for the doc-comments anchoring feature:
// build-menu.ts's rangeTextOffsets/selectionOffsets (SAVE time — what a new
// comment's quote/prefix/suffix are computed from) and use-quote-marks.ts's
// collectText (RESOLVE time — what resolveSelector searches). Before this
// fix neither skipped the placeholder's own text, so a selection that landed
// near an unopened image could capture "Image from example.com · Show" as
// part of a comment's context — text that is NOT the document's real content
// and changes (to nothing, once the image is shown) independently of any
// edit to the file, which would silently break re-anchoring. Both walkers
// import this SAME predicate so they always agree on what counts as "real"
// text, never drifting into two different definitions of it.
export const ANCHOR_SKIP_ATTR = 'data-anchor-skip';

/** True when `node` (expected to be a Text node) sits inside an element
 *  carrying `ANCHOR_SKIP_ATTR` — walked via `parentElement.closest`, since a
 *  bare Text node has no `closest` of its own but every element ancestor
 *  does (`closest` also matches the starting element itself). */
export function isAnchorSkipped(node: Node): boolean {
  return Boolean(node.parentElement?.closest(`[${ANCHOR_SKIP_ATTR}]`));
}
