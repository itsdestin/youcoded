// Tags + note for a PREVIEWED conversation (SessionDrawer's read-only pane).
//
// WHY: this is the first renderer caller that writes tags/note against a PAST
// conversation's id (spec 2026-08-26-conversation-preview-header-design.md,
// A1). `session:set-tag` / `session:set-note` already fall back to the raw id
// when it isn't a live session (ipc-handlers.ts:3153, :3179), but nothing in
// the renderer exercised that path before — so a failed write must not look
// like it succeeded. This mirrors ResumeBrowser.tsx's toggleTag/saveNote
// (optimistic apply, revert on `{ok:false}` or a thrown error) exactly, just
// scoped to one id instead of a session list.
import { useEffect, useState } from 'react';
import { plainMessage } from '../utils/ipc-error';

export interface PreviewMetaState {
  /** Applied tag ids (not labels — see chatsearch-refs.ts's note on the
   *  index storing labels; the meta store is id-keyed). */
  tags: string[];
  note: string;
  loading: boolean;
  /** Why the tags and note could NOT be read, or null when they were (possibly as none).
   *  WHY (code review 2026-09-11, F1, on error inventory false message 12): a failed read
   *  used to load as an empty note, and saveNote writes the WHOLE text — so typing in the
   *  preview sheet replaced a stored note nobody was shown. The drawer shows this reason
   *  instead of the editor, and the writers below refuse while it is set. */
  unreadable: string | null;
}

export interface PreviewMetaApi extends PreviewMetaState {
  toggleTag: (tagId: string, next: boolean) => Promise<void>;
  saveNote: (note: string) => Promise<void>;
  /** Read the tags and note again — the Retry on an `unreadable` failure. */
  reload: () => void;
}

const EMPTY: PreviewMetaState = { tags: [], note: '', loading: false, unreadable: null };

/** id: the previewed conversation's id, or null when nothing is previewed —
 *  callers pass null rather than skipping the hook call (rules of hooks). */
export function usePreviewMeta(id: string | null): PreviewMetaApi {
  const [state, setState] = useState<PreviewMetaState>(EMPTY);
  // Bumped by reload(); a dependency of the read effect, so bumping it reads again.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Cancelled flag: a fast re-preview (id changes again before the first
    // getMeta resolves) must not let the stale response clobber the newer
    // one — cleanup flips it so the in-flight call's result is dropped once
    // superseded.
    let cancelled = false;
    if (!id) { setState(EMPTY); return; }
    setState({ tags: [], note: '', loading: true, unreadable: null });
    // Fix: was `claude?.session?.getMeta?.(id).then(...)` — when `session`
    // (or `getMeta`) is absent, the optional chain short-circuits to
    // `undefined`, and `undefined.then` throws synchronously inside a
    // useEffect (uncaught — no promise to .catch). Wrapped in an async IIFE
    // + try/catch instead: `await undefined` just resolves to `undefined`,
    // so a host without this channel yet (or a test that mocks only part of
    // window.claude) degrades to the empty state rather than crashing.
    (async () => {
      try {
        const res: any = await (window as any).claude?.session?.getMeta?.(id);
        if (cancelled) return;
        if (typeof res?.unreadable === 'string' && res.unreadable) {
          setState({ tags: [], note: '', loading: false, unreadable: res.unreadable });
          return;
        }
        setState({
          tags: Array.isArray(res?.tags) ? res.tags : [],
          note: typeof res?.note === 'string' ? res.note : '',
          loading: false,
          unreadable: null,
        });
      } catch (e) {
        if (!cancelled) setState({ tags: [], note: '', loading: false, unreadable: plainMessage(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [id, attempt]);

  // Not memoized (recreated every render, like ResumeBrowser's toggleTag/
  // saveNote) so the closure always sees the latest `state` for rollback.
  const toggleTag = async (tagId: string, next: boolean) => {
    // Never write against tags that could not be read — see `unreadable`.
    if (!id || state.unreadable) return;
    const apply = (val: boolean) => setState((s) => ({
      ...s,
      tags: val ? [...new Set([...s.tags, tagId])] : s.tags.filter((t) => t !== tagId),
    }));
    apply(next);
    try {
      const res: any = await (window as any).claude.session.setTag(id, tagId, next);
      if (res && res.ok === false) apply(!next);
    } catch (e) {
      apply(!next);
      // eslint-disable-next-line no-console
      console.error('preview meta: setTag failed', e);
    }
  };

  const saveNote = async (note: string) => {
    // Never overwrite a note that could not be read — see `unreadable`.
    if (!id || state.unreadable) return;
    const prevNote = state.note;
    setState((s) => ({ ...s, note }));
    try {
      const res: any = await (window as any).claude.session.setNote(id, note);
      if (res && res.ok === false) setState((s) => ({ ...s, note: prevNote }));
    } catch (e) {
      setState((s) => ({ ...s, note: prevNote }));
      // eslint-disable-next-line no-console
      console.error('preview meta: setNote failed', e);
    }
  };

  return { ...state, toggleTag, saveNote, reload: () => setAttempt((a) => a + 1) };
}
