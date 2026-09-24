import { describe, it, expect, vi } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { splitMarkdownBlocks, blockChunks, type MarkdownBlocks } from './markdown-blocks';
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
 *  different offsets compare by meaning. */
function forest(md: string): unknown[] {
  const strip = (node: any): any => {
    const { position: _p, children, ...rest } = node;
    return children ? { ...rest, children: children.map(strip) } : rest;
  };
  return ((parser.parse(md) as any).children as unknown[]).map(strip);
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
        expect(chunks.flatMap(forest), `prefix ${JSON.stringify(prefix)}`).toEqual(forest(prefix));
      });
    });

    it(`never changes a finished block of "${sample.name}" once it is frozen`, () => {
      stream(everyCharacter(sample.md), (state, prefix, prev) => {
        if (!prev || prev.whole || state.whole) return;
        expect(state.frozen.slice(0, prev.frozen.length), `prefix ${JSON.stringify(prefix)}`).toEqual(prev.frozen);
        expect(state.frozenEnd).toBeGreaterThanOrEqual(prev.frozenEnd);
      });
    });
  }

  it('falls back to one whole render once a link or footnote definition appears, and stays there', () => {
    for (const name of ['reference-style links defined later', 'footnotes defined in another block']) {
      const md = MARKDOWN_STREAM_CORPUS.find((s) => s.name === name)!.md;
      let sawWhole = false;
      stream(prefixesOf(tokenDeltas(md)), (state) => {
        if (sawWhole) expect(state.whole).toBe(true);
        sawWhole ||= state.whole;
      });
      expect(sawWhole, name).toBe(true);
    }
  });

  it('keeps every block from the first raw HTML block onward in one live piece', () => {
    const md = MARKDOWN_STREAM_CORPUS.find((s) => s.name === 'details and summary around content, twice')!.md;
    const state = splitMarkdownBlocks(md, splitMarkdownBlocks('Before.\n\n<'));
    expect(state.whole).toBe(false);
    expect(state.frozen).toEqual(['Before.\n\n']);
    expect(state.live.at(-1)).toMatch(/^<details>[\s\S]*End\.$/);
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

  it('starts over when the content is replaced rather than appended to', () => {
    const a = splitMarkdownBlocks('one\n\ntwo\n\nthree\n\nfour');
    const b = splitMarkdownBlocks('ONE\n\ntwo\n\nthree\n\nfour', a);
    expect(blockChunks(b).join('')).toBe('ONE\n\ntwo\n\nthree\n\nfour');
    expect(b.frozen[0]).toBe('ONE\n\n');
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
        expect(blockChunks(state).flatMap(forest), `prefix ${JSON.stringify(prefix)}`).toEqual(whole);
      });
    }
  });
});
