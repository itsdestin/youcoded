// @vitest-environment jsdom
/**
 * The other two note editors never show — or overwrite — a note they could not read.
 *
 * Code review 2026-09-11, F1, on error inventory false message 12. Commit 008eedb4 made both
 * hosts answer `unreadable` for a failed read and taught the close prompt to honour it. The
 * two other editors of the same note did not: useSessionMeta (the in-session tags chip) and
 * usePreviewMeta (the drawer's preview sheet) still loaded a failed read as an empty note,
 * and both save the WHOLE note text on edit — so typing replaced the stored note nobody was
 * shown.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { join } from 'node:path';
import { useSessionMeta } from '../src/renderer/hooks/useSessionMeta';
import { usePreviewMeta } from '../src/renderer/hooks/usePreviewMeta';
import { readStripped } from './helpers/guard-scope';

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

  it('the drawer does not open a note editor for an unreadable note', () => {
    const src = readStripped(join(__dirname, '..', 'src', 'renderer', 'components', 'SessionDrawer.tsx'));
    const at = src.indexOf('onNote={previewMeta.saveNote}');
    expect(at, 'preview note editor not found').toBeGreaterThanOrEqual(0);
    expect(src.slice(Math.max(0, at - 1500), at)).toMatch(/previewMeta\.unreadable/);
  });
});
