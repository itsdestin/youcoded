// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { PageGlyph } from '../src/renderer/components/pages/page-icons';
import type { PageCustomIcon, PageIcon } from '../src/shared/pages-types';

const house: PageCustomIcon = { version: 1, paths: ['M3 10 L12 3 L21 10', 'M5 9 L5 21 L10 21 L10 15 L14 15 L14 21 L19 21 L19 9'] };

describe('PageGlyph', () => {
  it('draws custom paths in the existing outlined wrapper', () => {
    const { container } = render(<PageGlyph icon="page" customIcon={house} className="w-5 h-5" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('fill')).toBe('none');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('class')).toBe('w-5 h-5');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect([...svg.children].map(p => p.getAttribute('d'))).toEqual(house.paths);
    for (const path of svg.children) {
      expect(path.tagName.toLowerCase()).toBe('path');
      expect(path.getAttribute('stroke-width')).toBe('2');
      expect(path.getAttribute('stroke-linecap')).toBe('round');
      expect(path.getAttribute('stroke-linejoin')).toBe('round');
    }
  });

  it.each([undefined, { version: 2, paths: ['M0 0'] }, { version: 1, paths: ['<script>alert(1)</script>'] }])(
    'falls back without interpreting invalid custom metadata', customIcon => {
      const { container, rerender } = render(<PageGlyph icon="timer" />);
      const legacy = container.innerHTML;
      rerender(<PageGlyph icon="timer" customIcon={customIcon as PageCustomIcon} />);
      expect(container.innerHTML).toBe(legacy);
    },
  );

  it('preserves each legacy glyph and the unknown-name default', () => {
    const { container, rerender } = render(<PageGlyph icon="page" />);
    const fallback = container.innerHTML;
    for (const icon of ['timer', 'notes', 'paint', 'chart', 'calendar', 'list', 'game', 'money', 'office'] as PageIcon[]) {
      rerender(<PageGlyph icon={icon} />);
      expect(container.querySelectorAll('path')).toHaveLength(1);
      expect(container.innerHTML).not.toBe(fallback);
    }
    rerender(<PageGlyph icon={'unknown' as PageIcon} />);
    expect(container.innerHTML).toBe(fallback);
  });
});
