import { useEffect, useRef } from 'react';
import { parseInkSelect, menuToButtons, readStartupDialog, type ParsedMenu } from '../parser/ink-select-parser';
import { setUnreadableStartupDialog } from '../state/startup-dialog-store';
import { useChatDispatch, useChatStore } from '../state/chat-context';
import { getVisibleScreenText, onBufferReady } from './terminal-registry';
import { parsePlanMenu } from '../parser/plan-menu-parser';
import { expiredToolIds, nextAbsentCount } from '../state/expired-card-resolver';

// How long to wait before showing a parser-detected prompt, giving the hook
// system time to deliver a PermissionRequest via the named pipe relay.
// Hook events typically arrive 100-200ms after the Ink menu renders.
const PROMPT_DEBOUNCE_MS = 350;

// Only show parser-detected PromptCards for these known setup prompts.
// Permission prompts (Yes/No/Always Allow) are handled exclusively by the
// hook system via ToolCard. Showing them here too causes duplication.
// This also prevents false positives from numbered lists in Claude's output
// that the Ink parser misidentifies as menus.
const SETUP_PROMPT_TITLES = new Set([
  'Trust This Folder?',
  'Choose a Theme',
  'Select Login Method',
  'Skip Permissions Warning',
  'Resume Session', // Stale session resume — lets user choose summary vs full resume
  'Usage Limit Reached', // /rate-limit-options menu — Upgrade / Stop and wait
  'Enable auto mode?', // CC v2.1.83+ first-run opt-in: 4-option auto-mode confirmation
  'Message Flagged', // Fable 5 model-safeguard fallback — Switch model / Edit prompt and retry
  // Startup dialog when CLAUDE.md imports files outside the cwd. Previously it
  // was mislabeled 'Trust This Folder?' by the stale trust anchor and hijacked
  // TrustGate's full-screen takeover; now it gets its own card (2026-07-26).
  'Allow External Imports?',
  // Project MCP-server approval (a folder with .mcp.json), CC 2.1.281.
  'New MCP Server Found',
]);

/**
 * The card title for a menu the detector will show, or null to skip it.
 *
 * A known setup prompt keeps its canonical title. While the session is still
 * STARTING (no hook event yet — Claude Code runs none until every startup
 * dialog is answered), any menu that is plainly a live Claude Code dialog (its
 * "Enter to confirm · Esc to cancel" footer under the options) is shown too,
 * titled with the dialog's own heading: a dialog nobody has taught the app
 * about must never again leave a new session on "Initializing session…"
 * (2026-09-24). Outside startup the known-titles gate stays strict — there,
 * permission menus belong to the hook cards and numbered lists in replies are
 * not menus.
 */
function cardTitleFor(menu: ParsedMenu, starting: boolean): string | null {
  if (SETUP_PROMPT_TITLES.has(menu.title)) return menu.title;
  if (starting && menu.dialog) {
    const heading = (menu.heading ?? '').replace(/:\s*$/, '').trim();
    return heading || menu.title;
  }
  return null;
}

export interface PromptDetectorOptions {
  /** True while this session has not started yet (App's init gate). */
  isStarting?: (sessionId: string) => boolean;
}

// After a permission response (PERMISSION_RESPONDED/EXPIRED clears
// awaiting-approval), suppress parser detection for this window. Prevents
// Race 3: PTY redraws the Ink menu briefly while Claude processes the
// response, parser re-detects it as "new" since the guard is cleared.
const POST_PERMISSION_COOLDOWN_MS = 800;

// How long a menu must be absent before we clear lastMenuRef. Prevents
// brief PTY screen flicker (clear → redraw) from resetting the parser's
// duplicate detection, which would cause re-detection of the same menu.
const DISMISS_DEBOUNCE_MS = 600;

// How long an ANSWERED card's identical dialog must stay on screen before it is
// treated as a new question and given a fresh card (review F5). Longer than a
// digit answer's menu takes to leave, so a normal answer never re-shows.
const REISSUE_MS = 1000;

/**
 * Monitors xterm.js write completions (via terminal-registry) to detect
 * Ink select menus in the screen buffer.
 *
 * To avoid showing duplicate prompts (parser PromptCard + hook-based ToolCard),
 * new menu detections are debounced. If the hook system delivers a
 * PERMISSION_REQUEST during the debounce window, the pending prompt is
 * cancelled — the ToolCard handles it instead.  If the debounce expires
 * without a hook event (e.g., trust folder prompt, or hooks are down),
 * the PromptCard is shown as a fallback.
 */
export function usePromptDetector(options: PromptDetectorOptions = {}) {
  const dispatch = useChatDispatch();
  const store = useChatStore();
  // Latest options without re-subscribing the buffer listener on every render.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const lastMenuRef = useRef<Map<string, string>>(new Map());
  const pendingTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const dismissTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // The menu id whose SHOW_PROMPT actually fired, per session. Gates the
  // on-id-change dismissal below: false-positive "menus" (numbered lists in
  // streaming output) churn through ids up to ~60/s, and dispatching a no-op
  // DISMISS_PROMPT for each would run the reducer per buffer flush.
  const shownPromptRef = useRef<Map<string, string>>(new Map());
  // The promptId of that shown card — the menu id, or `<id>~n` for a fresh card
  // re-issued when an identical dialog followed an answered one (review F5).
  const shownPromptIdRef = useRef<Map<string, string>>(new Map());
  const reissueTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Track when awaiting-approval was last cleared per session, so the parser
  // can suppress re-detection during the post-permission cooldown window.
  const lastPermissionClearedRef = useRef<Map<string, number>>(new Map());
  const prevAwaitingRef = useRef<Map<string, boolean>>(new Map());

  // Per session: consecutive buffer flushes with no Claude Code menu on screen
  // while a KEPT card (expired) is waiting. At two, the card settles quietly.
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
    // Show a card for `menu` after the debounce, re-checking everything first.
    const scheduleShow = (sid: string, menu: ParsedMenu, title: string, promptId: string = menu.id) => {
      // Debounce: wait before showing, giving hook system time to arrive
      const timer = setTimeout(() => {
        pendingTimerRef.current.delete(sid);

        // Re-check: if a PermissionRequest arrived during the debounce,
        // a tool will be in awaiting-approval — don't show the prompt
        const currentSession = store.getState().get(sid);
        if (currentSession) {
          for (const [, tool] of currentSession.toolCalls) {
            // Same kept-card exemption as the top-of-flush bail.
            if (tool.status === 'awaiting-approval' && !tool.expired) return;
          }
        }

        // Re-check cooldown (permission may have been responded during debounce)
        const cleared = lastPermissionClearedRef.current.get(sid);
        if (cleared && Date.now() - cleared < POST_PERMISSION_COOLDOWN_MS) {
          return;
        }

        // Re-check the menu is STILL on screen. `menu` was captured when the
        // timer was scheduled; the PTY may have advanced past it during the
        // debounce. Showing a card for a menu that's already gone strands a
        // completed:false prompt entry whose ONLY clearer is a LATER buffer
        // flush (the disappear branch below) — and an idle terminal produces
        // none, so hasPendingInteraction() would then block every send with
        // nothing live on screen. Re-parse now; bail if the menu left.
        // (fix 2026-07-17 — the "SHOW fired for a vanished menu" race.)
        const nowScreen = getVisibleScreenText(sid);
        const nowMenu = nowScreen ? parseInkSelect(nowScreen) : null;
        if (!nowMenu || nowMenu.id !== menu.id) return;

        const buttons = menuToButtons(menu);
        const verified = buttons.some((b) => b.pick);
        shownPromptRef.current.set(sid, menu.id);
        shownPromptIdRef.current.set(sid, promptId);
        dispatch({
          type: 'SHOW_PROMPT',
          sessionId: sid,
          promptId,
          title,
          description: menu.description,
          buttons: buttons.map((b) => ({
            label: b.label,
            input: b.input,
            ...(b.submitInput !== undefined ? { submitInput: b.submitInput } : {}),
            ...(b.pick ? { pick: b.pick } : {}),
          })),
          // An unnumbered dialog is answered by moving Claude Code's own
          // cursor, so the card starts where that cursor is ("No, exit").
          ...(verified ? { defaultIndex: nowMenu.selectedIndex } : {}),
        });
      }, PROMPT_DEBOUNCE_MS);
      pendingTimerRef.current.set(sid, timer);
    };

    // Review F5: a completed card whose identical dialog is still on screen
    // REISSUE_MS later gets a fresh card (new promptId, so the answered one
    // stays in the timeline as the record of the first answer). Guarded hard
    // (second review F5/F8):
    //  • only a card that was ANSWERED — an unanswered one is still the live
    //    card for that dialog;
    //  • only a card answered by verified navigation (`pick`): its driver
    //    confirmed Claude Code redrew after the Enter. A digit answer completes
    //    before anything is known, and a slow-to-leave menu would otherwise earn
    //    a "~1" card for a question already answered;
    //  • at most once per dialog, with a deterministic id (`<menu id>~1`) — the
    //    same on every device, since each runs this detector and completions
    //    are broadcast by promptId;
    //  • re-checked when the timer fires: the same menu on screen, and the card
    //    STILL answered (it may have been re-shown meanwhile).
    const reissueIdFor = (menuId: string) => `${menuId}~1`;
    const answeredCard = (sid: string, promptId: string) => {
      const e = store.getState().get(sid)?.timeline.find((x) => x.kind === 'prompt' && x.prompt.promptId === promptId);
      return e && e.kind === 'prompt' && e.prompt.completed ? e.prompt : null;
    };
    const checkReissue = (sid: string, menu: ParsedMenu, title: string) => {
      if (reissueTimerRef.current.has(sid)) return;
      const promptId = shownPromptIdRef.current.get(sid) ?? menu.id;
      if (promptId === reissueIdFor(menu.id)) return; // already re-issued once
      const answered = answeredCard(sid, promptId);
      if (!answered) return;
      if (!answered.buttons.some((b) => b.pick)) return;
      reissueTimerRef.current.set(sid, setTimeout(() => {
        reissueTimerRef.current.delete(sid);
        const nowScreen = getVisibleScreenText(sid);
        const nowMenu = nowScreen ? parseInkSelect(nowScreen) : null;
        if (!nowMenu || nowMenu.id !== menu.id) return;
        if (!answeredCard(sid, promptId)) return;
        scheduleShow(sid, nowMenu, title, reissueIdFor(menu.id));
      }, REISSUE_MS));
    };

    const unsub = onBufferReady((sid: string) => {
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
              dispatch(action);
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

      const menu = parseInkSelect(screen);
      const lastMenuId = lastMenuRef.current.get(sid) || null;
      const starting = optionsRef.current.isStarting?.(sid) ?? false;

      // Safety net: while the session is starting, a Claude Code dialog the
      // parser cannot turn into buttons (a multi-select, a layout nobody has
      // seen) is reported at once, so the Initializing screen can say "Claude
      // Code is asking something — answer it in terminal view" instead of
      // hanging silently. Cleared as soon as it is gone or readable.
      const readable = !!menu && cardTitleFor(menu, starting) !== null;
      setUnreadableStartupDialog(sid, starting && !readable ? readStartupDialog(screen) : null);

      if (menu) {
        // Cancel any pending dismiss — menu is (still) present
        const existingDismiss = dismissTimerRef.current.get(sid);
        if (existingDismiss) {
          clearTimeout(existingDismiss);
          dismissTimerRef.current.delete(sid);
        }

        if (menu.id !== lastMenuId) {
          // A DIFFERENT menu replaced the previous one. Retire the old prompt
          // BEFORE the recognized-title gate below can bail out: cancel its
          // pending show timer and dismiss any already-shown prompt. Without
          // this, a recognized prompt followed by an unrecognized menu
          // orphaned the old timeline entry at completed:false forever —
          // hasPendingInteraction() then blocked all chat sends with a stale
          // "answer the prompt first" toast (seen on crash-resumed sessions,
          // 2026-07-16). The dispatch is gated on shownPromptRef so id churn
          // from false-positive menus (streaming numbered lists) doesn't run
          // the reducer on every buffer flush.
          const existingTimer = pendingTimerRef.current.get(sid);
          if (existingTimer) {
            clearTimeout(existingTimer);
            pendingTimerRef.current.delete(sid);
          }
          if (lastMenuId && shownPromptRef.current.get(sid) === lastMenuId) {
            shownPromptRef.current.delete(sid);
            dispatch({ type: 'DISMISS_PROMPT', sessionId: sid, promptId: shownPromptIdRef.current.get(sid) ?? lastMenuId });
          }
          clearTimeout(reissueTimerRef.current.get(sid));
          reissueTimerRef.current.delete(sid);
          lastMenuRef.current.set(sid, menu.id);

          // Only show PromptCards for known setup prompts. Permission prompts
          // and false positives (numbered lists) are skipped — hooks handle
          // permissions, and numbered lists aren't real menus.
          const title = cardTitleFor(menu, starting);
          if (title === null) return;
          scheduleShow(sid, menu, title);
        } else {
          // SAME menu still (or again) on screen. Review F2 (2026-09-24): an
          // unreadable frame inside the debounce cancelled the show timer, the
          // menu came back under the same id, and nothing ever re-scheduled it —
          // no card, and no safety net either (the menu reads fine). So: a
          // readable menu with no card showing and none scheduled gets one now.
          const title = cardTitleFor(menu, starting);
          if (title !== null && shownPromptRef.current.get(sid) !== menu.id && !pendingTimerRef.current.has(sid)) {
            scheduleShow(sid, menu, title);
          }
          // Review F5: its card was ANSWERED and an identical dialog is (still)
          // there — Claude Code asked the same question again. Give it a fresh
          // card rather than leaving the answered one in its place.
          if (title !== null && shownPromptRef.current.get(sid) === menu.id) checkReissue(sid, menu, title);
        }
      } else if (lastMenuId) {
        // Menu disappeared — debounce the dismissal to avoid clearing
        // lastMenuRef during brief PTY screen redraws (clear → redraw).
        if (!dismissTimerRef.current.has(sid)) {
          // Cancel any pending show timer immediately
          const existingTimer = pendingTimerRef.current.get(sid);
          if (existingTimer) {
            clearTimeout(existingTimer);
            pendingTimerRef.current.delete(sid);
          }

          const timer = setTimeout(() => {
            dismissTimerRef.current.delete(sid);
            // Menu has been gone long enough — truly dismiss
            const shownId = shownPromptIdRef.current.get(sid) ?? lastMenuId;
            if (shownPromptRef.current.get(sid) === lastMenuId) {
              shownPromptRef.current.delete(sid);
            }
            dispatch({
              type: 'DISMISS_PROMPT',
              sessionId: sid,
              promptId: shownId,
            });
            lastMenuRef.current.delete(sid);
          }, DISMISS_DEBOUNCE_MS);

          dismissTimerRef.current.set(sid, timer);
        }
      }
    });

    return () => {
      unsub();
      // Clean up any pending timers
      for (const timer of pendingTimerRef.current.values()) {
        clearTimeout(timer);
      }
      pendingTimerRef.current.clear();
      for (const timer of dismissTimerRef.current.values()) {
        clearTimeout(timer);
      }
      dismissTimerRef.current.clear();
      for (const timer of reissueTimerRef.current.values()) clearTimeout(timer);
      reissueTimerRef.current.clear();
    };
  }, [dispatch]);
}
