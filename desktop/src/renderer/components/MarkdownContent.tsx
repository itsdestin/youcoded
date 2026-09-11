import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { Plugin, PluggableList } from 'unified';
import type { Root, Element, Text, RootContent } from 'hast';
import { visitParents } from 'unist-util-visit-parents';
import { detectLinkTokens } from './markdown-linkify';
import { Button } from './ui';
import { FilepathToken } from './FilepathToken';
import { CONVERSATIONS_FENCE, parseConversationRefs } from '../../shared/chatsearch-refs';
import ChatsearchRefBlock from './tool-views/ChatsearchRefBlock';
import { SessionRefsEnabled } from './session-refs-context';

/**
 * Rehype plugin: tag every <code> that lives inside a <pre> with data-block.
 *
 * Fix: `code()` used to infer "inline" from the ABSENCE of a className, but a
 * fenced block with no language (```\n…) gets no class from rehype-highlight
 * either — so it was rendered with the inline-code styling while every
 * languaged block got hljs styling. Two visibly different code blocks for the
 * same markdown construct. The parent chain is the only reliable signal;
 * react-markdown v10 dropped the `inline` prop it used to pass.
 */
const rehypeMarkBlockCode: Plugin<[], Root> = () => (tree: Root) => {
  visitParents(tree, 'element', (node, ancestors) => {
    const el = node as Element;
    if (el.tagName !== 'code') return;
    const inPre = ancestors.some(
      (a) => a.type === 'element' && (a as Element).tagName === 'pre',
    );
    if (inPre) el.properties = { ...el.properties, 'data-block': 'true' };
  });
};

/**
 * Rehype plugin: support the one raw-HTML construct assistant replies commonly
 * use, while keeping arbitrary model-generated HTML inert.
 *
 * react-markdown deliberately emits HTML as `raw` nodes unless rehype-raw is
 * enabled. Rendering all raw HTML would unnecessarily widen the trust boundary,
 * but leaving those nodes alone exposes standalone closing tags such as
 * `</details>` as visible text. Convert only a strict details/summary pair into
 * real HAST elements; every other raw node becomes escaped readable text with
 * its tags removed.
 */
const rehypeSafeDisclosures: Plugin<[{ disclosures?: boolean }?], Root> =
  (options) => (tree: Root) => {
  const renderDisclosures = options?.disclosures ?? true;
  const processChildren = (parent: Root | Element) => {
    const children = parent.children;
    for (let index = 0; index < children.length; index++) {
      const child = children[index] as RootContent & { value?: string };
      if (child.type === 'element') processChildren(child as Element);
      if (child.type !== 'raw' || typeof child.value !== 'string') continue;

      const combinedOpening = child.value.match(
        /^\s*<details(\s+open)?\s*>\s*<summary>\s*([^<>]*?)\s*<\/summary>\s*$/i,
      );
      const detailsOnly = child.value.match(/^\s*<details(\s+open)?\s*>\s*$/i);
      let summary = combinedOpening?.[2];
      let contentStart = index + 1;
      if (!summary && detailsOnly) {
        // CommonMark inserts newline text nodes around HTML blocks. Ignore only
        // whitespace while looking for a separately parsed <summary> node.
        let summaryIndex = index + 1;
        while (summaryIndex < children.length
          && children[summaryIndex].type === 'text'
          && hastText(children[summaryIndex]).trim() === '') summaryIndex++;
        const summaryNode = children[summaryIndex] as RootContent & { value?: string };
        const summaryMatch = summaryNode?.type === 'raw'
          ? summaryNode.value?.match(/^\s*<summary>\s*([^<>]*?)\s*<\/summary>\s*$/i)
          : null;
        if (summaryMatch) {
          summary = summaryMatch[1];
          contentStart = summaryIndex + 1;
        }
      }

      if (summary !== undefined && renderDisclosures) {
        const closingIndex = children.findIndex(
          (candidate, candidateIndex) => candidateIndex >= contentStart
            && candidate.type === 'raw'
            && /^\s*<\/details>\s*$/i.test((candidate as RootContent & { value?: string }).value ?? ''),
        );
        // Nested raw disclosures are deliberately flattened rather than paired
        // incorrectly; only one unambiguous details/summary pair is promoted.
        const hasNestedOpening = children.slice(contentStart, closingIndex).some(
          (candidate) => candidate.type === 'raw'
            && /^\s*<details(?:\s+open)?\s*>/i.test((candidate as RootContent & { value?: string }).value ?? ''),
        );
        if (closingIndex !== -1 && !hasNestedOpening) {
          // A root may technically contain a doctype, but an element may not.
          // Model replies do not need one inside a disclosure, so keep the HAST
          // child contract exact rather than casting the wider RootContent type.
          const disclosureChildren: Element['children'] = children
            .slice(contentStart, closingIndex)
            .filter((candidate) => candidate.type !== 'doctype');
          const details: Element = {
            type: 'element',
            tagName: 'details',
            properties: (combinedOpening?.[1] ?? detailsOnly?.[1]) ? { open: true } : {},
            children: [
              {
                type: 'element',
                tagName: 'summary',
                properties: {},
                children: [{ type: 'text', value: summary }],
              },
              ...disclosureChildren,
            ],
          };
          processChildren(details);
          children.splice(index, closingIndex - index + 1, details);
          continue;
        }
      }

      // WHY: preserve words from unsupported HTML without ever handing raw HTML
      // to React. The tag matcher respects quoted `>` characters, so attributes
      // cannot spill into text and become clickable in the later linkify pass.
      const readable = child.value.replace(/<(?:"[^"]*"|'[^']*'|[^'">])*>/g, '').trim();
      children.splice(index, 1, ...(readable ? [{ type: 'text' as const, value: readable }] : []));
      if (!readable) index--;
    }
  };

  processChildren(tree);
};

/**
 * Collect the raw text of a hast subtree.
 *
 * Fix: the Copy button used to read `child.props.children` and only accepted a
 * STRING, but rehype-highlight replaces the code element's single text node
 * with a tree of <span>s the moment highlight.js recognises any token — so the
 * button silently vanished on exactly the blocks worth copying (```json,
 * ```python, any bash with a comment) and survived only on blocks the
 * highlighter failed to tokenise. Reading the hast node instead is immune to
 * whatever the highlighter did to the element tree.
 */
function hastText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; value?: string; children?: unknown[] };
  if (n.type === 'text') return n.value ?? '';
  if (Array.isArray(n.children)) return n.children.map(hastText).join('');
  return '';
}

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
const rehypeLinkTokens: Plugin<[{ filepaths: boolean }], Root> =
  (options) => (tree: Root) => {
  const filepaths = options?.filepaths ?? false;
  // visitParents provides the full ancestor chain, which is what tells us
  // whether we are inside an existing link or inside a fenced code block.
  visitParents(tree, 'text', (node, ancestors) => {
    const parent = ancestors[ancestors.length - 1];
    if (!parent) return;
    const index = (parent as Element | Root).children.indexOf(node as Text);
    if (index === -1) return;

    // Never linkify inside an existing anchor — that would nest <a> in <a>,
    // which is invalid HTML and makes the click target ambiguous.
    if (ancestors.some((a) => a.type === 'element' && (a as Element).tagName === 'a')) return;

    // Inside a fenced block the chip styling would break the monospace grid, so
    // FilepathToken uses its quieter 'inline' variant there (see the component
    // map below). Inline `backticks` keep the chip.
    const inPreBlock = ancestors.some(
      (a) => a.type === 'element' && (a as Element).tagName === 'pre',
    );

    const textNode = node as Text;
    const matches = detectLinkTokens(textNode.value, { filepaths });
    if (matches.length === 0) return;

    // Split the text node into a sequence of text + token elements.
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

    // Replace the original text node with our sequence in the parent's children array.
    (parent as Element | Root).children.splice(index as number, 1, ...replacements);
    // Skip past the newly-inserted nodes — they're already processed.
    return index + replacements.length;
  });
};

// Stable plugin arrays — avoids re-creating on every render. URL linkification
// runs in EVERY context (it needs no session), so it lives in the stable array;
// only the filepath half, which needs a sessionId to resolve a click, is
// switched on per-session in the memo below.
const remarkPluginsStable = [remarkGfm];
const rehypePluginsStable: PluggableList = [
  rehypeSafeDisclosures,
  rehypeHighlight,
  rehypeMarkBlockCode,
  [rehypeLinkTokens, { filepaths: false }],
];
const rehypePluginsWithFilepaths: PluggableList = [
  rehypeSafeDisclosures,
  rehypeHighlight,
  rehypeMarkBlockCode,
  [rehypeLinkTokens, { filepaths: true }],
];
const rehypePluginsPreview: PluggableList = [
  [rehypeSafeDisclosures, { disclosures: false }],
  rehypeHighlight,
  rehypeMarkBlockCode,
  [rehypeLinkTokens, { filepaths: false }],
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  // WHY the timer is held and cleared (2026-09-10): the reset was a bare
  // setTimeout, so a copy followed by the message closing within two seconds
  // fired setState on an unmounted component. In the app that is a React warning;
  // under vitest it is `ReferenceError: window is not defined` from react-dom
  // AFTER jsdom is torn down, which vitest reports as an unhandled error — the run
  // goes red while every test shows passed, so the failure names nothing.
  // `.claude/rules/test-suite-hygiene.md` -> "Unmount what you render".
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, []);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      // ghost, not secondary (spec §11 decision 74): this floats over a code
      // block, and a bordered button would draw a visible box on top of the code.
      variant="ghost"
      size="sm"
      onClick={handleCopy}
      // Floating overlay control in the code block's corner, so opacity-0 at rest
      // is correct and stays (spec decision 74). focus-visible:opacity-100 is new:
      // at opacity-0 the button was invisible to keyboard users who tabbed to it.
      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
    >
      {copied ? 'Copied!' : 'Copy'}
    </Button>
  );
}

// Stable component overrides — defined at module scope so ReactMarkdown
// receives the same object reference on every render, preventing unnecessary
// reconciliation of the entire markdown tree.
const mdComponents = {
  h1({ children, ...props }: any) {
    return <h1 className="text-xl font-bold mt-6 mb-3 pb-1.5 text-fg border-b border-edge" {...props}>{children}</h1>;
  },
  h2({ children, ...props }: any) {
    return <h2 className="text-lg font-bold mt-6 mb-3 pb-1 text-fg border-b border-edge" {...props}>{children}</h2>;
  },
  h3({ children, ...props }: any) {
    return <h3 className="text-base font-bold mt-5 mb-2 text-fg" {...props}>{children}</h3>;
  },
  h4({ children, ...props }: any) {
    return <h4 className="text-sm font-bold mt-4 mb-1.5 text-fg" {...props}>{children}</h4>;
  },
  p({ children, ...props }: any) {
    return <p className="mb-3 last:mb-0 leading-relaxed" {...props}>{children}</p>;
  },
  ol({ children, ...props }: any) {
    return <ol className="list-decimal pl-6 mb-3 space-y-1.5" {...props}>{children}</ol>;
  },
  ul({ children, ...props }: any) {
    return <ul className="list-disc pl-6 mb-3 space-y-1.5" {...props}>{children}</ul>;
  },
  li({ children, ...props }: any) {
    return <li className="leading-relaxed" {...props}>{children}</li>;
  },
  hr({ ...props }: any) {
    return <hr className="border-edge my-5" {...props} />;
  },
  blockquote({ children, ...props }: any) {
    return (
      <blockquote className="border-l-2 border-edge pl-3 my-3 text-fg-dim italic" {...props}>
        {children}
      </blockquote>
    );
  },
  strong({ children, ...props }: any) {
    return <strong className="font-bold text-fg" {...props}>{children}</strong>;
  },
  em({ children, ...props }: any) {
    return <em className="italic text-fg-2" {...props}>{children}</em>;
  },
  pre({ children, node, ...props }: any) {
    // Text comes from the source AST, not the rendered children — see hastText.
    const codeText = hastText(node);
    // A `conversations` fence is not code: it is the assistant naming past
    // conversations inside its own message, and the renderer draws them as a
    // reference block (compare Round 8 A). Gated on the context so this only
    // happens in a live assistant bubble — a PAST conversation being previewed
    // could contain the same fence, and resolving ids from another device
    // inside a read-only transcript would render a block of dead rows.
    if (isConversationsFence(node)) {
      return <ConversationsFence body={codeText} />;
    }
    return (
      // yc-code-block carries content-visibility so the browser can skip layout
      // and paint for blocks scrolled out of view — see globals.css. A document
      // with hundreds of fences is otherwise laid out in full before it paints.
      <div className="yc-code-block relative group my-3">
        {/* yc-code is the hook the globals.css rule needs to out-specify
            highlight.js's own `pre code.hljs` box (see the .yc-code block
            there). Don't drop it. */}
        <pre className="yc-code rounded-md bg-canvas border border-edge p-3 overflow-x-auto text-sm text-fg" {...props}>
          {children}
        </pre>
        {codeText && <CopyButton text={codeText} />}
      </div>
    );
  },
  code({ className, children, node, ...props }: any) {
    // Block vs inline comes from the parent chain (rehypeMarkBlockCode), NOT
    // from "has a className" — an unlanguaged fence has neither.
    const isBlock = props['data-block'] !== undefined;
    if (!isBlock) {
      return (
        <code className="text-sm text-code" {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  a({ href, children, ...props }: any) {
    const isSafeHref = href && /^(https?:|mailto:)/.test(href);
    if (!isSafeHref) {
      return <span className="text-link">{children}</span>;
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-link hover:text-link-hover underline"
        {...props}
      >
        {children}
      </a>
    );
  },
  table({ children, ...props }: any) {
    return (
      <div className="overflow-x-auto my-3">
        <table className="border-collapse border border-edge text-sm w-full" {...props}>
          {children}
        </table>
      </div>
    );
  },
  th({ children, ...props }: any) {
    return (
      <th className="border border-edge px-3 py-2 bg-panel text-left font-bold text-fg" {...props}>
        {children}
      </th>
    );
  },
  td({ children, ...props }: any) {
    return (
      <td className="border border-edge px-3 py-2" {...props}>
        {children}
      </td>
    );
  },
};

/** Does this <pre> hold a fenced block whose language is `conversations`? */
function isConversationsFence(node: any): boolean {
  const code = node?.children?.find((c: any) => c?.tagName === 'code');
  const classes = code?.properties?.className;
  const list = Array.isArray(classes) ? classes : typeof classes === 'string' ? classes.split(/\s+/) : [];
  return list.includes(`language-${CONVERSATIONS_FENCE}`);
}

function ConversationsFence({ body }: { body: string }) {
  const enabled = React.useContext(SessionRefsEnabled);
  const ids = React.useMemo(() => parseConversationRefs(body), [body]);
  // Not enabled here: fall back to what the text says on its own, rather than
  // silently swallowing the block.
  if (!enabled) return <pre className="yc-code rounded-md bg-canvas border border-edge p-3 overflow-x-auto text-sm text-fg">{body}</pre>;
  return <ChatsearchRefBlock shortIds={ids} />;
}
// Preview mode: the same renderer with NOTHING interactive in it. WHY: a file tile is itself a
// <button> (FilesTab, Deliverables), and the code-block Copy button / links inside a rendered
// markdown preview made a <button> inside a <button> — invalid HTML, a React error on every
// Projects screen (found by the 2026-08-27 sweep). Code blocks keep their look, links read as text.
const mdPreviewComponents = {
  ...mdComponents,
  pre({ children, node: _node, ...props }: any) {
    return (
      <pre className="yc-code rounded-md bg-canvas border border-edge p-3 overflow-x-auto text-sm text-fg my-3" {...props}>
        {children}
      </pre>
    );
  },
  a({ href: _href, children, ...props }: any) {
    return <span className="text-link underline" {...props}>{children}</span>;
  },
  // Same reason as the <a> above: a preview tile is itself a <button>, so the
  // path renders as its own text and nothing inside is focusable.
  'filepath-token': ({ node, ...props }: any) => {
    const p = (node as Element)?.properties ?? {};
    const raw = (p['data-raw'] as string) ?? (p['data-path'] as string) ?? props['data-raw'] ?? '';
    return <span className="text-fg-dim">{raw}</span>;
  },
};

interface Props {
  content: string;
  /** When provided, file paths detected in text are rendered as FilepathToken chips. */
  sessionId?: string;
  /** Decorative rendering for tiles: no Copy buttons, no links — nothing focusable or clickable. */
  preview?: boolean;
}

export default React.memo(function MarkdownContent({ content, sessionId, preview }: Props) {
  // Memoize the rehype plugin array and the component map by sessionId so that:
  // (a) When sessionId is absent, we use the stable module-scope arrays (no allocation).
  // (b) When sessionId is present, the filepath-token component is added once and
  //     remains stable across re-renders for the same session.
  // Both arrays are module-level constants, so this only picks between them —
  // URLs are linkified either way; the filepath half needs a session to resolve
  // a click against, and in preview mode nothing may be clickable at all.
  const rehypePlugins = preview
    ? rehypePluginsPreview
    : sessionId
      ? rehypePluginsWithFilepaths
      : rehypePluginsStable;

  const components = useMemo(() => {
    if (preview) return mdPreviewComponents;
    if (!sessionId) return mdComponents;
    // Extend the base component map with a handler for our custom <filepath-token> hast element.
    // react-markdown lowercases custom element names, so 'filepath-token' matches the tagName.
    return {
      ...mdComponents,
      // react-markdown v10 passes custom hast element props directly.
      // 'data-path' becomes 'data-path' in props (React preserves data-* attrs).
      'filepath-token': ({ node, ...props }: any) => {
        const p = (node as Element)?.properties ?? {};
        const path: string = (p['data-path'] as string) ?? props['data-path'] ?? '';
        if (!path) return null;
        // Inside a fenced code block a bordered chip would break the monospace
        // grid and hide the rest of the command, so the quieter dotted-underline
        // variant is used and it keeps the path EXACTLY as written.
        const inCode = (p['data-in-code'] ?? props['data-in-code']) !== undefined;
        const raw = (p['data-raw'] as string) ?? props['data-raw'] ?? path;
        if (inCode) {
          return <FilepathToken path={path} sessionId={sessionId} variant="inline" label={raw} />;
        }
        return <FilepathToken path={path} sessionId={sessionId} />;
      },
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, preview]);

  return (
    <ReactMarkdown
      remarkPlugins={remarkPluginsStable}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
});
