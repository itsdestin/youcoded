// @vitest-environment jsdom
// Freeze hunt 2026-10-22, item 2: a code fence over the size limit is not coloured.
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import MarkdownContent from './MarkdownContent';
import { HIGHLIGHT_MAX_LINES, HIGHLIGHT_MAX_CHARS } from './markdown-blocks';

afterEach(cleanup);

const codeLines = (n: number) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join('\n');
const fence = (lang: string, n: number) => '```' + lang + '\n' + codeLines(n) + '\n```';

describe('code fences over the colour limit', () => {
  it('a fence under the limit is coloured as before', () => {
    const r = render(<MarkdownContent content={fence('js', 50)} />);
    expect(r.container.querySelector('.hljs-keyword')).not.toBeNull();
    expect(r.container.querySelector('code.hljs')).not.toBeNull();
  });

  it('a fence over the line limit draws like a fence with no language', () => {
    const big = render(<MarkdownContent content={fence('js', HIGHLIGHT_MAX_LINES + 50)} />);
    const plain = render(<MarkdownContent content={fence('', HIGHLIGHT_MAX_LINES + 50)} />);
    expect(big.container.querySelector('.hljs-keyword')).toBeNull();
    expect(big.container.querySelector('code.hljs')).toBeNull();
    // Same box, same Copy button, same text - identical markup to the unlabelled fence.
    expect(big.container.innerHTML).toBe(plain.container.innerHTML);
    expect(big.container.textContent).toContain('const v1549 = 1549;');
    expect(big.container.querySelector('button')).not.toBeNull();
  });

  it('a fence over the size limit (few long lines) is not coloured either', () => {
    const line = 'const x = "' + 'a'.repeat(1000) + '";';
    const md = '```js\n' + Array.from({ length: Math.ceil(HIGHLIGHT_MAX_CHARS / 1000) + 5 }, () => line).join('\n') + '\n```';
    const r = render(<MarkdownContent content={md} />);
    expect(r.container.querySelector('.hljs-keyword')).toBeNull();
  });

  it('the limit is per fence: a small fence beside a huge one keeps its colour', () => {
    const r = render(<MarkdownContent content={fence('js', HIGHLIGHT_MAX_LINES + 10) + '\n\n' + fence('js', 3)} />);
    expect(r.container.querySelectorAll('code.hljs').length).toBe(1);
  });

  it('colouring cost is bounded: a 20,000-line labelled fence draws fast', () => {
    const t = performance.now();
    render(<MarkdownContent content={fence('js', 20000)} />);
    // Coloured this takes seconds; unlabelled it is a fraction of that. Generous for slow CI.
    expect(performance.now() - t).toBeLessThan(4000);
  });

  it('a streaming fence stays uncoloured once past the limit, and ends the same way', () => {
    const lines = HIGHLIGHT_MAX_LINES + 100;
    const open = '```js\n' + codeLines(lines);
    // Under the limit while streaming: coloured chunks.
    const small = render(<MarkdownContent content={'```js\n' + codeLines(200) + '\n'} incremental live />);
    expect(small.container.querySelector('.hljs-keyword')).not.toBeNull();
    small.unmount();
    // Past the limit, mid-stream (fence still open): no colour anywhere.
    const mid = render(<MarkdownContent content={open + '\n'} incremental live />);
    expect(mid.container.querySelector('.hljs-keyword')).toBeNull();
    const midText = mid.container.textContent;
    // Mounted growing from under the limit to over it: colour goes away and stays away.
    const grow = render(<MarkdownContent content={'```js\n' + codeLines(400) + '\n'} incremental live />);
    expect(grow.container.querySelector('.hljs-keyword')).not.toBeNull();
    grow.rerender(<MarkdownContent content={open + '\n'} incremental live />);
    expect(grow.container.querySelector('.hljs-keyword')).toBeNull();
    // The reply finishes: closing fence arrives, still uncoloured, same text.
    grow.rerender(<MarkdownContent content={open + '\n```'} incremental live={false} />);
    expect(grow.container.querySelector('.hljs-keyword')).toBeNull();
    expect(grow.container.textContent).toContain('const v1599 = 1599;');
    expect(midText).toContain('const v1599 = 1599;');
  });

  // Review 2026-10-22: the streaming count and the finished count must agree exactly AT the limit.
  it.each([
    [HIGHLIGHT_MAX_LINES, true],
    [HIGHLIGHT_MAX_LINES + 1, false],
  ])('a fence of exactly %i lines is coloured=%s both while streaming and when finished', (n, coloured) => {
    const body = codeLines(n);
    const has = (c: HTMLElement) => c.querySelector('.hljs-keyword') !== null;
    // Open fence, last line still being typed (no line ending yet) ...
    const typing = render(<MarkdownContent content={'```js\n' + body} incremental live />);
    expect(has(typing.container)).toBe(coloured);
    // ... last line complete, fence still open ...
    typing.rerender(<MarkdownContent content={'```js\n' + body + '\n'} incremental live />);
    expect(has(typing.container)).toBe(coloured);
    // ... and finished.
    typing.rerender(<MarkdownContent content={'```js\n' + body + '\n```'} incremental live={false} />);
    expect(has(typing.container)).toBe(coloured);
    const whole = render(<MarkdownContent content={'```js\n' + body + '\n```'} />);
    expect(has(whole.container)).toBe(coloured);
  });
});

// Freeze hunt item 3: redrawing every earlier coloured chunk plain in ONE commit at the crossing was a 66-72 ms
// burst mid-stream (typing lagged 140-220 ms there; master never redraws). They now go plain a few per frame.
describe('a streaming fence passing the limit does not redraw every earlier chunk at once', () => {
  const lineAt = (i: number) => `const v${i} = ${i};`;
  const text = (n: number) => '```js\n' + Array.from({ length: n }, (_, i) => lineAt(i)).join('\n') + '\n';
  it('keeps most earlier chunks coloured in the crossing commit, then all go plain', async () => {
    // A streaming message grows into chunked drawing (a fresh mount draws whole), so start small.
    const r = render(<MarkdownContent content={text(100)} incremental live />);
    r.rerender(<MarkdownContent content={text(HIGHLIGHT_MAX_LINES - 20)} incremental live />);
    expect(r.container.querySelectorAll('.yc-fence-chunk .hljs-keyword').length).toBeGreaterThan(50);
    const coloured = () => r.container.querySelectorAll('.yc-fence-chunk .hljs-keyword').length;
    const before = coloured();
    r.rerender(<MarkdownContent content={text(HIGHLIGHT_MAX_LINES + 20)} incremental live />);
    // Not all at once: the crossing commit leaves the bulk of the old chunks as they were.
    expect(coloured()).toBeGreaterThan(before / 2);
    // ...and the end state is the same as the all-at-once version: nothing coloured.
    await vi.waitFor(() => expect(r.container.querySelector('.hljs-keyword')).toBeNull(), { timeout: 5000 });
    expect(r.container.textContent).toContain(`const v${HIGHLIGHT_MAX_LINES + 19} = ${HIGHLIGHT_MAX_LINES + 19};`);
  });
});
