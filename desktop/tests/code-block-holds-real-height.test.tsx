// @vitest-environment jsdom
// A code block the browser has not drawn yet (content-visibility: auto) holds a placeholder height. When
// that placeholder was a flat 8rem, a 43-line block grew by ~750px the instant a fast scroll brought it
// near the screen, and everything below it jumped (first-draw-stability journey under CPU load,
// 2026-10-23: "scrolling up moved the entry in view by 855px"). The placeholder is now the block's real
// height, computed from its line count. jsdom has no layout, so this pins the two halves separately: the
// block carries its line count, and the stylesheet turns the count into the real height. The pixel-exact
// proof (placeholder == drawn height) is the first-draw-stability journey.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { join } from 'path';
import { RENDERER, readSource } from './helpers/guard-scope';
import React from 'react';
import MarkdownContent, { codeLineCount, placeholderRem } from '../src/renderer/components/MarkdownContent';

afterEach(cleanup);

describe('codeLineCount', () => {
  it('counts lines the way a <pre> shows them: a final newline starts no new line', () => {
    expect(codeLineCount('')).toBe(1);
    expect(codeLineCount('a')).toBe(1);
    expect(codeLineCount('a\n')).toBe(1);
    expect(codeLineCount('a\nb')).toBe(2);
    expect(codeLineCount('a\nb\n')).toBe(2);
    expect(codeLineCount('a\n\nb')).toBe(3);
  });
});

describe('a code block carries the height its placeholder comes from', () => {
  const fence = '```ts\n' + Array.from({ length: 43 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n```';
  it('sets contain-intrinsic-height inline: 1.25rem per line plus the 1.5rem the <pre> pads', () => {
    const { container } = render(<MarkdownContent content={fence} />);
    const block = container.querySelector('.yc-code-block') as HTMLElement;
    expect(block).not.toBeNull();
    // 43 * 1.25 + 1.5 = 55.25rem
    expect(placeholderRem(43)).toBe(55.25);
    expect(block.getAttribute('style') ?? '').toMatch(/contain-intrinsic-height:\s*auto 55\.25rem/);
  });
  it('sets NO custom property on the block (an inherited one restyles every coloured span inside it on each change)', () => {
    // WHY: --yc-lines was set here and changed with every streamed line; being inherited, it made the browser re-check the
    // style of every descendant (3.3 s of style recalculation per 6 s on a 2,000-line fence; typing 61 ms vs 12 ms).
    const { container } = render(<MarkdownContent content={fence} />);
    const block = container.querySelector('.yc-code-block') as HTMLElement;
    expect(block.getAttribute('style') ?? '').not.toMatch(/--/);
    expect(block.style.getPropertyValue('--yc-lines')).toBe('');
  });
});

describe('the stylesheet no longer computes the height from an inherited custom property', () => {
  const css = readSource(join(RENDERER, 'styles', 'globals.css'));
  const rule = css.match(/\.yc-code-block \{[^}]*\}/s)?.[0] ?? '';
  it('keeps content-visibility and never reads --yc-lines', () => {
    expect(rule).toContain('content-visibility: auto');
    expect(css).not.toMatch(/var\(--yc-lines/);
  });
  it('no longer guesses one flat height for every block (the inline height overrides the fallback)', () => {
    expect(rule).not.toMatch(/contain-intrinsic-size:\s*auto 8rem/);
  });
});
