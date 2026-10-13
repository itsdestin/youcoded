// usePhoneSessionActions — App's adapters for the phone's instant Close and permission-mode chip (one-core R6-2).
//
// WHY a hook (review of R6-2): the behaviour lives in state/phone-session-actions.ts; App only had to hand it its own lists and setters, and that glue grew
// App.tsx by ~40 lines. It sits here, like hooks/useStatusBarProps.ts, so App keeps only the calls.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { chooseAfterDestroyed } from '../state/remote-place';
import { usePendingKeys, registerPendingResume } from '../state/pending-action';
import { closeSession, setNativeModeNow, cycleClaudeModeNow } from '../state/phone-session-actions';
import type { PermissionMode } from '../../shared/types';
import type { NativePermissionMode } from '../../shared/permission-types';

type Modes<M> = Map<string, M | 'unknown'>;
type SetModes<M> = (f: (prev: Modes<M>) => Modes<M>) => void;

export function usePhoneSessionActions<S extends { id: string }>(a: {
  sessionId: string | null;
  sessions: S[];
  setSessionId: (f: string | null | ((cur: string | null) => string | null)) => void;
  /** Finish a close the computer confirmed (App's own full local removal). */
  removeSessionLocally: (id: string) => void;
  permissionModes: Modes<PermissionMode>;
  nativePermissionModes: Modes<NativePermissionMode>;
  setPermissionModes: SetModes<PermissionMode>;
  setNativePermissionModes: SetModes<NativePermissionMode>;
  validNativeModes: readonly string[];
  /** Fill a conversation again from the record (the first-page loader's refill). */
  refill: (sessionId: string) => Promise<unknown>;
}) {
  const { sessionId, sessions, setSessionId, removeSessionLocally, setPermissionModes, setNativePermissionModes, validNativeModes, refill } = a;
  // Read back after the computer's answer: the lists as shown NOW, and the open conversation, never a render-time copy.
  const live = useRef({ sessionId, sessions, cc: a.permissionModes, native: a.nativePermissionModes });
  live.current = { sessionId, sessions, cc: a.permissionModes, native: a.nativePermissionModes };

  // A phone hides a closing conversation at once (it returns if the computer refuses) and dims the mode chip until confirmed.
  const closingKeys = usePendingKeys('close:');
  const modePending = usePendingKeys('mode:');
  const stripSessions = useMemo(() => (closingKeys.size ? sessions.filter((s) => !closingKeys.has(`close:${s.id}`)) : sessions), [sessions, closingKeys]);

  // A lost answer on a connection that is still up is settled by asking the record the way a reconnect does (events since this screen's cursor).
  useEffect(() => { registerPendingResume(refill); return () => registerPendingResume(null); }, [refill]);

  const closeNow = useCallback((id: string, name?: string) => closeSession({
    id, name,
    destroy: () => window.claude.session.destroy(id),
    list: () => window.claude.session.list(),
    leave: () => {
      // WHY: move off a conversation being closed to where the computer's own "closed" notice would go; undo puts the selection back unless the person chose another.
      if (live.current.sessionId !== id) return () => {};
      const moved = chooseAfterDestroyed({ destroyedId: id, currentId: id, remainingIds: live.current.sessions.filter((s) => s.id !== id).map((s) => s.id), focusSessionId: null });
      setSessionId(moved);
      return () => setSessionId((cur) => (cur === moved ? id : cur));
    },
    finish: () => removeSessionLocally(id),
  }), [removeSessionLocally, setSessionId]);

  /** Returns true when this is a phone and the change was taken over; false = App runs its direct path. */
  const cycleNativeNow = useCallback((sid: string, from: string, to: NativePermissionMode): boolean => setNativeModeNow({
    sessionId: sid, from, to, valid: validNativeModes,
    read: () => live.current.native.get(sid),
    write: (m) => setNativePermissionModes((prev) => (prev.get(sid) === m ? prev : new Map(prev).set(sid, m as NativePermissionMode))),
    set: () => window.claude.native.setPermissionMode(sid, to),
    readHost: () => (window as any).claude.native.getPermissionMode(sid), // (in preload and the shim, not in the renderer's Window type)
  }), [validNativeModes, setNativePermissionModes]);

  const cycleClaudeNow = useCallback((sid: string, from: string, to: PermissionMode): boolean => cycleClaudeModeNow({
    sessionId: sid, from, to,
    read: () => live.current.cc.get(sid),
    write: (m) => setPermissionModes((prev) => (prev.get(sid) === m ? prev : new Map(prev).set(sid, m as PermissionMode | 'unknown'))),
    sendKey: () => window.claude.session.sendInput(sid, '\x1b[Z'),
  }), [setPermissionModes]);

  return { stripSessions, modePending, closeNow, cycleNativeNow, cycleClaudeNow };
}
