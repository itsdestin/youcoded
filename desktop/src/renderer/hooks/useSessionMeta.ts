// src/renderer/hooks/useSessionMeta.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { META_UNSUPPORTED_FALLBACK, type SessionFlagName, type SessionMetaResult } from '../../shared/types';
import { useOnRemoteReconnect } from './useOnRemoteReconnect';
import { plainMessage } from '../utils/ipc-error';
import { announceFailed } from '../utils/announce';

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
  // Last value the backend CONFIRMED (answered without ok:false) — the rollback target for a refused write. NOT the previous
  // optimistic value: with save 1 (on) and save 2 (off) in flight, a failing save 2 must return to what the server really holds,
  // not to save 1's unconfirmed "on". Refs so back-to-back calls see each other; a read of server truth resets them (round 4 review).
  const savedNote = useRef('');
  const confirmedTags = useRef<Set<string>>(new Set());
  const confirmedFlags = useRef<Partial<Record<SessionFlagName, boolean>>>({});
  // Counts the person's note edits. A read that started before the latest edit must not put the
  // older text back: the editor saves on every keystroke, and a re-read landing mid-typing (a
  // reconnect's, or the change event after a save) snapped letters back (review of the
  // 2026-09-11 reliability fixes, finding 5).
  const noteEdits = useRef(0);
  // WHY: only the newest read may land (2026-10-04). Without it, a slow answer for the
  // conversation you just left overwrote the one now on screen, and an answer arriving
  // after the view closed set state on nothing (seen as stray errors after a test ended).
  const readSeq = useRef(0);
  const [unsupportedReason, setUnsupportedReason] = useState(META_UNSUPPORTED_FALLBACK);
  // Card #134 round 4: a refused write already rolled the control back, but said nothing. It now says so — only for a real refusal
  // (`ok:false`) that is not the host-is-unsupported case (that one already greys the controls out with its reason on hover), and
  // only while this conversation is still the one on screen (a late answer for one you left, or after close, stays quiet).
  // Newest-wins per field: the number of the latest save SENT for each tag / flag. An older answer (a failure arriving after a newer
  // save of the same field) neither rolls back nor speaks, so it cannot put an old value back over a newer one.
  const fieldSeq = useRef<Record<string, number>>({});
  const nextSeq = (key: string) => (fieldSeq.current[key] = (fieldSeq.current[key] ?? 0) + 1);
  const liveSession = useRef<string | null>(sessionId);
  liveSession.current = sessionId;
  useEffect(() => () => { liveSession.current = null; }, []);
  const sayRefused = useCallback((forSession: string, what: string, res: any) => {
    if (liveSession.current !== forSession || res?.unsupported) return;
    announceFailed(what, res?.error);
  }, []);

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

  const refetch = useCallback((opts?: { keepOnFailure?: boolean }) => {
    if (!sessionId) { setTags(new Set()); setFlags({}); setNoteState(''); savedNote.current = ''; confirmedTags.current = new Set(); confirmedFlags.current = {}; setSupported(true); return; }
    const editsAtStart = noteEdits.current;
    const mine = ++readSeq.current;
    // WHY a failed read locks the editor (code review 2026-09-11, F1, on error inventory
    // false message 12): this used to load a failed read as an empty note with writes
    // still enabled — and setNote saves the WHOLE text, so typing replaced the stored note
    // nobody was shown. The hosts now answer `unreadable`; that, or a rejected call, takes
    // the same disabled state a refusing host does, with the reason in the tooltip.
    const markUnreadable = (reason: string) => {
      setTags(new Set()); setFlags({}); setNoteState(''); savedNote.current = ''; confirmedTags.current = new Set(); confirmedFlags.current = {};
      setSupported(false);
      setUnsupportedReason(`Couldn't load this conversation's tags and note, so they can't be changed here: ${reason}`);
    };
    Promise.resolve((window as any).claude.session.getMeta(sessionId))
      .then((m: SessionMetaResult) => {
        if (mine !== readSeq.current) return;
        if (m?.unreadable) { markUnreadable(m.unreadable); return; }
        setTags(new Set(m?.tags ?? []));
        confirmedTags.current = new Set(m?.tags ?? []);   // server truth is the rollback target
        // Missing is "none set" — an older peer omits the field entirely.
        setFlags(m?.flags ?? {});
        confirmedFlags.current = { ...(m?.flags ?? {}) };
        if (noteEdits.current === editsAtStart) {
          setNoteState(m?.note ?? '');
          // Server truth resets the rollback target too, or a later refusal would
          // revert to a value the backend never held.
          savedNote.current = m?.note ?? '';
        }
        // Older backends (remote peer on a previous build) omit the field entirely
        // — treat missing as supported so we never disable against an unknown host.
        setSupported(m?.supported !== false);
        setUnsupportedReason(m?.unsupportedReason || META_UNSUPPORTED_FALLBACK);
      })
      .catch((err: unknown) => {
        if (mine !== readSeq.current) return;
        // A re-read of the session already on screen keeps what it shows when it fails
        // (2026-09-11 phone pass: a lost request must not blank a conversation's tags).
        // A read that had nothing on screen says it is unreadable, with the reason, which
        // also disables writes — setNote saves the WHOLE text, so an empty editor over a
        // failed read would replace a note nobody was shown.
        if (opts?.keepOnFailure) return;
        markUnreadable(plainMessage(err));
      });
  }, [sessionId]);

  // A tag or note changed on the computer while the phone was away sent no event this phone
  // heard; read again after a reconnect (2026-09-11 phone pass sweep).
  useOnRemoteReconnect(() => refetch({ keepOnFailure: true }));

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
    return () => { readSeq.current++; if (typeof off === 'function') off(); };
  }, [sessionId, refetch]);

  const setTag = useCallback((tagId: string, next: boolean) => {
    if (!sessionId) return;
    const mine = nextSeq(`tag:${tagId}`);
    const isNewest = () => fieldSeq.current[`tag:${tagId}`] === mine;
    // WHY confirmed, not "the opposite of next": roll back to what the server last accepted for this tag.
    const revert = () => setTags((prev) => {
      const s = new Set(prev); if (confirmedTags.current.has(tagId)) s.add(tagId); else s.delete(tagId); return s;
    });
    setTags((prev) => { const s = new Set(prev); if (next) s.add(tagId); else s.delete(tagId); return s; });
    // Optimistic, but NOT fire-and-forget: an ok:false (e.g. a native session, whose
    // meta the store can't hold yet) must roll the local state back, otherwise the
    // edit looks saved until the next refetch. Promise.resolve(...).catch still
    // swallows transport rejections (remote timeout / Android) — those are logged
    // backend-side and we leave the optimistic value rather than fighting the network.
    try {
      Promise.resolve((window as any).claude.session.setTag(sessionId, tagId, next))
        .then((res: any) => {
          // WHY both checks (review of 12b302b16): only the NEWEST save of this tag may set the confirmed value (an older ok landing
          // last would put older data back), and an answer for a conversation we have since left must touch nothing in the new one.
          if (liveSession.current !== sessionId) return;
          if (!res || res.ok !== false) { if (isNewest()) { if (next) confirmedTags.current.add(tagId); else confirmedTags.current.delete(tagId); } return; }
          if (isNewest()) { revert(); noteRefusal(res); sayRefused(sessionId, 'save this tag change', res); }
        })
        .catch(() => {});
    } catch { /* backend logs */ }
  }, [sessionId, noteRefusal, sayRefused]);

  const setNote = useCallback((text: string) => {
    if (!sessionId) return;
    const myEdit = ++noteEdits.current;
    // Revert target is the last CONFIRMED text (a ref, so it is current even for two calls from one callback instance).
    setNoteState(text);
    try {
      Promise.resolve((window as any).claude.session.setNote(sessionId, text))
        .then((res: any) => {
          if (liveSession.current !== sessionId) return;   // another conversation is on screen now: this answer is not about it
          if (!res || res.ok !== false) { if (noteEdits.current === myEdit) savedNote.current = text; return; }   // only the newest edit confirms
          if (noteEdits.current === myEdit) { setNoteState(savedNote.current); noteRefusal(res); sayRefused(sessionId, 'save the note', res); }
        })
        .catch(() => {});
    } catch { /* backend logs */ }
  }, [sessionId, noteRefusal, sayRefused]);

  // Same optimistic-then-revert contract as setTag: a refused write must roll
  // the local value back, or the flag looks set until the next refetch.
  const setFlag = useCallback((flag: SessionFlagName, next: boolean) => {
    if (!sessionId) return;
    const mine = nextSeq(`flag:${flag}`);
    setFlags((f) => ({ ...f, [flag]: next }));
    try {
      Promise.resolve((window as any).claude.session.setFlag(sessionId, flag, next))
        .then((res: any) => {
          if (liveSession.current !== sessionId) return;   // answer for a conversation we have left
          if (!res || res.ok !== false) { if (fieldSeq.current[`flag:${flag}`] === mine) confirmedFlags.current[flag] = next; return; }   // only the newest save confirms
          if (fieldSeq.current[`flag:${flag}`] === mine) { setFlags((f) => ({ ...f, [flag]: !!confirmedFlags.current[flag] })); noteRefusal(res); sayRefused(sessionId, 'save this change', res); }
        })
        .catch(() => {});
    } catch { /* backend logs */ }
  }, [sessionId, noteRefusal, sayRefused]);

  return { tags, flags, note, supported, unsupportedReason, setTag, setNote, setFlag };
}
