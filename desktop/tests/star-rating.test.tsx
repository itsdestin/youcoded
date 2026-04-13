// @vitest-environment jsdom
// star-rating.test.tsx
// Unit tests for the pure StarRating component.
// Tests: null render for count<1, correct aria-label, review count display,
// size class difference between "sm" and "lg".

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import StarRating from '../src/renderer/components/marketplace/StarRating';

describe('StarRating', () => {
  afterEach(cleanup);

  it('renders null when count < 1', () => {
    const { container } = render(<StarRating value={4.5} count={0} size="sm" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders null when count is negative', () => {
    const { container } = render(<StarRating value={3} count={-1} size="sm" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders review count when count >= 1', () => {
    const { getByRole } = render(<StarRating value={3.7} count={10} size="sm" />);
    const el = getByRole('img');
    expect(el.textContent).toContain('(10)');
  });

  it('renders 5 stars in the filled and empty layers', () => {
    const { getByRole } = render(<StarRating value={3.7} count={10} size="sm" />);
    const el = getByRole('img');
    // Both layers have 5 star chars; the filled layer is aria-hidden
    const hiddenSpans = el.querySelectorAll('[aria-hidden]');
    expect(hiddenSpans.length).toBeGreaterThan(0);
    // Stars visible in the DOM text content (both layers combined)
    const text = el.textContent ?? '';
    // (10) + ★★★★★☆☆☆☆☆ or similar — at least 5 star chars total
    const starCount = (text.match(/[★☆]/g) ?? []).length;
    expect(starCount).toBeGreaterThanOrEqual(5);
  });

  it('aria-label includes rating and review count', () => {
    const { getByRole } = render(<StarRating value={4.3} count={27} size="sm" />);
    const el = getByRole('img');
    expect(el.getAttribute('aria-label')).toContain('4.3');
    expect(el.getAttribute('aria-label')).toContain('27');
  });

  it('aria-label includes "reviews" for plural count', () => {
    const { getByRole } = render(<StarRating value={4.0} count={5} size="sm" />);
    const label = getByRole('img').getAttribute('aria-label') ?? '';
    expect(label).toContain('reviews');
  });

  it('aria-label uses "review" (singular) for count=1', () => {
    const { getByRole } = render(<StarRating value={5} count={1} size="sm" />);
    const label = getByRole('img').getAttribute('aria-label') ?? '';
    expect(label).toContain('1 review');
    // Should NOT say "reviews" (plural)
    expect(label).not.toContain('reviews');
  });

  it('size="sm" and size="lg" produce different CSS classes', () => {
    const { container: smContainer } = render(
      <div id="sm"><StarRating value={3} count={5} size="sm" /></div>
    );
    const { container: lgContainer } = render(
      <div id="lg"><StarRating value={3} count={5} size="lg" /></div>
    );

    const smEl = smContainer.querySelector('[role="img"]');
    const lgEl = lgContainer.querySelector('[role="img"]');

    expect(smEl).toBeTruthy();
    expect(lgEl).toBeTruthy();

    // The container class differs between sm and lg
    const smClass = smEl?.className ?? '';
    const lgClass = lgEl?.className ?? '';
    expect(smClass).not.toBe(lgClass);
  });
});
