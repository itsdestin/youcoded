import { useEffect, useRef } from 'react';
import { parseInkSelect, menuToButtons } from '../parser/ink-select-parser';
import { useChatDispatch, useChatStateMap } from '../state/chat-context';
import { getScreenText, onBufferReady } from './terminal-registry';

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
]);

// After a permission response (PERMISSION_RESPONDED/EXPIRED clears
// awaiting-approval), suppress parser detection for this window. Prevents
// Race 3: PTY redraws the Ink menu briefly while Claude processes the
// response, parser re-detects it as "new" since the guard is cleared.
const POST_PERMISSION_COOLDOWN_MS = 800;

// How long a menu must be absent before we clear lastMenuRef. Prevents
// brief PTY screen flicker (clear → redraw) from resetting the parser's
// duplicate detection, which would cause re-detection of the same menu.
const DISMISS_DEBOUNCE_MS = 600;

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
export function usePromptDetector() {
  const dispatch = useChatDispatch();
  const chatState = useChatStateMap();
  const chatStateRef = useRef(chatState);
  chatStateRef.current = chatState;
  const lastMenuRef = useRef<Map<string, string>>(new Map());
  const pendingTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const dismissTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Track when awaiting-approval was last cleared per session, so the parser
  // can suppress re-detection during the post-permission cooldown window.
  const lastPermissionClearedRef = useRef<Map<string, number>>(new Map());
  const prevAwaitingRef = useRef<Map<string, boolean>>(new Map());

  // Perf: detect awaiting-approval transitions in an effect (off the render
  // path) and iterate activeTurnToolIds (current-turn only, per chat-reducer
  // rule #2) rather than the session-lifetime toolCalls Map. With many
  // concurrent sessions accumulating hundreds of tool entries over time, the
  // old render-body loop was O(sessions × toolCalls) on every dispatch.
  useEffect(() => {
    for (const [sid, session] of chatState) {
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
  }, [chatState]);

  useEffect(() => {
    const unsub = onBufferReady((sid: string) => {
      // Skip prompt detection when a PermissionRequest approval is active
      // (the hook-based UI is handling the permission flow)
      const sessionState = chatStateRef.current.get(sid);
      if (sessionState) {
        for (const [, tool] of sessionState.toolCalls) {
          if (tool.status === 'awaiting-approval') return;
        }
      }

      // Skip prompt detection during post-permission cooldown — the Ink menu
      // may still be on screen while Claude processes the approval response.
      const lastCleared = lastPermissionClearedRef.current.get(sid);
      if (lastCleared && Date.now() - lastCleared < POST_PERMISSION_COOLDOWN_MS) {
        return;
      }

      const screen = getScreenText(sid);
      if (!screen) return;

      const menu = parseInkSelect(screen);
      const lastMenuId = lastMenuRef.current.get(sid) || null;

      if (menu) {
        // Cancel any pending dismiss — menu is (still) present
        const existingDismiss = dismissTimerRef.current.get(sid);
        if (existingDismiss) {
          clearTimeout(existingDismiss);
          dismissTimerRef.current.delete(sid);
        }

        if (menu.id !== lastMenuId) {
          lastMenuRef.current.set(sid, menu.id);

          // Only show PromptCards for known setup prompts. Permission prompts
          // and false positives (numbered lists) are skipped — hooks handle
          // permissions, and numbered lists aren't real menus.
          if (!SETUP_PROMPT_TITLES.has(menu.title)) return;

          // Cancel any previous pending prompt for this session
          const existingTimer = pendingTimerRef.current.get(sid);
          if (existingTimer) clearTimeout(existingTimer);

          // Debounce: wait before showing, giving hook system time to arrive
          const timer = setTimeout(() => {
            pendingTimerRef.current.delete(sid);

            // Re-check: if a PermissionRequest arrived during the debounce,
            // a tool will be in awaiting-approval — don't show the prompt
            const currentSession = chatStateRef.current.get(sid);
            if (currentSession) {
              for (const [, tool] of currentSession.toolCalls) {
                if (tool.status === 'awaiting-approval') return;
              }
            }

            // Re-check cooldown (permission may have been responded during debounce)
            const cleared = lastPermissionClearedRef.current.get(sid);
            if (cleared && Date.now() - cleared < POST_PERMISSION_COOLDOWN_MS) {
              return;
            }

            const buttons = menuToButtons(menu);
            dispatch({
              type: 'SHOW_PROMPT',
              sessionId: sid,
              promptId: menu.id,
              title: menu.title,
              description: menu.description,
              buttons: buttons.map((b) => ({ label: b.label, input: b.input })),
            });
          }, PROMPT_DEBOUNCE_MS);

          pendingTimerRef.current.set(sid, timer);
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
            dispatch({
              type: 'DISMISS_PROMPT',
              sessionId: sid,
              promptId: lastMenuId,
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
    };
  }, [dispatch]);
}
