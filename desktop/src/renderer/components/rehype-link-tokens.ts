import type { Plugin } from 'unified';
import type { Root, Element, Text, RootContent, Parent } from 'hast';
import { detectLinkTokens } from './markdown-linkify';

/**
 * Rehype plugin: splits plain text nodes into clickable tokens — web URLs
 * (rendered as real <a> links) and file paths (rendered as filepath-token,
 * which becomes a FilepathToken chip below).
 *
 * WHY it runs in the hast (HTML AST) pass rather than on the markdown source:
 * the ancestor chain is available here, so "is this inside a code block?" is a
 * fact rather than a guess, and nothing has to be re-parsed.
 *
 * WHY it runs AFTER rehype-highlight in the plugin array: the highlighter
 * rewrites a code block's single text node into a tree of <span> tokens. Going
 * last means we split the leaves it produced, so a URL inside ```bash is found
 * and the colouring around it survives.
 *
 * Text already inside an <a> is skipped — remark-gfm has already autolinked
 * bare URLs in prose, and linkifying a link would nest anchors.
 *
 * Fenced code blocks are NO LONGER skipped (they were, for paths). A URL or a
 * path printed in a code block is the single most common way Claude hands one
 * over, and reading it out by hand was the complaint this fixes.
 */
export const rehypeLinkTokens: Plugin<[{ filepaths: boolean }], Root> =
  (options) => (tree: Root) => {
  const filepaths = options?.filepaths ?? false;

  // WHY a hand-written walk instead of visitParents + children.indexOf(node) + splice:
  // highlight.js turns a code block into one <code> with ~10 children per source line, so
  // indexOf-per-text-node and splice-per-match made this pass O(lines^2) (measured 2.0 s at
  // 20,000 lines). Walking each children array once by index and building the replacement
  // array in one go is O(children). Output is identical: the same nodes are visited in the
  // same order, replacements are never revisited, and anchors/pre ancestry is tracked as
  // flags on the way down instead of scanning the ancestor chain per text node.
  const walk = (parent: Parent, inAnchor: boolean, inPre: boolean) => {
    const children = parent.children as RootContent[];
    let out: RootContent[] | null = null; // allocated lazily at the first replacement
    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      if (node.type === 'text') {
        // Never linkify inside an existing anchor — that would nest <a> in <a>,
        // which is invalid HTML and makes the click target ambiguous.
        const replacements = inAnchor ? null : splitText(node, inPre, filepaths);
        if (replacements) {
          if (!out) out = children.slice(0, i);
          for (const r of replacements) out.push(r);
          continue;
        }
      } else if ('children' in node && Array.isArray((node as Parent).children)) {
        const el = node.type === 'element' ? (node as Element) : null;
        walk(node as Parent, inAnchor || el?.tagName === 'a', inPre || el?.tagName === 'pre');
      }
      if (out) out.push(node);
    }
    if (out) parent.children = out as typeof parent.children;
  };
  walk(tree, false, false);
};

/** Splits one text node into text + link/path elements, or returns null when nothing matched. */
function splitText(textNode: Text, inPreBlock: boolean, filepaths: boolean): RootContent[] | null {
  const matches = detectLinkTokens(textNode.value, { filepaths });
  if (matches.length === 0) return null;
  const replacements: RootContent[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) {
      replacements.push({ type: 'text', value: textNode.value.slice(cursor, m.start) });
    }
    // The matched source text is kept as the element's child even when the
    // component ignores it: CopyButton reads the raw text off this hast tree
    // (hastText), so dropping it would silently delete every path from what a
    // code block copies.
    const child: Text = { type: 'text', value: m.text };
    replacements.push(
      m.kind === 'url'
        ? ({
            type: 'element',
            tagName: 'a',
            properties: { href: m.value },
            children: [child],
          } as Element)
        : ({
            type: 'element',
            tagName: 'filepath-token',
            properties: {
              'data-path': m.value,
              'data-raw': m.text,
              // Inside a fenced block the chip styling would break the monospace grid, so
              // FilepathToken uses its quieter 'inline' variant there. Inline `backticks` keep the chip.
              ...(inPreBlock ? { 'data-in-code': 'true' } : {}),
            },
            children: [child],
          } as Element),
    );
    cursor = m.end;
  }
  if (cursor < textNode.value.length) {
    replacements.push({ type: 'text', value: textNode.value.slice(cursor) });
  }
  return replacements;
}
