// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, renderHook, waitFor } from '@testing-library/react';
import { SessionDetails, SessionTagsCard } from '../src/renderer/components/tags/SessionDetails';
import { type TagRegistryApi } from '../src/renderer/hooks/useTagRegistry';
import React from 'react';
import { useSessionMeta } from '../src/renderer/hooks/useSessionMeta';
import { usePreviewMeta } from '../src/renderer/hooks/usePreviewMeta';

// Session details: Pin to top and Mark complete sit together under their own "In your lists" label (not in an unlabelled card that read as
// part of "Tags"), and Mark complete is offered on every Session details surface, not only the close prompt.
describe('In your lists card', () => {
  afterEach(cleanup);

  const registry: TagRegistryApi = {
    tags: [], byId: new Map(), loading: false, error: null,
    reload: () => {}, create: async () => null, update: async () => {}, remove: async () => {},
  };

  function mount(over: { pinned?: boolean; done?: boolean } = {}) {
    const onPin = vi.fn(), onComplete = vi.fn();
    render(<SessionDetails name="fix chat scroll stick" note="" onNote={() => {}} registry={registry}
      appliedIds={new Set()} onToggleTag={() => {}}
      pin={{ pinned: !!over.pinned, onPin }} complete={{ done: !!over.done, onComplete }} />);
    return { onPin, onComplete };
  }

  describe('Session details — "In your lists"', () => {
    it('holds Pin to top and Mark complete in one card under its own label, outside Tags', () => {
      mount();
      const card = screen.getByText('In your lists').parentElement!;
      expect(card).toContainElement(screen.getByRole('switch', { name: 'Pin to top' }));
      expect(card).toContainElement(screen.getByRole('switch', { name: 'Mark complete' }));
      expect(screen.getByText('Tags').parentElement).not.toContainElement(screen.getByRole('switch', { name: 'Mark complete' }));
    });

    it('Mark complete shows its state and reports a change; both switches carry their hints', () => {
      const { onComplete, onPin } = mount({ done: true });
      const sw = screen.getByRole('switch', { name: 'Mark complete' });
      expect(sw).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(sw);
      expect(onComplete).toHaveBeenCalledWith(false);
      expect(onPin).not.toHaveBeenCalled();
      // Destin's wording for both popups (close-session-3#CS3-3; Pin to top says "resumable" since final-review#Q-3).
      expect(screen.getByText(/hides this session/i)).toBeInTheDocument();
      expect(screen.getByText(/at the top of/i)).toBeInTheDocument();
    });
  });
});

// Pins error-notices-1#EN-3 (Destin, 2026-10-12: "should still keep the tags section
// header"). When the tags cannot be loaded, the notice takes the CARD's place and the
// "Tags" label stays above it — the guide's "a problem replaces the card it is about:
// same spot, same label above it". It used to return the notice alone, label and all gone.
describe('tags that cannot load', () => {
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
});

/**
 * The other two note editors never show — or overwrite — a note they could not read.
 *
 * Code review 2026-09-11, F1, on error inventory false message 12. Commit 008eedb4 made both
 * hosts answer `unreadable` for a failed read and taught the close prompt to honour it. The
 * two other editors of the same note did not: useSessionMeta (the in-session tags chip) and
 * usePreviewMeta (the drawer's preview sheet) still loaded a failed read as an empty note,
 * and both save the WHOLE note text on edit — so typing replaced the stored note nobody was
 * shown.
 *
 * WHY the drawer half is not here (Plan B, 2026-09-16): "SessionDrawer renders its note editor
 * only behind previewMeta.unreadable" is the ast-grep rule note-editor-guarded-on-unreadable in
 * the workspace's scripts/ast-grep/rules/.
 */
describe('unreadable notes', () => {
  afterEach(() => { cleanup(); delete (window as any).claude; });

  const UNREADABLE = { tags: [], note: '', supported: true, unreadable: "EACCES: permission denied, open '/home/me/YouCoded/Personal/Conversations/claude/s1.json'" };
  const REJECTION = new Error("Error invoking remote method 'session:get-meta': Error: store unavailable");

  describe('useSessionMeta (the in-session tags chip) — an unreadable note locks the editor', () => {
    it('a host answer marked unreadable disables writes and says why', async () => {
      (window as any).claude = { session: { getMeta: vi.fn().mockResolvedValue(UNREADABLE) }, on: {} };
      const { result } = renderHook(() => useSessionMeta('s1'));

      await waitFor(() => expect(result.current.supported).toBe(false));
      expect(result.current.unsupportedReason).toMatch(/couldn.t load this conversation.s tags and note/i);
      expect(result.current.unsupportedReason).toContain('EACCES');
    });

    it('a rejected read does the same, without the transport wrapper', async () => {
      (window as any).claude = { session: { getMeta: vi.fn().mockRejectedValue(REJECTION) }, on: {} };
      const { result } = renderHook(() => useSessionMeta('s1'));

      await waitFor(() => expect(result.current.supported).toBe(false));
      expect(result.current.unsupportedReason).toMatch(/couldn.t load/i);
      expect(result.current.unsupportedReason).not.toMatch(/Error invoking remote method/);
    });
  });

  describe('usePreviewMeta (the drawer preview sheet) — an unreadable note is reported, not blanked', () => {
    it('a host answer marked unreadable exposes the reason', async () => {
      (window as any).claude = { session: { getMeta: vi.fn().mockResolvedValue(UNREADABLE) } };
      const { result } = renderHook(() => usePreviewMeta('conv-1'));

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect((result.current as any).unreadable).toMatch(/EACCES/);
    });

    it('a rejected read exposes its reason too', async () => {
      (window as any).claude = { session: { getMeta: vi.fn().mockRejectedValue(REJECTION) } };
      const { result } = renderHook(() => usePreviewMeta('conv-1'));

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect((result.current as any).unreadable).toMatch(/store unavailable/);
    });
  });

  // 2026-10-04: only the newest read may land. A slow answer for the conversation you just
  // left used to overwrite the tags of the one now on screen.
  describe('useSessionMeta — a late answer for the previous session is ignored', () => {
    it('switching sessions keeps the new session\'s tags when the old read finishes last', async () => {
      let finishOld!: (v: unknown) => void;
      const getMeta = vi.fn((id: string) => id === 'old'
        ? new Promise((r) => { finishOld = r; })
        : Promise.resolve({ tags: ['tag_new'], note: '', supported: true }));
      (window as any).claude = { session: { getMeta }, on: {} };
      const { result, rerender } = renderHook(({ id }) => useSessionMeta(id), { initialProps: { id: 'old' } });

      rerender({ id: 'new' });
      await waitFor(() => expect([...result.current.tags]).toEqual(['tag_new']));
      finishOld({ tags: ['tag_old'], note: 'old note', supported: true });
      // settle (negative assertion): the old session's late answer must not overwrite.
      await new Promise((r) => setTimeout(r, 20));

      expect([...result.current.tags]).toEqual(['tag_new']);
      expect(result.current.note).toBe('');
    });
  });
});
