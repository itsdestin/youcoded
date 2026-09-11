// src/renderer/hooks/useSessionMeta.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { META_UNSUPPORTED_FALLBACK, type SessionFlagName, type SessionMetaResult } from '../../shared/types';
import { plainMessage } from '../utils/ipc-error';

export interface SessionMetaApi {
  tags: Set<string>;   // applied tag ids
  note: string;
  /** Reserved flags currently set. Empty when the host doesn't report them
   *  (Android, or an older remote peer) — missing is "none set", never an
   *  error. Drives Priority-as-a-built-in-tag in the in-session chip. */
  flags: Partial<Record<SessionFlagName, boolean>>;
  /** False when the backend will REFUSE writes for this session (a desktop native
   *  session, or an Android host where tags/notes aren't built yet) — and also when
   *  the tags and note could not be READ, so nothing can overwrite what was never shown.
   *  Render the controls disabled. */
  supported: boolean;
  /** Host-supplied explanation for `supported: false`, for the disabled tooltip.
   *  Falls back to META_UNSUPPORTED_FALLBACK when the host didn't say. */
  unsupportedReason: string;
  setTag: (tagId: string, next: boolean) => void;
  setNote: (text: string) => void;
  setFlag: (flag: SessionFlagName, next: boolean) => void;
}

export function useSessionMeta(sessionId: string | null): SessionMetaApi {
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [flags, setFlags] = useState<Partial<Record<SessionFlagName, boolean>>>({});
  const [note, setNoteState] = useState('');
  // Default TRUE so the controls don't flash disabled during the first getMeta.
  const [supported, setSupported] = useState(true);
  // Last value we believe the backend accepted — the rollback target for a
  // refused write. Kept in a ref so back-to-back setNote calls chain correctly.
  const savedNote = useRef('');
  const [unsupportedReason, setUnsupportedReason] = useState(META_UNSUPPORTED_FALLBACK);

  // Only a refusal that explicitly says `unsupported` may flip `supported`.
  // Ordinary failures (invalid tag id, note too long) must NOT touch it — and
  // must not re-enable it either, which `setSupported(!res.unsupported)` did.
  const noteRefusal = useCallback((res: any) => {
    if (!res?.unsupported) return;
    setSupported(false);
    // Deliberately NOT res.error — that carries machine strings in places
    // (Android answers 'not-implemented-on-mobile'), and this text is shown to
    // the user. Only an explicit user-facing reason is displayed.
    if (res.unsupportedReason) setUnsupportedReason(String(res.unsupportedReason));
  }, []);

  const refetch = useCallback(() => {
    if (!sessionId) { setTags(new Set()); setFlags({}); setNoteState(''); savedNote.current = ''; setSupported(true); return; }
    // WHY a failed read locks the editor (code review 2026-09-11, F1, on error inventory
    // false message 12): this used to load a failed read as an empty note with writes
    // still enabled — and setNote saves the WHOLE text, so typing replaced the stored note
    // nobody was shown. The hosts now answer `unreadable`; that, or a rejected call, takes
    // the same disabled state a refusing host does, with the reason in the tooltip.
    const markUnreadable = (reason: string) => {
      setTags(new Set()); setFlags({}); setNoteState(''); savedNote.current = '';
      setSupported(false);
      setUnsupportedReason(`Couldn't load this conversation's tags and note, so they can't be changed here: ${reason}`);
    };
    Promise.resolve((window as any).claude.session.getMeta(sessionId))
      .then((m: SessionMetaResult) => {
        if (m?.unreadable) { markUnreadable(m.unreadable); return; }
        setTags(new Set(m?.tags ?? []));
        // Missing is "none set" — an older peer omits the field entirely.
        setFlags(m?.flags ?? {});
        setNoteState(m?.note ?? '');
        // Server truth resets the rollback target too, or a later refusal would
        // revert to a value the backend never held.
        savedNote.current = m?.note ?? '';
        // Older backends (remote peer on a previous build) omit the field entirely
        // — treat missing as supported so we never disable against an unknown host.
        setSupported(m?.supported !== false);
        setUnsupportedReason(m?.unsupportedReason || META_UNSUPPORTED_FALLBACK);
      })
      .catch((err: unknown) => markUnreadable(plainMessage(err)));
  }, [sessionId]);

  useEffect(() => {
    refetch();
    // Refetch on ANY session:meta-changed — deliberately NOT gated on the event's
    // session id. For a LIVE session the broadcast carries the RESOLVED Claude id
    // (ipc-handlers resolves via sessionIdMap before broadcasting) while this hook
    // holds the DESKTOP session id, so an id-equality gate would silently never
    // fire (e.g. the buddy window tagging the same live session). meta changes are
    // rare and getMeta is one cheap IPC call, so an unconditional refetch is both
    // correct and inexpensive. The user's own edits are already covered optimistically
    // by setTag/setNote below.
    const off = (window as any).claude.on?.sessionMetaChanged?.(() => refetch());
    return () => { if (typeof off === 'function') off(); };
  }, [sessionId, refetch]);

  const setTag = useCallback((tagId: string, next: boolean) => {
    if (!sessionId) return;
    const revert = () => setTags((prev) => {
      const s = new Set(prev); if (next) s.delete(tagId); else s.add(tagId); return s;
    });
    setTags((prev) => { const s = new Set(prev); if (next) s.add(tagId); else s.delete(tagId); return s; });
    // Optimistic, but NOT fire-and-forget: an ok:false (e.g. a native session, whose
    // meta the store can't hold yet) must roll the local state back, otherwise the
    // edit looks saved until the next refetch. Promise.resolve(...).catch still
    // swallows transport rejections (remote timeout / Android) — those are logged
    // backend-side and we leave the optimistic value rather than fighting the network.
    try {
      Promise.resolve((window as any).claude.session.setTag(sessionId, tagId, next))
        .then((res: any) => { if (res && res.ok === false) { revert(); noteRefusal(res); } })
        .catch(() => {});
    } catch { /* backend logs */ }
  }, [sessionId, noteRefusal]);

  const setNote = useCallback((text: string) => {
    if (!sessionId) return;
    // Revert target comes from a REF, not the render closure: two setNote calls
    // dispatched from the same callback instance would both capture the same
    // closure value, so a failed second write could roll back past the first.
    const prevNote = savedNote.current;
    savedNote.current = text;
    setNoteState(text);
    try {
      Promise.resolve((window as any).claude.session.setNote(sessionId, text))
        .then((res: any) => {
          if (res && res.ok === false) { savedNote.current = prevNote; setNoteState(prevNote); noteRefusal(res); }
        })
        .catch(() => {});
    } catch { /* backend logs */ }
  }, [sessionId, noteRefusal]);

  // Same optimistic-then-revert contract as setTag: a refused write must roll
  // the local value back, or the flag looks set until the next refetch.
  const setFlag = useCallback((flag: SessionFlagName, next: boolean) => {
    if (!sessionId) return;
    const prev = !!flags[flag];
    setFlags((f) => ({ ...f, [flag]: next }));
    try {
      Promise.resolve((window as any).claude.session.setFlag(sessionId, flag, next))
        .then((res: any) => { if (res && res.ok === false) { setFlags((f) => ({ ...f, [flag]: prev })); noteRefusal(res); } })
        .catch(() => {});
    } catch { /* backend logs */ }
  }, [sessionId, flags, noteRefusal]);

  return { tags, flags, note, supported, unsupportedReason, setTag, setNote, setFlag };
}
