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
import MarkdownContent, { codeLineCount } from '../src/renderer/components/MarkdownContent';

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

describe('a code block carries the line count its placeholder height comes from', () => {
  it('sets --yc-lines to the number of lines in the fence', () => {
    const fence = '```ts\n' + Array.from({ length: 43 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n```';
    const { container } = render(<MarkdownContent content={fence} />);
    const block = container.querySelector('.yc-code-block') as HTMLElement;
    expect(block).not.toBeNull();
    expect(block.style.getPropertyValue('--yc-lines')).toBe('43');
  });
});

describe('the stylesheet holds the block at its drawn height while it is skipped', () => {
  const css = readSource(join(RENDERER, 'styles', 'globals.css'));
  const rule = css.match(/\.yc-code-block \{[^}]*\}/s)?.[0] ?? '';
  it('derives the height from --yc-lines: 1.25rem per line plus the 1.5rem the <pre> pads', () => {
    expect(rule).toContain('content-visibility: auto');
    expect(rule).toMatch(/contain-intrinsic-height:\s*auto calc\(var\(--yc-lines,\s*\d+\) \* 1\.25rem \+ 1\.5rem\)/);
  });
  it('no longer guesses one flat height for every block', () => {
    expect(rule).not.toMatch(/contain-intrinsic-size:\s*auto 8rem/);
  });
});
