// @vitest-environment jsdom
// Pins error-notices-1#EN-3 (Destin, 2026-10-12: "should still keep the tags section
// header"). When the tags cannot be loaded, the notice takes the CARD's place and the
// "Tags" label stays above it — the guide's "a problem replaces the card it is about:
// same spot, same label above it". It used to return the notice alone, label and all gone.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { SessionTagsCard } from '../src/renderer/components/tags/SessionDetails';
import type { TagRegistryApi } from '../src/renderer/hooks/useTagRegistry';

afterEach(cleanup);

describe('Session details: Tags when they cannot load', () => {
  it('keeps the "Tags" label above the notice, and the notice offers Try again', () => {
    const registry = { tags: [], byId: new Map(), error: 'disk unreadable', reload: vi.fn(), create: vi.fn() } as unknown as TagRegistryApi;
    render(<SessionTagsCard registry={registry} appliedIds={new Set()} onToggleTag={() => {}} />);
    const label = screen.getByText('Tags');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load your tags: disk unreadable");
    // Label first, notice after it, in the same section.
    expect(label.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(label.closest('section')).toBe(alert.closest('section'));
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
