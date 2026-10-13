import { useEffect, useRef } from 'react';
import { parseInkSelect, readStartupDialog } from '../../shared/ink-select-parser';
import { setUnreadableStartupDialog } from '../state/startup-dialog-store';
import { useChatDispatch, useChatStore } from '../state/chat-context';
import { getVisibleScreenText, onBufferReady } from './terminal-registry';
import { parsePlanMenu } from '../parser/plan-menu-parser';
import { expiredToolIds, nextAbsentCount } from '../state/expired-card-resolver';
import { getCapabilities } from '../platform';
import { readInputFocus, inputIsBlocked } from '../../shared/cc-input-focus';
import type { SessionChatState } from '../state/chat-types';
import { PromptCardReader } from '../../shared/prompt-card-reader';
import { cardTitleFor, POST_PERMISSION_COOLDOWN_MS } from '../../shared/prompt-card-rules';

/** Is ANY permission card up for this session — live, or kept after its ask expired? A generic card never shows beside one: the menu on screen is that
 *  card's (hook permission menus carry the same footer). Live asks are current-turn only (toolCalls keeps stale awaiting entries from ended turns, which
 *  must not silence generic cards forever); kept cards deliberately outlive their turn, so they are read from the whole map. */
function hasPermissionCard(session: SessionChatState | undefined): boolean {
  if (!session) return false;
  for (const id of session.activeTurnToolIds) {
    if (session.toolCalls.get(id)?.status === 'awaiting-approval') return true;
  }
  return expiredToolIds(session).length > 0;
}

export interface PromptDetectorOptions {
  /** True while this session has not started yet (App's init gate). */
  isStarting?: (sessionId: string) => boolean;
}

/**
 * Monitors xterm.js write completions (via terminal-registry) for this screen's own reading of a Claude Code terminal.
 *
 * WHERE A CARD IS DRAWN FROM (one-core R5-4b): wherever `capabilities.sessionRecord` is true (the computer's windows and every phone) the COMPUTER's
 * main process reads each terminal itself (main/session-screens.ts) and publishes a card for a question Claude Code asks (usage limit, trust folder,
 * resume ...) once, as a numbered event every screen draws; this screen no longer reads cards, so none can come from a closed or hidden window and
 * a phone can no longer put one in front of the person at the computer. The reading logic is shared (shared/prompt-card-reader.ts), and only a host
 * with no record of its own (the Android app's own runtime, until the Android rebuild) still runs it here and draws what it finds directly.
 *
 * What stays per-screen on every host, because it is about THIS screen's terminal and chat state rather than a card for everyone:
 *  - a permission card Claude Code closed its hook on ("kept") is settled when its menu has left this screen's terminal;
 *  - while the session is starting, a dialog nobody has taught the app to read is reported to the Initializing screen.
 */
export function usePromptDetector(options: PromptDetectorOptions = {}) {
  const chatDispatch = useChatDispatch();
  const store = useChatStore();
  // Latest options without re-subscribing the buffer listener on every render.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // One reader per session, only on a host with no record (see above).
  const readersRef = useRef<Map<string, PromptCardReader>>(new Map());
  // Last "a pop-up holds the keyboard" reading sent to the host per session, only on a host with no record (see the buffer listener below).
  const reportedBlockedRef = useRef<Map<string, boolean>>(new Map());

  // Track when awaiting-approval was last cleared per session, so the reader can suppress re-detection during the post-permission cooldown window.
  const lastPermissionClearedRef = useRef<Map<string, number>>(new Map());
  const prevAwaitingRef = useRef<Map<string, boolean>>(new Map());

  // Per session: consecutive buffer flushes with no Claude Code menu on screen while a KEPT card (expired) is waiting. At two, the card settles quietly.
  const expiredAbsentRef = useRef<Map<string, number>>(new Map());

  // Perf: detect awaiting-approval transitions in an effect (off the render
  // path) and iterate activeTurnToolIds (current-turn only, per chat-reducer
  // rule #2) rather than the session-lifetime toolCalls Map. With many
  // concurrent sessions accumulating hundreds of tool entries over time, the
  // old render-body loop was O(sessions × toolCalls) on every dispatch.
  // Perf (tranche 1): direct store subscription instead of a [chatState]
  // effect — this hook no longer re-renders its host (AppInner) on every
  // dispatch. Body is unchanged from the previous effect.
  useEffect(() => {
    const check = () => {
      for (const [sid, session] of store.getState()) {
        let hasAwaiting = false;
        for (const toolId of session.activeTurnToolIds) {
          const tool = session.toolCalls.get(toolId);
          if (tool && tool.status === 'awaiting-approval') { hasAwaiting = true; break; }
        }
        const wasAwaiting = prevAwaitingRef.current.get(sid) ?? false;
        // A hook ask arrived AFTER a generic card went up for the same menu (its event trailed the 1 s wait): the reader withdraws the card on its next
        // look, so look now. (Only a host with no record has readers here; elsewhere the computer's reader sees the same ask in the record.)
        if (!wasAwaiting && hasAwaiting) readersRef.current.get(sid)?.scan();
        if (wasAwaiting && !hasAwaiting) {
          lastPermissionClearedRef.current.set(sid, Date.now());
        }
        prevAwaitingRef.current.set(sid, hasAwaiting);
      }
    };
    check();
    return store.subscribeAll(check);
  }, [store]);

  useEffect(() => {
    const readerFor = (sid: string): PromptCardReader => {
      let r = readersRef.current.get(sid);
      if (!r) {
        r = new PromptCardReader({
          readScreen: () => getVisibleScreenText(sid),
          need: () => {
            const started = !(optionsRef.current.isStarting?.(sid) ?? false);
            const session = store.getState().get(sid);
            // A LIVE ask owns the menu (its permission card); a kept one (expired) does not. No chat state yet means nothing is asking.
            const permissionCard = hasPermissionCard(session);
            if (session) for (const [, tool] of session.toolCalls) if (tool.status === 'awaiting-approval' && !tool.expired) return { asking: true, started, permissionCard };
            return { asking: false, started, permissionCard };
          },
          askClearedAt: () => lastPermissionClearedRef.current.get(sid) ?? 0,
          isAnswered: (promptId) => {
            const e = store.getState().get(sid)?.timeline.find((x) => x.kind === 'prompt' && x.prompt.promptId === promptId);
            return !!e && e.kind === 'prompt' && !!e.prompt.completed;
          },
          show: (card) => chatDispatch({
            type: 'SHOW_PROMPT', sessionId: sid, promptId: card.promptId, title: card.title, description: card.description,
            buttons: card.buttons as never, ...(card.defaultIndex !== undefined ? { defaultIndex: card.defaultIndex } : {}),
          }),
          dismiss: (promptId) => chatDispatch({ type: 'DISMISS_PROMPT', sessionId: sid, promptId }),
          now: Date.now,
          setTimer: (fn, ms) => setTimeout(fn, ms),
          clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        });
        readersRef.current.set(sid, r);
      }
      return r;
    };

    const unsub = onBufferReady((sid: string) => {
      // A host with no record of its own (the Android app's own runtime) tells ITS host whether a pop-up holds this session's keyboard (on change only):
      // its automated writes (/reload-plugins) have no screen of their own to read. Wherever a record exists the computer reads the terminal itself and
      // tells everyone (main/session-screens.ts), so nothing reports from here: one reader, not two that can disagree. Before the live-ask bail below,
      // so the reading never goes stale.
      if (!getCapabilities().sessionRecord) {
        const blocked = inputIsBlocked(readInputFocus(getVisibleScreenText(sid)));
        if (reportedBlockedRef.current.get(sid) !== blocked) {
          reportedBlockedRef.current.set(sid, blocked);
          window.claude?.session?.reportInputBlocked?.(sid, blocked);
        }
      }

      // Skip prompt detection when a PermissionRequest approval is active
      // (the hook-based UI is handling the permission flow)
      const sessionState = store.getState().get(sid);
      if (sessionState) {
        // The menu-gone rule for KEPT cards runs BEFORE the bail below, and that
        // bail ignores kept cards — otherwise keeping a card would switch this
        // whole detector off for the session (the rule itself, and every setup
        // prompt card: trust, usage limit, resume), since a kept card can stay
        // awaiting-approval indefinitely (spec §2b).
        const expired = expiredToolIds(sessionState);
        if (expired.length > 0) {
          const screen = getVisibleScreenText(sid);
          // Either shape counts as "Claude Code is still asking": the generic
          // numbered menu, or the plan menu (whose text-box row the generic
          // parser does not model).
          const menuPresent = !!screen && (!!parseInkSelect(screen) || parsePlanMenu(screen).status !== 'absent');
          const { count, resolve } = nextAbsentCount(menuPresent, expiredAbsentRef.current.get(sid) ?? 0);
          expiredAbsentRef.current.set(sid, count);
          if (resolve) {
            expiredAbsentRef.current.delete(sid);
            for (const toolUseId of expired) {
              const action = { type: 'PERMISSION_CARD_RESOLVED' as const, sessionId: sid, toolUseId };
              chatDispatch(action);
              (window as any).claude?.remote?.broadcastAction?.(action);
            }
          }
        } else {
          // Nothing kept here — a future expiry starts its count from zero.
          expiredAbsentRef.current.delete(sid);
        }
        for (const [, tool] of sessionState.toolCalls) {
          // A LIVE ask silences the parser below (its card owns the menu). A
          // kept one must not: its socket is gone, and the rule above needs this
          // function to keep running on every flush.
          if (tool.status === 'awaiting-approval' && !tool.expired) return;
        }
      }

      // Skip prompt detection during post-permission cooldown — the Ink menu
      // may still be on screen while Claude processes the approval response.
      const lastCleared = lastPermissionClearedRef.current.get(sid);
      if (lastCleared && Date.now() - lastCleared < POST_PERMISSION_COOLDOWN_MS) {
        return;
      }

      // Visible screen only — Ink menus render at the bottom; serializing the
      // full scrollback here (per buffer flush, up to ~60/s while streaming)
      // was the top renderer CPU cost. See terminal-registry.getScreenText.
      const screen = getVisibleScreenText(sid);
      if (!screen) return;

      // Safety net: while the session is starting, a Claude Code dialog the
      // parser cannot turn into buttons (a multi-select, a layout nobody has
      // seen) is reported at once, so the Initializing screen can say "Claude
      // Code is asking something — answer it in terminal view" instead of
      // hanging silently. Cleared as soon as it is gone or readable.
      const starting = optionsRef.current.isStarting?.(sid) ?? false;
      let readable = true;
      if (starting) {
        const menu = parseInkSelect(screen);
        readable = !!menu && cardTitleFor(menu, true, screen) !== null;
      }
      setUnreadableStartupDialog(sid, starting && !readable ? readStartupDialog(screen) : null);

      // A host with no record of its own draws its cards from this screen's terminal (see the header).
      if (!getCapabilities().sessionRecord) readerFor(sid).scan();
    });

    return () => {
      unsub();
      for (const r of readersRef.current.values()) r.dispose();
      readersRef.current.clear();
    };
  }, [chatDispatch, store]);
}
