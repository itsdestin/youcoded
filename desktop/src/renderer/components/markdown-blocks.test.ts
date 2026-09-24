import { describe, it, expect, vi } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import {
  splitMarkdownBlocks, blockChunks, definitionsOf, withDefinitions, startStream, advanceStream,
  type MarkdownBlocks, type StreamView,
} from './markdown-blocks';
import { MARKDOWN_STREAM_CORPUS, tokenDeltas, prefixesOf } from '../../../tests/helpers/markdown-stream-corpus';

// Counts how much text is handed to the markdown parser, so the cost pin below
// measures what the splitter really parses rather than what it claims to. Wraps
// remark-parse (the module the splitter imports) and passes through unchanged.
const parsed = vi.hoisted(() => ({ chars: 0 }));
vi.mock('remark-parse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remark-parse')>();
  return {
    default: function countingRemarkParse(this: any, ...args: any[]) {
      (actual.default as any).apply(this, args);
      const parse = this.parser;
      this.parser = (doc: string, file: unknown) => {
        parsed.chars += doc.length;
        return parse(doc, file);
      };
    },
  };
});

// The parser react-markdown uses (remark-parse + remark-gfm), for the reference.
const parser = unified().use(remarkParse).use(remarkGfm);

/** Top-level nodes of `md` with source positions removed, so trees parsed from
 *  different offsets compare by meaning. Link definitions are left out: they draw
 *  nothing, and each piece carries copies of them (withDefinitions). */
function forest(md: string): unknown[] {
  const strip = (node: any): any => {
    const { position: _p, children, ...rest } = node;
    return children ? { ...rest, children: children.map(strip) } : rest;
  };
  return ((parser.parse(md) as any).children as any[]).filter((n) => n.type !== 'definition').map(strip);
}

/** The pieces parsed as the bubble draws them: each with the message's definitions. */
function pieceForest(state: MarkdownBlocks): unknown[] {
  const defs = state.whole ? '' : definitionsOf(state).join('\n\n');
  return blockChunks(state).flatMap((text) => forest(withDefinitions(text, defs)));
}

/** Streams `prefixes` through the splitter the way MarkdownContent does. */
function stream(prefixes: string[], visit: (state: MarkdownBlocks, prefix: string, prev: MarkdownBlocks | null) => void) {
  let state: MarkdownBlocks | null = null;
  for (const prefix of prefixes) {
    const prev = state;
    state = splitMarkdownBlocks(prefix, prev);
    visit(state, prefix, prev);
  }
}

const everyCharacter = (md: string) => Array.from({ length: md.length }, (_, i) => md.slice(0, i + 1));

describe('splitMarkdownBlocks while a reply streams', () => {
  for (const sample of MARKDOWN_STREAM_CORPUS) {
    it(`parses the pieces of "${sample.name}" exactly as the whole message, at every character`, () => {
      stream(everyCharacter(sample.md), (state, prefix) => {
        const chunks = blockChunks(state);
        // The pieces are the message, cut only between blocks …
        if (prefix.trim()) expect(chunks.join('')).toBe(prefix);
        // … and drawing them one by one reads exactly like drawing it whole.
        expect(pieceForest(state), `prefix ${JSON.stringify(prefix)}`).toEqual(forest(prefix));
      });
    });

    it(`never changes a finished block of "${sample.name}" once it is frozen`, () => {
      stream(everyCharacter(sample.md), (state, prefix, prev) => {
        if (!prev || prev.whole || state.whole) return;
        expect(state.frozen.slice(0, prev.frozen.length), `prefix ${JSON.stringify(prefix)}`).toEqual(prev.frozen);
        expect(state.frozenDefs.slice(0, prev.frozenDefs.length)).toEqual(prev.frozenDefs);
        expect(state.frozenEnd).toBeGreaterThanOrEqual(prev.frozenEnd);
      });
    });
  }

  it('keeps the pieces when a link definition appears, and hands it to every piece', () => {
    const md = MARKDOWN_STREAM_CORPUS.find((s) => s.name === 'reference-style links defined later')!.md;
    let last: MarkdownBlocks | null = null;
    stream(prefixesOf(tokenDeltas(md)), (state) => { expect(state.whole).toBe(false); last = state; });
    expect(definitionsOf(last!)).toEqual(['[docs]: https://example.com/docs "Docs"', '[other]: https://example.com/other']);
  });

  it('falls back to one whole render once a footnote or a nested definition appears, and stays there', () => {
    const footnotes = MARKDOWN_STREAM_CORPUS.find((s) => s.name === 'footnotes defined in another block')!.md;
    for (const md of [footnotes, 'Quote:\n\n> [x]: https://a.example\n\nSee [x].\n\nEnd.']) {
      let sawWhole = false;
      stream(prefixesOf(tokenDeltas(md)), (state) => {
        if (sawWhole) expect(state.whole).toBe(true);
        sawWhole ||= state.whole;
      });
      expect(sawWhole, md).toBe(true);
    }
  });

  it('parses only the unfinished tail on each update, not the whole reply', () => {
    const md = MARKDOWN_STREAM_CORPUS.find((s) => s.name === 'long mixed reply')!.md;
    let state: MarkdownBlocks | null = null;
    let wholeChars = 0;
    parsed.chars = 0;
    for (const prefix of prefixesOf(tokenDeltas(md.repeat(4)))) {
      wholeChars += prefix.length;
      state = splitMarkdownBlocks(prefix, state);
    }
    const parsedChars = parsed.chars;
    // A whole-message re-parse per delta grows with the square of the reply; the
    // tail is a block or two. Measured ~3% here; 10% leaves room without letting
    // a regression to whole-message parsing through.
    expect(parsedChars).toBeGreaterThan(0);
    expect(parsedChars / wholeChars).toBeLessThan(0.1);
    expect(state!.frozen.length).toBeGreaterThan(40);
  });

  it('parses only the unfinished tail even when raw HTML sits near the top', () => {
    const md = '<!-- note -->\n\n<br>\n\n' + MARKDOWN_STREAM_CORPUS.find((s) => s.name === 'long mixed reply')!.md.repeat(4);
    let state: MarkdownBlocks | null = null;
    let wholeChars = 0;
    parsed.chars = 0;
    for (const prefix of prefixesOf(tokenDeltas(md))) {
      wholeChars += prefix.length;
      state = splitMarkdownBlocks(prefix, state);
    }
    expect(parsed.chars / wholeChars).toBeLessThan(0.1);
  });

  it('starts over when the content is replaced rather than appended to', () => {
    const a = splitMarkdownBlocks('one\n\ntwo\n\nthree\n\nfour');
    const b = splitMarkdownBlocks('ONE\n\ntwo\n\nthree\n\nfour', a);
    expect(blockChunks(b).join('')).toBe('ONE\n\ntwo\n\nthree\n\nfour');
    expect(b.frozen[0].text).toBe('ONE\n\n');
  });

  // Seeded random documents built from the constructs that interact across lines
  // (setext underlines, empty list items, indented code, tables, fences, HTML,
  // CRLF). This is what found the per-block cut wrong, then CRLF read as a blank
  // line, then indented code's context: 8,000+ documents passed at every
  // character when this landed; 150 here keep it quick.
  it('parses random documents exactly as the whole message, at every character', () => {
    const FRAGS = ['para text', 'more *words*', '# h', '#', '##x', '===', '---', '-', '- item', '  - nested', '1. one', '3) three', '> quote', '>', 'lazy', '```', '```js', '~~~', '    indented', '\t tab', '| a | b |', '| - | - |', '|---|', '<details>', '<summary>s</summary>', '</details>', '<div>', '</div>', '<!--', '-->', '***', '* star', '+ plus', '[x]: http://a', '[x]', '[^1]', 'http://example.com', '/tmp/a.txt', '  ', '', '', '', 'a  ', 'b\\', '<pre>', '</pre>', '* * *', '1.', '10. ten', '- [ ] task', 'Setext', '===', '  ```', '```  ', '> ```', '> - x', '   - three', '    - four', '<b>x</b>', '', '', '', '', '    code', '> ', '1) x', '- ', '* ', '```py', 'x | y', '--- | ---', '<details><summary>t</summary>', '[a][x]', '![i](p.png)', '  1. y', '    ', '\t- tabbed', '> > deep', '#     spaced', 'Title\n---'];
    let seed = 20260923;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let d = 0; d < 150; d++) {
      const lines = Array.from({ length: 3 + Math.floor(rnd() * 14) }, () => FRAGS[Math.floor(rnd() * FRAGS.length)]);
      const md = lines.join(rnd() < 0.1 ? '\r\n' : '\n');
      let whole: unknown[];
      stream(everyCharacter(md), (state, prefix) => {
        // A few odd prefixes trip a development-only assertion inside
        // mdast-util-gfm-task-list-item on the WHOLE parse too (production
        // builds carry no assertions); those say nothing about splitting.
        try { whole = forest(prefix); } catch { return; }
        expect(pieceForest(state), `prefix ${JSON.stringify(prefix)}`).toEqual(whole);
      });
    }
  });
});

describe('advanceStream: the groups a growing message is drawn as', () => {
  const run = (prefixes: string[], first = prefixes[0]) => {
    let view: StreamView = startStream(first);
    const views: StreamView[] = [];
    for (const p of prefixes) { view = advanceStream(view, p); views.push(view); }
    return views;
  };
  const keysAndText = (v: StreamView) => v.groups.map((g) => [g.key, g.source]);

  for (const sample of MARKDOWN_STREAM_CORPUS) {
    it(`groups "${sample.name}" back into the message, and never changes a settled group`, () => {
      const views = run(everyCharacter(sample.md));
      views.forEach((v, i) => {
        if (v.blocks?.whole) return;
        const text = v.groups.map((g) => g.source).join('');
        // The groups are the message (bar blank text no block has claimed yet).
        expect(v.drawn.startsWith(text) && !v.drawn.slice(text.length).trim()).toBe(true);
        for (const g of v.groups) expect(v.drawn.startsWith(g.source, g.key)).toBe(true);
        const prev = views[i - 1];
        if (prev && !prev.blocks?.whole) {
          for (let k = 0; k < prev.settled.length; k++) expect(v.settled[k]).toBe(prev.settled[k]);
        }
      });
    });
  }

  it('keeps what was drawn as one document in group 0 once the message starts to grow', () => {
    const drawn = 'Intro\n\n![pic](https://x.com/p.png)\n\npara\n\nnext';
    const [v1, v2, v3] = run([drawn + ' word', drawn + ' word\n\nNew', drawn + ' word\n\nNew para\n\nMore'], drawn);
    expect(keysAndText(v1)).toEqual([[0, drawn + ' word']]);
    expect(keysAndText(v2)).toEqual([[0, drawn + ' word\n\n'], [drawn.length + 7, 'New']]);
    expect(v3.groups[0]).toEqual(v2.groups[0]);
    // Only the last piece stays live: group 0 and "New para" are both final.
    expect(v3.settled.length).toBe(2);
  });

  it('draws a closed <details> run as one group and freezes it; a comment is just its own group', () => {
    const md = '<!-- note -->\n\nA\n\n<details>\n<summary>S</summary>\n\nin one\n\nin two\n\n</details>\n\nB\n\nC\n\nD';
    const v = run(prefixesOf(tokenDeltas(md))).at(-1)!;
    expect(v.groups.map((g) => g.source)).toEqual([
      '<!-- note -->\n\n', 'A\n\n', '<details>\n<summary>S</summary>\n\nin one\n\nin two\n\n</details>\n\n', 'B\n\n', 'C\n\n', 'D',
    ]);
    expect(v.settled.length).toBe(5);
  });

  it('keeps an open <details> run unsettled, drawing each piece on its own until it closes', () => {
    const open = 'A\n\n<details>\n<summary>S</summary>\n\none\n\ntwo\n\nthree';
    const v = run(prefixesOf(tokenDeltas(open))).at(-1)!;
    expect(v.settled.map((g) => g.source)).toEqual(['A\n\n']);
    expect(v.groups.length).toBe(5);
  });

  // A bare <details> pairs only when a <summary> block comes next; once a
  // finished block that is not one follows, it stays text for good and must not
  // hold every later group unsettled (re-walked on every word).
  it('settles the groups after a <details> that can never pair', () => {
    const md = 'A\n\n<details>\n\nnot a summary\n\nB\n\nC\n\nD\n\nE\n\nF';
    const v = run(prefixesOf(tokenDeltas(md))).at(-1)!;
    expect(v.settled.length).toBeGreaterThanOrEqual(v.groups.length - 2);
  });

  it('starts over as one document when the content is replaced, then splits the next append', () => {
    const views = run(['one\n\ntwo', 'one\n\ntwo\n\nthree', 'ONE\n\ntwo', 'ONE\n\ntwo\n\nthree']);
    expect(keysAndText(views[2])).toEqual([[0, 'ONE\n\ntwo']]);
    expect(keysAndText(views[3])).toEqual([[0, 'ONE\n\ntwo\n\n'], [10, 'three']]);
  });

  it('carries the link definitions to the groups that could use them', () => {
    const v = run(prefixesOf(tokenDeltas('See [x].\n\nplain\n\n[x]: https://a.example\n\nEnd.'))).at(-1)!;
    expect(v.defs).toBe('[x]: https://a.example');
    expect(v.groups.map((g) => [g.source.trim(), g.refs, g.paints])).toEqual([
      ['See [x].', true, true], ['plain', false, true], ['[x]: https://a.example', true, false], ['End.', false, true],
    ]);
  });
});
