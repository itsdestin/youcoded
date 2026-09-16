// @vitest-environment jsdom
/**
 * The tag picker and the Resume Browser's tag filter never call a failed read "No tags yet".
 *
 * Code review 2026-09-11, F5, on error inventory false message 16. Commit 09f0b6d7 gave
 * useTagRegistry an `error` and taught the tag manager to show it, but two other readers of
 * the same registry kept their empty states: the tag picker still said "No tags yet — type a
 * name to create one." (inviting duplicates of tags the user already has) and the Resume
 * Browser's tag filter still said "No tags yet".
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { join } from 'node:path';
import { TagPicker } from '../src/renderer/components/tags/TagPicker';
import { readStripped } from './helpers/guard-scope';

afterEach(cleanup);

const registry = (error: string | null) => ({
  tags: [], byId: new Map(), loading: false, error,
  reload: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(),
});

describe('TagPicker — a failed read is not "No tags yet"', () => {
  it('says the tags could not be loaded', () => {
    render(<TagPicker appliedIds={new Set()} onToggle={() => {}} registry={registry('EACCES: permission denied') as any} />);

    expect(screen.getByText(/couldn.t load your tags/i)).toBeInTheDocument();
    expect(screen.queryByText(/No tags yet/)).toBeNull();
  });

  it('a registry that loaded empty still says "No tags yet"', () => {
    render(<TagPicker appliedIds={new Set()} onToggle={() => {}} registry={registry(null) as any} />);

    expect(screen.getByText(/No tags yet/)).toBeInTheDocument();
  });
});

describe('Resume Browser tag filter', () => {
  it('checks the registry error before saying "No tags yet"', () => {
    const src = readStripped(join(__dirname, '..', 'src', 'renderer', 'components', 'ResumeBrowser.tsx'));
    const at = src.indexOf('message="No tags yet"');
    expect(at, 'the filter empty state was not found').toBeGreaterThanOrEqual(0);
    expect(src.slice(Math.max(0, at - 600), at)).toMatch(/registry\.error/);
  });
});
