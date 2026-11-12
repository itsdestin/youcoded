// usePermissionCycles.ts — the permission chip's cycle for a chat that may not be the one in front.
//
// WHY this file (2026-11-12): the page's chat is a real session shown beside a page while another chat is in front,
// and Destin asked that it "pick between permissions modes for that specific chat like i would in a real full
// session". The status bar's chip only ever meant "the chat in front", so its cycles now take a session id, and the
// values they need are read at press time from the refs below. The native cycle moved here whole from App.tsx
// (which is at its line budget); the Claude Code cycle stays there, where its shell-session guard is pinned.
import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { PermissionMode } from '../../shared/types';
import type { NativePermissionMode } from '../../shared/permission-types';

type ClaudeModes = Map<string, PermissionMode | 'unknown'>;
type NativeModes = Map<string, NativePermissionMode | 'unknown'>;

export interface PermissionLatest<M> {
  activeId: string | null;
  modes: ClaudeModes;
  nativeModes: NativeModes;
  models: Map<string, M>;
}

/** The newest values, for callbacks that must serve any session's id without being rebuilt per change. */
export function usePermissionLatest<M>(now: PermissionLatest<M>): MutableRefObject<PermissionLatest<M>> {
  const ref = useRef(now);
  ref.current = now;
  return ref;
}

/** A click passes its event as the first argument; only a string is a session id. */
export function cycleTarget(forId: unknown, latest: { current: { activeId: string | null } }): string | null {
  return typeof forId === 'string' ? forId : latest.current.activeId;
}

/** Native chip: ask → auto-edit → full-auto → ask through the host (NOT a PTY Shift+Tab — native sessions have no
 *  PTY). The host returns the APPLIED mode, which is authoritative: state updates from the return value, not the
 *  optimistic `next` (there is no screen-scrape correction path). */
export function useNativePermissionCycle<M>(deps: {
  latest: MutableRefObject<PermissionLatest<M>>;
  setNativePermissionModes: Dispatch<SetStateAction<NativeModes>>;
  /** First-time warning for Full auto: runs `proceed` at once when already acknowledged. */
  gateFullAuto: (proceed: () => void) => void;
  /** R6-2: a phone draws the new mode at once (hooks/usePhoneSessionActions.ts); true = handled there. */
  cycleNativeNow: (sessionId: string, from: NativePermissionMode | 'unknown', to: NativePermissionMode) => boolean;
}) {
  const { latest, setNativePermissionModes, gateFullAuto, cycleNativeNow } = deps;
  return useCallback(async (forId?: unknown) => {
    const sessionId = cycleTarget(forId, latest);
    if (!sessionId) return;
    const current: NativePermissionMode | 'unknown' = latest.current.nativeModes.get(sessionId) ?? 'ask';
    const cycle: NativePermissionMode[] = ['ask', 'auto-edit', 'full-auto'];
    // `current` may be 'unknown' — indexOf then returns -1, which wraps to index 0: cycling from unknown starts fresh.
    const next = cycle[(cycle.indexOf(current as NativePermissionMode) + 1) % cycle.length];
    const apply = async () => {
      if (cycleNativeNow(sessionId, current, next)) return;
      try {
        const applied = await window.claude.native.setPermissionMode(sessionId, next);
        // Validate before storing: the normal path returns a bare mode string, but the remote path turns a host
        // throw into a resolved {ok:false,...} object (remote-shim). Storing that would corrupt the chip's
        // PERMISSION_DISPLAY lookup — leave state unchanged on anything unexpected.
        if (cycle.includes(applied as NativePermissionMode)) {
          setNativePermissionModes((prev) => new Map(prev).set(sessionId, applied as NativePermissionMode));
        } else {
          console.error('Native permission mode not applied:', applied);
        }
      } catch (err) {
        // A rejected invoke means an unknown-mode wiring bug in the host — leave the chip on its current mode
        // rather than lying about state.
        console.error('Failed to set native permission mode:', err);
      }
    };
    // Cycling INTO Full auto is switching it on: the first time, the warning.
    if (next === 'full-auto') { gateFullAuto(() => { void apply(); }); return; }
    await apply();
  }, [latest, setNativePermissionModes, gateFullAuto, cycleNativeNow]);
}

/** The page chat's chip: that session's mode, and the same cycle the status bar's chip runs. Null where there is
 *  nothing to cycle (no such session, or a shell). */
export function usePageChatPermission(deps: {
  sessionsRef: { current: ReadonlyArray<{ id: string; provider?: string }> };
  cycleNative: (id: string) => unknown;
  cycleClaude: (id: string) => void;
  /** WHY the maps themselves, not a ref: a new function when a mode changes is what redraws the chip. */
  modes: ClaudeModes;
  nativeModes: NativeModes;
}) {
  const { sessionsRef, cycleNative, cycleClaude, modes, nativeModes } = deps;
  return useCallback((id: string) => {
    const s = sessionsRef.current.find((x) => x.id === id);
    if (!s || s.provider === 'shell') return null;
    return s.provider === 'native'
      ? { mode: nativeModes.get(id) ?? ('ask' as const), cycle: () => { void cycleNative(id); } }
      : { mode: modes.get(id) ?? ('unknown' as const), cycle: () => cycleClaude(id) };
  }, [sessionsRef, cycleNative, cycleClaude, modes, nativeModes]);
}
