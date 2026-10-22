// @vitest-environment jsdom
// Freeze hunt 2026-10-22, item 4: a big finished document is drawn a slice per frame, ending identical.
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import MarkdownContent from './MarkdownContent';
import { MarkdownView } from './artifact-views/MarkdownView';
import { PROGRESSIVE_BATCH_CHARS, PROGRESSIVE_FIRST_CHARS, PROGRESSIVE_MIN_CHARS, canDrawInSlices, nextSliceEnd, sliceCuts } from './markdown-blocks';
import { MARKDOWN_STREAM_CORPUS } from '../../../tests/helpers/markdown-stream-corpus';

// Every source handed to react-markdown, to bound the work of each slice.
const renders = vi.hoisted(() => [] as string[]);
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>();
  return { ...actual, default: (props: { children?: string }) => { renders.push(String(props.children ?? '')); return (actual.default as any)(props); } };
});

// A hand-driven animation-frame queue: one flush = one frame.
let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames[id - 1] = () => {}; });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); renders.length = 0; });
const frame = () => act(() => { const f = frames; frames = []; f.forEach((cb) => cb(0)); });
const drain = () => { let n = 0; while (frames.length && n++ < 5000) frame(); return n; };

const whole = (md: string) => { const r = render(<MarkdownContent content={md} />); const h = r.container.innerHTML; r.unmount(); return h; };
const big = (md: string, min = PROGRESSIVE_MIN_CHARS * 2) => { let s = md; while (s.length < min) s += '\n\n' + md; return s; };

describe('slice cuts', () => {
  it('cut after blank lines only, never inside a code fence, and never at the very end', () => {
    const text = 'a\n\nb\n\n```\nx\n\ny\n```\n\nc\n\n';
    const cuts = sliceCuts(text);
    expect(cuts.map((c) => text.slice(0, c))).toEqual(['a\n\n', 'a\n\nb\n\n', 'a\n\nb\n\n```\nx\n\ny\n```\n\n']);
    expect(nextSliceEnd(cuts, 0, 4, text.length)).toBe(cuts[1]);
    expect(nextSliceEnd(cuts, cuts[2], 4, text.length)).toBe(text.length);
  });
  it('texts with link definitions or footnotes are not sliced', () => {
    expect(canDrawInSlices('plain\n\ntext')).toBe(true);
    expect(canDrawInSlices('see [a]\n\n[a]: https://x.test')).toBe(false);
    expect(canDrawInSlices('x[^1]\n\n[^1]: note')).toBe(false);
  });
});

describe('progressive markdown draw', () => {
  it('ends as the exact page a whole draw makes (every corpus text alone, and all together past the first slice)', () => {
    const check = (name: string, doc: string) => {
      const expected = whole(doc);
      const r = render(<MarkdownContent content={doc} progressive />);
      drain();
      expect(r.container.innerHTML, name).toBe(expected);
      r.unmount();
    };
    for (const { name, md } of MARKDOWN_STREAM_CORPUS) check(name, md);
    // Footnotes number across the whole text, so they are drawn whole (tested below); the rest are cut into slices.
    const joined = MARKDOWN_STREAM_CORPUS.filter((c) => !c.md.includes('[^')).map((c) => c.md).join('\n\n');
    check('all together', big(joined, PROGRESSIVE_FIRST_CHARS * 2 + 2000));
  }, 120_000);

  it('keeps link definitions that come after their use, and footnotes', () => {
    const refs = big('See [the docs][d] and [again][e].\n\n[d]: https://example.com/docs\n\nMore prose here.\n\n[e]: https://example.com/e\n', 36_000);
    const foot = big('A claim[^1].\n\nOther text.\n\n[^1]: The note.\n', 36_000);
    for (const doc of [refs, foot]) {
      const expected = whole(doc);
      const r = render(<MarkdownContent content={doc} progressive />);
      drain();
      expect(r.container.innerHTML).toBe(expected);
      r.unmount();
    }
  });

  it('draws only the first screenful at once, then a bounded number of blocks per frame', () => {
    const doc = big('Paragraph of ordinary prose that goes on a little, with **bold** and a [link](https://example.com).\n', 150_000);
    const r = render(<MarkdownContent content={doc} progressive />);
    const first = renders.slice();
    expect(first.join('').length).toBeLessThan(PROGRESSIVE_FIRST_CHARS * 2);
    let frameCount = 0;
    while (frames.length) {
      renders.length = 0;
      frame();
      frameCount++;
      expect(renders.join('').length).toBeLessThanOrEqual(PROGRESSIVE_BATCH_CHARS * 3);
    }
    // Spread over many frames, not one.
    expect(frameCount).toBeGreaterThan(5);
    expect(r.container.textContent!.length).toBeGreaterThan(doc.length / 2);
  });

  it('a small document is drawn whole, in one go, with nothing queued', () => {
    const r = render(<MarkdownContent content={'# Hi\n\nShort.'} />);
    expect(frames.length).toBe(0);
    expect(r.container.textContent).toContain('Short.');
  });

  it('a huge fence inside a big file is not coloured (item 1 applies here too)', () => {
    const code = Array.from({ length: 2000 }, (_, i) => `const a${i} = ${i};`).join('\n');
    const r = render(<MarkdownContent content={big('Intro.\n\n```js\n' + code + '\n```\n\nOutro.\n', 300_000)} progressive />);
    drain();
    expect(r.container.querySelector('.hljs-keyword')).toBeNull();
  });
});

describe('the file viewer', () => {
  const view = (path: string, content: string) => (
    <MarkdownView path={path} content={content} projectRoot="/p" {...({} as any)} />
  );
  it('marks the document as loading until the last slice, then clears it', () => {
    const doc = big('Some prose line for the viewer.\n', PROGRESSIVE_MIN_CHARS + 5000);
    const r = render(view('big.md', doc));
    const root = () => r.container.querySelector('[data-artifact-viewer]')!;
    expect(root().hasAttribute('data-doc-loading')).toBe(true);
    drain();
    expect(root().hasAttribute('data-doc-loading')).toBe(false);
    expect(r.container.innerHTML).toContain('Some prose line');
  });

  // Review 2026-10-22, item 1: leaving Edit remounts the document, which refills in slices.
  it('after Edit and Cancel the refill is marked loading again, and clears when it finishes', () => {
    const doc = big('Some prose line for the viewer.\n', PROGRESSIVE_MIN_CHARS + 5000);
    const el = (editing: boolean) => <MarkdownView path="big.md" content={doc} editing={editing} draft={doc} projectRoot="/p" {...({} as any)} />;
    const r = render(el(false));
    const root = () => r.container.querySelector('[data-artifact-viewer]');
    drain();
    expect(root()!.hasAttribute('data-doc-loading')).toBe(false);
    r.rerender(el(true));
    expect(r.container.querySelector('textarea')).not.toBeNull();
    r.rerender(el(false));
    expect(frames.length).toBeGreaterThan(0);
    expect(root()!.hasAttribute('data-doc-loading')).toBe(true);
    drain();
    expect(root()!.hasAttribute('data-doc-loading')).toBe(false);
  });

  // Review 2026-10-22, item 2: the assistant edits the open file. The page must not collapse to a first slice.
  it('a changed text for a file already on screen is drawn whole at once, so the page keeps its height', () => {
    const line = 'Some prose line for the viewer.\n\n';
    const v1 = big(line, PROGRESSIVE_MIN_CHARS + 5000);
    const v2 = v1 + 'THE-NEW-LAST-PARAGRAPH\n';
    const el = (c: string) => <MarkdownView path="big.md" content={c} projectRoot="/p" {...({} as any)} />;
    const r = render(el(v1));
    drain();
    const before = r.container.querySelectorAll('p').length;
    r.rerender(el(v2));
    // Everything is there in the very first commit: nothing queued, no loading flag, last paragraph present.
    expect(frames.length).toBe(0);
    expect(r.container.querySelector('[data-artifact-viewer]')!.hasAttribute('data-doc-loading')).toBe(false);
    expect(r.container.textContent).toContain('THE-NEW-LAST-PARAGRAPH');
    expect(r.container.querySelectorAll('p').length).toBe(before + 1);
  });

  it('a big .txt ends as the whole text in one <pre>, drawn over several frames', () => {
    const text = Array.from({ length: 30000 }, (_, i) => `log line ${i} with some words`).join('\n');
    const r = render(view('big.txt', text));
    const pre = () => r.container.querySelector('pre')!;
    const firstLen = pre().textContent!.length;
    expect(firstLen).toBeLessThan(text.length / 2);
    expect(firstLen).toBeGreaterThan(0);
    drain();
    expect(r.container.querySelectorAll('pre').length).toBe(1);
    expect(pre().textContent).toBe(text);
  });

  it('a small .txt is unchanged and never queues a frame', () => {
    const r = render(view('a.txt', 'one\ntwo'));
    expect(frames.length).toBe(0);
    expect(r.container.querySelector('pre')!.textContent).toBe('one\ntwo');
  });
});
