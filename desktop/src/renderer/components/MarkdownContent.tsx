import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { Plugin, PluggableList } from 'unified';
import type { Root, Element, RootContent } from 'hast';
import { visitParents } from 'unist-util-visit-parents';
import { rehypeLinkTokens } from './rehype-link-tokens';
import { Button } from './ui';
import { FilepathToken } from './FilepathToken';
import { CONVERSATIONS_FENCE, parseConversationRefs } from '../../shared/chatsearch-refs';
import ChatsearchRefBlock from './tool-views/ChatsearchRefBlock';
import { SessionRefsEnabled } from './session-refs-context';
import { ANCHOR_SKIP_ATTR } from './comments/anchor-skip';
import {
  startStream, advanceStream, withDefinitions, splitOpenFence, fenceChunks, scanOpenList, listSplitOf, type ListScan, type StreamView,
  DETAILS_OPEN_WITH_SUMMARY, DETAILS_OPEN, DETAILS_SUMMARY, DETAILS_CLOSE, DETAILS_OPEN_ANY,
  fenceOverHighlightLimit, canDrawInSlices, sliceCuts, nextSliceEnd, PROGRESSIVE_FIRST_CHARS, PROGRESSIVE_BATCH_CHARS,
} from './markdown-blocks';

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

      // The patterns are shared with markdown-blocks.ts, whose streaming planner
      // must predict exactly which blocks this pairs (see DETAILS_* there).
      const combinedOpening = child.value.match(DETAILS_OPEN_WITH_SUMMARY);
      const detailsOnly = child.value.match(DETAILS_OPEN);
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
          ? summaryNode.value?.match(DETAILS_SUMMARY)
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
            && DETAILS_CLOSE.test((candidate as RootContent & { value?: string }).value ?? ''),
        );
        // Nested raw disclosures are deliberately flattened rather than paired
        // incorrectly; only one unambiguous details/summary pair is promoted.
        const hasNestedOpening = children.slice(contentStart, closingIndex).some(
          (candidate) => candidate.type === 'raw'
            && DETAILS_OPEN_ANY.test((candidate as RootContent & { value?: string }).value ?? ''),
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
/** How many lines a <pre> shows for this text: a final newline does not start another line. Always at least 1. */
export function codeLineCount(text: string): number {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  let n = 1;
  for (let i = body.indexOf('\n'); i !== -1; i = body.indexOf('\n', i + 1)) n++;
  return n;
}

function hastText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; value?: string; children?: unknown[] };
  if (n.type === 'text') return n.value ?? '';
  if (Array.isArray(n.children)) return n.children.map(hastText).join('');
  return '';
}

/**
 * rehype-highlight, but with ONE highlighter shared by every render.
 *
 * WHY (perf-lab 2026-10-04): rehype-highlight builds a new highlighter and
 * registers its ~37 languages every time react-markdown builds its processor —
 * which is once per render, so once per streamed word. Measured: ~1.8 s of a
 * 34 s reply stream, in ordinary prose as well as in code. Calling the plugin once
 * and handing react-markdown the same transform each time gives byte-identical
 * output (same library, same languages, same options) without the rebuild.
 */
const sharedHighlight = (rehypeHighlight as unknown as () => (tree: Root, file: unknown) => void)();
/**
 * WHY a wrapper (freeze hunt 2026-10-22, item 2): a fence over the size limit
 * (markdown-blocks.ts HIGHLIGHT_MAX_LINES / _CHARS) skips colouring so one huge
 * block cannot freeze the page for seconds. rehype-highlight only touches a code
 * element that names a language, so the big block's language class is dropped
 * BEFORE it runs - the block then comes out exactly like a fence written with no
 * language (no .hljs class, same box, same Copy button). Only direct text is
 * counted, which is all an uncoloured fence holds.
 */
function dropLanguageFromHugeFences(tree: Root) {
  visitParents(tree, 'element', (node, ancestors) => {
    const el = node as Element;
    if (el.tagName !== 'code' || !Array.isArray(el.properties?.className)) return;
    const parent = ancestors[ancestors.length - 1] as Element | undefined;
    if (parent?.type !== 'element' || parent.tagName !== 'pre') return;
    const texts = el.children.flatMap((child) => (child.type === 'text' ? [child.value] : []));
    if (!fenceOverHighlightLimit(...texts)) return;
    const rest = (el.properties.className as string[]).filter((c) => !/^(?:lang|language)-/.test(String(c)));
    // An empty class list would print class="" - delete it so the markup equals a no-language fence's.
    if (rest.length) el.properties.className = rest;
    else delete el.properties.className;
  });
}
const rehypeHighlightShared: Plugin<[], Root> = () => (tree: Root, file: unknown) => {
  dropLanguageFromHugeFences(tree);
  sharedHighlight(tree, file);
};
/** The plugin list without colouring: for the pieces of a streaming fence already over the limit. */
const uncolouredCache = new WeakMap<PluggableList, PluggableList>();
function withoutColour(plugins: PluggableList): PluggableList {
  let u = uncolouredCache.get(plugins);
  if (!u) {
    u = plugins.filter((p) => p !== rehypeHighlightShared);
    uncolouredCache.set(plugins, u);
  }
  return u;
}

// Stable plugin arrays — avoids re-creating on every render. URL linkification
// runs in EVERY context (it needs no session), so it lives in the stable array;
// only the filepath half, which needs a sessionId to resolve a click, is
// switched on per-session in the memo below.
const remarkPluginsStable = [remarkGfm];
const rehypePluginsStable: PluggableList = [
  rehypeSafeDisclosures,
  rehypeHighlightShared,
  rehypeMarkBlockCode,
  [rehypeLinkTokens, { filepaths: false }],
];
const rehypePluginsWithFilepaths: PluggableList = [
  rehypeSafeDisclosures,
  rehypeHighlightShared,
  rehypeMarkBlockCode,
  [rehypeLinkTokens, { filepaths: true }],
];
const rehypePluginsPreview: PluggableList = [
  [rehypeSafeDisclosures, { disclosures: false }],
  rehypeHighlightShared,
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
      data-message-find-ignore
      // WHY: Copy/Copied is code chrome, not a word of the assistant's message.
      // Floating overlay control in the code block's corner, so opacity-0 at rest
      // is correct and stays (spec decision 74). focus-visible:opacity-100 is new:
      // at opacity-0 the button was invisible to keyboard users who tabbed to it.
      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
    >
      {copied ? 'Copied!' : 'Copy'}
    </Button>
  );
}

/** A picture referenced from an assistant message.
 *
 *  WHY (2026-09-10 security review, Destin's "tap to show"): a `![](https://…)`
 *  in a reply used to load the moment the message rendered — and the web address
 *  can carry stolen text (`https://x/?d=<secret>`), so a prompt-injected model
 *  could exfiltrate with no tool call and no click. A picture from a WEBSITE now
 *  waits behind a Show button (the request only leaves once the person taps it);
 *  a relative/app-local src has no network fetch and renders inline. (data:/blob:
 *  never reach here — react-markdown's urlTransform drops them before this.)
 *
 *  Parsed with the URL constructor, NOT a `https://` prefix regex: `https:evil/x`
 *  (one slash, or none) is normalised by the browser to `https://evil/x` and
 *  fetched all the same, but a strict-prefix check read it as local — a
 *  one-character bypass of the whole gate (2026-09-10 review). */
function isNetworkImageSrc(src: string): boolean {
  const s = src.trim();
  if (s.startsWith('//')) return true; // protocol-relative → the page's scheme
  try {
    const proto = new URL(s).protocol;
    return proto === 'http:' || proto === 'https:' || proto === 'ftp:' || proto === 'ws:' || proto === 'wss:';
  } catch {
    return false; // no scheme → relative / app-local, no network request
  }
}

function ChatImage({ src, alt, ...props }: any) {
  const [shown, setShown] = useState(false);
  const source = typeof src === 'string' ? src : '';
  if (!source || !isNetworkImageSrc(source)) {
    // data:/blob:/app-local — no network request, safe to render.
    return <img src={source} alt={alt} className="max-w-full rounded my-2" {...props} />;
  }
  if (shown) {
    return <img src={source} alt={alt} className="max-w-full rounded my-2" {...props} />;
  }
  let host = 'a website';
  try { host = new URL(source).host || host; } catch { /* keep the generic label */ }
  return (
    <button
      type="button"
      onClick={() => setShown(true)}
      // F6 (doc-comments T14 review): this label is interaction STATE (it
      // disappears the moment the image is shown), not part of the document's
      // own words — ANCHOR_SKIP_ATTR (anchor-skip.ts) tells both the
      // save-time (build-menu.ts) and resolve-time (use-quote-marks.ts) text
      // walkers to leave it out of a comment's captured/searched text.
      {...{ [ANCHOR_SKIP_ATTR]: true }}
      className="my-2 inline-flex items-center gap-2 rounded border border-edge bg-inset px-3 py-2 text-sm text-fg-2 hover:bg-panel"
      title={`Load image from ${host}`}
      data-message-find-ignore
    >
      <span aria-hidden>🖼</span>
      <span>Image from {host}</span>
      <span className="text-fg-dim">· Show</span>
    </button>
  );
}

// Stable component overrides — defined at module scope so ReactMarkdown
// receives the same object reference on every render, preventing unnecessary
// reconciliation of the entire markdown tree.
const mdComponents = {
  img(props: any) {
    return <ChatImage {...props} />;
  },
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
      // WHY the frame (border, fill, corners) moved from the <pre> to this wrapper
      // (2026-10-15, the one scroll fade): the fade is a mask, and a mask on the box
      // itself would fade its border and fill along with the code. The wrapper frames;
      // the <pre> scrolls sideways and only the code fades, on a side with more. It is
      // CSS-only (no listener per block), so a long chat of code blocks costs nothing.
      <div
        className="yc-code-block relative group my-3 rounded-md bg-canvas border border-edge overflow-hidden"
        // WHY: the line count lets globals.css hold the block's real height while the browser skips
        // drawing it, so drawing it later cannot push the reader's text down (see `.yc-code-block`).
        style={{ '--yc-lines': codeLineCount(codeText) } as React.CSSProperties}
      >
        {/* yc-code is the hook the globals.css rule needs to out-specify
            highlight.js's own `pre code.hljs` box (see the .yc-code block
            there). Don't drop it. */}
        <pre className="yc-code scroll-mask-x p-3 overflow-x-auto text-sm text-fg" {...props}>
          {children}
        </pre>
        {/* A fence still being typed draws its finished head separately (FrozenFence),
            so Copy takes the head plus the tail drawn here. */}
        <FenceCopyButton tailText={codeText} line={node?.position?.start.line} />
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
        <FrozenFenceHead line={node?.position?.start.line} />
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
      <div className="scroll-mask-x overflow-x-auto my-3">
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

/**
 * The finished head of a code fence that is still being typed (see
 * splitOpenFence). WHY a context and not props: the <code> element the head
 * belongs INSIDE is built by react-markdown, deep in its output; the context is
 * how the `code` and `pre` overrides below reach it. null everywhere else, so a
 * normal block draws exactly as before.
 */
interface FrozenFence {
  /** Line (1-based) of the document react-markdown is drawing where the open fence starts: the head belongs to THAT code block only. */
  line: number;
  /** Every frozen line, for the Copy button. */
  text: string;
  /** The same lines drawn once each, as the children that come first inside <code>. */
  node: React.ReactNode;
}
const FrozenFenceContext = createContext<FrozenFence | null>(null);

/** The finished lines that come first inside a still-open fence's <code> (nothing elsewhere). */
function FrozenFenceHead({ line }: { line: number | undefined }) {
  const frozen = useContext(FrozenFenceContext);
  return <>{frozen && frozen.line === line ? frozen.node : null}</>;
}

/** Copy for a code block: any finished head plus the text react-markdown drew. Nothing when the block is empty. */
function FenceCopyButton({ tailText, line }: { tailText: string; line: number | undefined }) {
  const frozen = useContext(FrozenFenceContext);
  const text = (frozen && frozen.line === line ? frozen.text : '') + tailText;
  return text ? <CopyButton text={text} /> : null;
}

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
  // Framed by a wrapper so only the text fades (see the main code block above).
  if (!enabled) return <div className="rounded-md bg-canvas border border-edge overflow-hidden"><pre className="yc-code scroll-mask-x p-3 overflow-x-auto text-sm text-fg">{body}</pre></div>;
  // WHY: the fenced IDs become a live reference CARD with asynchronously
  // resolved titles, not message words. Those labels cannot be source-indexed.
  return <span data-message-find-ignore className="contents"><ChatsearchRefBlock shortIds={ids} /></span>;
}
// Preview mode: the same renderer with NOTHING interactive in it. WHY: a file tile is itself a
// <button> (FilesTab, Deliverables), and the code-block Copy button / links inside a rendered
// markdown preview made a <button> inside a <button> — invalid HTML, a React error on every
// Projects screen (found by the 2026-08-27 sweep). Code blocks keep their look, links read as text.
const mdPreviewComponents = {
  ...mdComponents,
  pre({ children, node: _node, ...props }: any) {
    return (
      // Framed by a wrapper so only the code fades (see the main code block above).
      <div className="my-3 rounded-md bg-canvas border border-edge overflow-hidden">
        <pre className="yc-code scroll-mask-x p-3 overflow-x-auto text-sm text-fg" {...props}>
          {children}
        </pre>
      </div>
    );
  },
  a({ href: _href, children, ...props }: any) {
    return <span className="text-link underline" {...props}>{children}</span>;
  },
  // A preview tile is decorative and never loads a network image (same exfil
  // reason as the chat img handler); a data:/app-local image still renders.
  img({ src, alt }: any) {
    const source = typeof src === 'string' ? src : '';
    if (source && !isNetworkImageSrc(source)) {
      return <img src={source} alt={alt} className="max-w-full rounded" />;
    }
    return <span className="text-fg-dim">[image]</span>;
  },
  // Same reason as the <a> above: a preview tile is itself a <button>, so the
  // path renders as its own text and nothing inside is focusable.
  'filepath-token': ({ node, ...props }: any) => {
    const p = (node as Element)?.properties ?? {};
    const raw = (p['data-raw'] as string) ?? (p['data-path'] as string) ?? props['data-raw'] ?? '';
    return <span className="text-fg-dim">{raw}</span>;
  },
};

/**
 * The finished items of a long tight list that is still being typed (see
 * splitOpenList). Same idea as FrozenFence: the <ul>/<ol> they belong INSIDE is
 * built by react-markdown for the newest items only, so the `ul`/`ol` overrides
 * below reach the head through this context and draw it as their first children.
 * WHY inside the live list and not as lists of their own: one <ul> with all the
 * <li>s as direct children is what the whole-message render makes, so numbering
 * continues, `space-y-*` spacing and every sibling selector see the same tree.
 */
interface FrozenList {
  /** Line (1-based) of the document react-markdown is drawing where the live list starts: the head belongs to THAT list only. */
  line: number;
  ordered: boolean;
  /** Set by the live list when it drew the head; if it never does, the chunk falls back to the whole list. */
  claimed: { current: boolean };
  /** The whole list's first number (the live tail would otherwise claim the number of ITS first item). */
  start: number;
  node: React.ReactNode;
}
const FrozenListContext = createContext<FrozenList | null>(null);

/** Is this the top-level list that starts on `line` of the document react-markdown is drawing (not one nested inside an item)? */
const isListAt = (node: any, line: number) => node?.position?.start?.line === line && node?.position?.start?.column === 1;

const liveListCache = new WeakMap<object, React.ComponentProps<typeof ReactMarkdown>['components']>();
const chunkListCache = new WeakMap<object, React.ComponentProps<typeof ReactMarkdown>['components']>();
/** components for the live tail: its first list also draws the frozen head, then its own (newest) items. */
function liveListComponents(components: NonNullable<React.ComponentProps<typeof ReactMarkdown>['components']>) {
  let c = liveListCache.get(components);
  if (!c) {
    const make = (tag: 'ul' | 'ol') => {
      const Base: any = (components as any)[tag] ?? tag;
      return function LiveList(props: any) {
        const head = useContext(FrozenListContext);
        const takes = !!head && head.ordered === (tag === 'ol') && isListAt(props.node, head.line);
        // WHY: the head must be drawn by exactly one list; MarkdownChunk checks this after drawing.
        useLayoutEffect(() => { if (takes) head!.claimed.current = true; });
        if (!head || head.ordered !== (tag === 'ol') || !isListAt(props.node, head.line)) return <Base {...props} />;
        // start: only the real first number, and none when it is 1 (as react-markdown leaves it).
        const start = tag === 'ol' ? { start: head.start === 1 ? undefined : head.start } : {};
        return <Base {...props} {...start}>{head.node}{props.children}</Base>;
      };
    };
    c = { ...components, ul: make('ul'), ol: make('ol') };
    liveListCache.set(components, c);
  }
  return c;
}
/** components for a finished chunk: its list wrapper is removed, leaving the <li>s (and the newlines between them). */
function chunkListComponents(components: NonNullable<React.ComponentProps<typeof ReactMarkdown>['components']>) {
  let c = chunkListCache.get(components);
  if (!c) {
    const make = (tag: 'ul' | 'ol') => {
      const Base: any = (components as any)[tag] ?? tag;
      return function ChunkList(props: any) {
        if (!isListAt(props.node, 1)) return <Base {...props} />;
        // WHY the trailing newline is dropped: the live list's own children start with one, so
        // head + tail give exactly the "\n<li>\n<li>\n" a single list has.
        const kids = React.Children.toArray(props.children);
        if (kids[kids.length - 1] === '\n') kids.pop();
        return <>{kids}</>;
      };
    };
    c = { ...components, ul: make('ul'), ol: make('ol') };
    chunkListCache.set(components, c);
  }
  return c;
}

/**
 * Twenty finished items of a still-open list, drawn once. WHY memo: `source` is final, so it is
 * never parsed again however long the list grows.
 */
const FrozenListChunk = React.memo(function FrozenListChunk({ source, rehypePlugins, components }: {
  source: string;
  rehypePlugins: PluggableList;
  components: NonNullable<React.ComponentProps<typeof ReactMarkdown>['components']>;
}) {
  return (
    <ReactMarkdown remarkPlugins={remarkPluginsStable} rehypePlugins={rehypePlugins} components={chunkListComponents(components)}>
      {source}
    </ReactMarkdown>
  );
});

interface Props {
  content: string;
  /** When provided, file paths detected in text are rendered as FilepathToken chips. */
  sessionId?: string;
  /** Decorative rendering for tiles: no Copy buttons, no links — nothing focusable or clickable. */
  preview?: boolean;
  /**
   * The content may GROW while this stays mounted (a reply streaming in). Once it
   * does, finished blocks are drawn once and only the tail is re-drawn per update.
   * Same page either way — see markdown-blocks.ts.
   */
  incremental?: boolean;
  /**
   * The text is still being written by the model (only meaningful with `incremental`).
   * Lets a very long unclosed code fence be drawn in chunks; false/absent for finished,
   * stopped and history messages, which draw as one piece.
   */
  live?: boolean;
  /**
   * A big FINISHED document (the file viewer): draw the first screenful at once and the rest in
   * small slices, one per animation frame, instead of one long freeze. Ends as the same page.
   */
  progressive?: boolean;
  /** Called once with true when a progressive draw has drawn everything (false while it is still going). */
  onProgressive?: (done: boolean) => void;
}

/**
 * One piece of a streaming message, drawn as its own markdown document.
 * WHY memo: a finished block's `source` never changes again, so it is parsed,
 * highlighted and reconciled exactly once instead of once per streamed word.
 * Every prop is a string or module-level/memoised, so the comparison holds.
 */
const MarkdownChunk = React.memo(function MarkdownChunk({ source, defs, live, fenceAt, listScan, rehypePlugins: basePlugins, components }: {
  source: string;
  /** How far a scan of this piece as a growing list has got (see scanOpenList); null = draw it whole. */
  listScan: ListScan | null;
  /** The reply is still streaming — the only time a long open fence may be drawn in chunks. */
  live: boolean;
  /** Where an open top-level fence starts in `source` when text comes before it (see DrawnGroup.fenceAt). */
  fenceAt?: number;
  /** The message's link definitions, when this piece could use them (see withDefinitions). */
  defs: string;
  rehypePlugins: PluggableList;
  components: React.ComponentProps<typeof ReactMarkdown>['components'];
}) {
  // A long code fence still being typed: finished lines are drawn once, in
  // chunks, and react-markdown re-reads only the newest lines (splitOpenFence).
  // Not with definitions in front — they would sit before the fence's opening.
  // WHY gated on `live`: chunks are coloured one at a time, which is only right
  // until the reply ends. A reply that stops with its fence still open (Stop, an
  // error, a truncated or old message) must draw as one block, like any other.
  const split = defs || !live ? null : splitOpenFence(source, fenceAt);
  // WHY decided here from the WHOLE fence (frozen head + live tail), not per 20-line chunk
  // (freeze hunt item 2): a chunk is tiny, so the plugin alone would colour every one of
  // them, and the fence would turn grey at the end when it is drawn as one block. Once the
  // fence passes the limit it stays uncoloured for the rest of the stream, as it will be
  // when finished. The earlier coloured chunks are redrawn plain once, at the crossing.
  const rehypePlugins = split && fenceOverHighlightLimit(split.frozen, split.tail)
    ? withoutColour(basePlugins)
    : basePlugins;
  const frozenText = split?.frozen ?? '';
  const opening = split?.opening ?? '';
  const prefix = split?.prefix ?? '';
  // The fence's line in the document drawn below (1-based): how its code block is told apart from any other.
  const line = prefix.split('\n').length;
  // WHY memoised on the head's TEXT: the head only ever grows by whole chunks, so
  // between those moments this is the same value and every chunk below is skipped.
  const frozen = useMemo<FrozenFence | null>(() => {
    if (!frozenText) return null;
    return {
      line,
      text: frozenText,
      node: fenceChunks(frozenText).map((chunk, i) => (
        <FrozenFenceChunk key={i} source={opening + chunk} rehypePlugins={rehypePlugins} components={components} />
      )),
    };
  }, [frozenText, opening, line, rehypePlugins, components]);

  // A long tight list still being typed (not a fence, no definitions in front): finished items are
  // drawn once, in chunks of 20, and react-markdown re-reads only the newest ones (splitOpenList).
  // The scan comes from the parent (see MarkdownContent) and is null unless the reply is live and
  // this group is the last one, so a finished reply and every other group draw as before.
  // WHY failedAt: a list whose finished head no live list claimed (see below) is drawn whole from then on.
  const [failedAt, setFailedAt] = useState(-1);
  const listSplit = !split && !defs && listScan?.source === source && listScan.at !== failedAt ? listSplitOf(source, listScan) : null;
  const listChunks = listSplit?.chunks;
  const listOrdered = listSplit?.ordered ?? false;
  const listStart = listSplit?.start ?? 1;
  // The list's line in the document drawn below (text before it, if any, comes first).
  const listLine = listSplit ? listSplit.prefix.split('\n').length : 1;
  // WHY memoised on the chunk list: it is the same array until a whole new chunk freezes.
  const frozenList = useMemo<FrozenList | null>(() => {
    if (!listChunks || !components) return null;
    return {
      claimed: { current: false },
      line: listLine,
      ordered: listOrdered,
      start: listStart,
      node: listChunks.map((chunk, i) => (
        <FrozenListChunk key={i} source={chunk} rehypePlugins={rehypePlugins} components={components} />
      )),
    };
  }, [listChunks, listOrdered, listStart, listLine, rehypePlugins, components]);

  // WHY a safety net: whatever sits in front of the list (an open HTML block, a fence the scan misread)
  // can stop react-markdown from making the live list at the line we expect. The head would then be
  // silently missing from the page, so redraw the whole text before it is ever painted.
  useLayoutEffect(() => {
    if (frozenList && listScan && !frozenList.claimed.current) setFailedAt(listScan.at);
  }, [frozenList, listScan]);

  const markdown = (
    <ReactMarkdown
      remarkPlugins={remarkPluginsStable}
      rehypePlugins={rehypePlugins}
      components={listSplit && components ? liveListComponents(components) : components}
    >
      {split ? prefix + opening + split.tail : listSplit ? listSplit.prefix + listSplit.tail : withDefinitions(source, defs)}
    </ReactMarkdown>
  );
  // WHY the Provider is ALWAYS the root (null when there is no head): swapping the
  // root element's type when the fence reaches 40 lines, or closes, would make React
  // rebuild the whole block (flash, scroll jump, lost selection, Copy reset).
  return (
    <FrozenFenceContext.Provider value={frozen}>
      <FrozenListContext.Provider value={frozenList}>{markdown}</FrozenListContext.Provider>
    </FrozenFenceContext.Provider>
  );
});

/** react-markdown's components with the block wrapper removed: a chunk draws only its coloured lines. */
const chunkComponentsCache = new WeakMap<object, React.ComponentProps<typeof ReactMarkdown>['components']>();
const Bare = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
function chunkComponents(components: NonNullable<React.ComponentProps<typeof ReactMarkdown>['components']>) {
  let c = chunkComponentsCache.get(components);
  if (!c) {
    c = { ...components, pre: Bare, code: Bare };
    chunkComponentsCache.set(components, c);
  }
  return c;
}

/**
 * One finished chunk of a still-open code fence: the same pipeline as any code
 * block (colouring, URL and path links), drawn once, minus the <pre>/<code> the
 * live block already supplies. WHY memo: `source` is final, so it is never
 * parsed or coloured again however long the fence grows.
 * Colouring is per chunk, so a multi-line comment or string that straddles a
 * chunk edge is coloured as if it began there until the fence closes, when the
 * whole block is coloured as one piece again.
 */
const FrozenFenceChunk = React.memo(function FrozenFenceChunk({ source, rehypePlugins, components }: {
  source: string;
  rehypePlugins: PluggableList;
  components: React.ComponentProps<typeof ReactMarkdown>['components'];
}) {
  return (
    <span className="yc-fence-chunk">
      <ReactMarkdown
        remarkPlugins={remarkPluginsStable}
        rehypePlugins={rehypePlugins}
        components={components ? chunkComponents(components) : undefined}
      >
        {source}
      </ReactMarkdown>
    </span>
  );
});

/** Groups per memoised page of a progressively drawn file (see the render of MarkdownContent). */
const GROUP_PAGE = 100;
type DrawnGroupView = StreamView['groups'][number];

/**
 * One page of a progressive draw: the same keyed Fragment per group as the streaming path
 * (so the finished DOM is the same), skipped whole while its groups are the same objects.
 * WHY a group is the same object when unchanged: advanceStream's `finish` hands back the previous
 * group for any group whose text and definitions did not change.
 */
const GroupPage = React.memo(function GroupPage({ groups, startsPainted, rehypePlugins, components }: {
  groups: DrawnGroupView[];
  startsPainted: boolean;
  rehypePlugins: PluggableList;
  components: React.ComponentProps<typeof ReactMarkdown>['components'];
}) {
  let painted = startsPainted;
  return (
    <>
      {groups.map((g) => {
        const newline = g.paints && painted;
        painted ||= g.paints;
        return (
          <React.Fragment key={g.key}>
            {newline ? '\n' : null}
            {g.paints && (
              <MarkdownChunk source={g.draw} defs={g.defs} live={false} listScan={null} fenceAt={g.fenceAt} rehypePlugins={rehypePlugins} components={components} />
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}, (a, b) => a.startsPainted === b.startsPainted && a.rehypePlugins === b.rehypePlugins && a.components === b.components
  && a.groups.length === b.groups.length && a.groups.every((g, i) => g === b.groups[i]));

export default React.memo(function MarkdownContent({ content, sessionId, preview, incremental, live = false, progressive = false, onProgressive }: Props) {
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

  // Streaming (smoothness sweep A5): see markdown-blocks.ts for how a growing
  // message is cut into groups and which of them are finished.
  // WHY state updated during render, not a ref (review F3): this is React's
  // "information from previous renders" pattern. A ref written during render
  // survives a render React throws away (concurrent rendering, StrictMode) and
  // would then describe content that never reached the screen; a state update
  // made during render is discarded along with that render. React re-runs this
  // function at once with the new view, before drawing any child, so the cost
  // is one extra call of this function, not a second draw.
  const [streamState, setStreamState] = useState<StreamView>(() => startStream(
    // A progressive draw starts from its first slice, not the whole text (see the slices block below).
    progressive && canDrawInSlices(content) ? content.slice(0, nextSliceEnd(sliceCuts(content), 0, PROGRESSIVE_FIRST_CHARS, content.length)) : content,
  ));
  // Where the last group's scan as a growing list has got to, so an update reads only the new lines.
  // WHY a ref: it only remembers progress; scanOpenList checks the text itself, so the answer is the
  // same with or without it and a render React discards cannot leave anything stale.
  const listScanRef = useRef<ListScan | null>(null);
  // Progressive draw of a finished document (file viewer; freeze hunt 2026-10-22, item 4): the text is
  // handed to the streaming path below as a PREFIX that grows by a slice per animation frame (see
  // PROGRESSIVE_* in markdown-blocks.ts for why a prefix and not a pre-cut document). A text a prefix
  // cannot draw faithfully (canDrawInSlices) is drawn whole, as before.
  const cuts = useMemo(() => (progressive && canDrawInSlices(content) ? sliceCuts(content) : null), [progressive, content]);
  const [shown, setShown] = useState<{ content: string; end: number }>({ content: '', end: 0 });
  let shownEnd = content.length;
  if (cuts) {
    shownEnd = shown.content === content ? shown.end : nextSliceEnd(cuts, 0, PROGRESSIVE_FIRST_CHARS, content.length);
    // WHY state set during render (the same pattern as streamState above): a new text restarts the slices.
    if (shown.content !== content) setShown({ content, end: shownEnd });
  }
  const progressiveDone = shownEnd >= content.length;
  const onProgressiveRef = useRef(onProgressive);
  onProgressiveRef.current = onProgressive;
  useEffect(() => {
    if (!progressive) return;
    onProgressiveRef.current?.(progressiveDone);
    if (!cuts || progressiveDone) return;
    // WHY rAF: one slice per frame keeps scrolling and typing alive between slices, and a hidden
    // window stops drawing altogether (performance.md rule 2).
    const id = requestAnimationFrame(() => {
      setShown((cur) => (cur.content === content ? { content, end: nextSliceEnd(cuts, cur.end, PROGRESSIVE_BATCH_CHARS, content.length) } : cur));
    });
    return () => cancelAnimationFrame(id);
  }, [progressive, cuts, content, progressiveDone, shownEnd]);
  const drawnText = cuts ? content.slice(0, shownEnd) : content;
  const sliced = !!cuts;

  let stream = streamState;
  if ((incremental || sliced) && stream.drawn !== drawnText) {
    stream = advanceStream(stream, drawnText);
    setStreamState(stream);
  }

  if (incremental || sliced) {
    // WHY a keyed Fragment per group, not a wrapper element: the groups' elements
    // land as direct siblings exactly as one whole-message render would put them,
    // so `.assistant-bubble > *`, `last:mb-0` and every other selector see the
    // same tree. The '\n' between groups is the text node react-markdown itself
    // puts between top-level blocks — only between groups that draw something,
    // as react-markdown skips a link definition without leaving a newline.
    // WHY keyed by where the group starts in the message (review F1): a group
    // keeps its elements however the groups before it change; group 0 is the
    // same element the single-document render used, so nothing drawn before the
    // message started growing is rebuilt.
    let painted = false;
    // A progressively drawn big file can hold thousands of groups. Walking every one of them as its own
    // element on every slice made the work per slice grow with the file (a 1 MB file took 3x longer sliced
    // than drawn whole), so they are handed to memoised PAGES of GROUP_PAGE groups: a finished page is
    // skipped with one comparison. Pages are by position and only ever appended to, so no group changes
    // page and nothing already drawn is rebuilt. (Not for a streaming reply: it is short, and a page
    // boundary would add a wrapper to a path that is already tuned.)
    if (sliced && !incremental) {
      const pages: React.ReactNode[] = [];
      for (let at = 0; at < stream.groups.length; at += GROUP_PAGE) {
        const slice = stream.groups.slice(at, at + GROUP_PAGE);
        pages.push(<GroupPage key={slice[0].key} groups={slice} startsPainted={painted} rehypePlugins={rehypePlugins} components={components} />);
        painted ||= slice.some((g) => g.paints);
      }
      return <>{pages}</>;
    }
    // WHY the scan is made here and not by the chunk: only the LAST group of a live reply can be a list
    // that is still growing. When the reply ends the scan turns null and just that group is redrawn whole;
    // a plain `live` flag would have redrawn the last group of every reply (it stays null for those).
    const lastGroup = stream.groups[stream.groups.length - 1];
    const listScan = live && lastGroup && lastGroup.fenceAt === undefined ? scanOpenList(lastGroup.draw, listScanRef.current) : null;
    listScanRef.current = listScan;
    return (
      <>
        {stream.groups.map((g) => {
          const newline = g.paints && painted;
          painted ||= g.paints;
          return (
            <React.Fragment key={g.key}>
              {newline ? '\n' : null}
              {/* WHY skip a group of only link definitions (review 2, F1): it
                  draws nothing, and while a definition list streams in it is
                  the live group — drawing it re-parsed the whole list per word. */}
              {g.paints && (
                <MarkdownChunk
                  source={g.draw}
                  defs={g.defs}
                  // WHY live only for the group holding an open fence: the turn ending flips `live` for the
                  // whole bubble, and every other group would miss its memo and be re-parsed and
                  // re-coloured in one commit — a hitch at the end of every reply.
                  live={live && g.fenceAt !== undefined}
                  listScan={g === lastGroup ? listScan : null}
                  fenceAt={g.fenceAt}
                  rehypePlugins={rehypePlugins}
                  components={components}
                />
              )}
            </React.Fragment>
          );
        })}
      </>
    );
  }

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
