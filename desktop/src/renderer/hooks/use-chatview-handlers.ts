// The three callbacks App hands every <ChatView>, as STABLE references.
//
// WHY this file exists (2026-09-18): they were inline arrows on the element, so
// every ChatView got "new" props on every App render and none could ever skip
// one — and App renders on every session switch. Each open conversation then
// re-walked its whole timeline inside the click, before the first frame of the
// switch could paint. Destin: "the switch still lags a second behind me clicking
// a different session name. and clicking a bunch back-and-forth seems to freeze
// up a smidge". ChatView is memoised now; an inline arrow at the call site
// undoes it for every open tab at once.
//
// Here rather than in App.tsx because App.tsx is held at its line budget.
// Guards: ast-grep `app-chatview-props-are-stable` (no inline function on
// <ChatView> in App.tsx); tests/chatview-skips-uninvolved-sessions.test.tsx.
import { useMemo } from 'react';
import { CHATGPT_UPGRADE_URL } from '../../shared/chatgpt-types';

interface Setters {
  setProvidersAutoOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setModelPickerOpen: (open: boolean) => void;
}

export interface ChatViewHandlers {
  /** Provider-config error bubble → open Settings straight to the Model
   *  Providers section so the key can be fixed. */
  openProviderSettings: () => void;
  /** Plan-limit card (review round 2, P-9): Switch Providers opens the same
   *  picker the status-bar chip opens. */
  switchProviders: () => void;
  /** Plan-limit card: the Upgrade plan button opens OpenAI's own upgrade page
   *  (the URL the Codex CLI's limit error names) in the system browser, like
   *  My Account does. */
  upgradePlan: () => void;
}

export function useChatViewHandlers({ setProvidersAutoOpen, setSettingsOpen, setModelPickerOpen }: Setters): ChatViewHandlers {
  // React state setters are stable, so this object is built once per App mount.
  return useMemo(() => ({
    openProviderSettings: () => { setProvidersAutoOpen(true); setSettingsOpen(true); },
    switchProviders: () => setModelPickerOpen(true),
    upgradePlan: () => { void window.claude.shell.openExternal(CHATGPT_UPGRADE_URL); },
  }), [setProvidersAutoOpen, setSettingsOpen, setModelPickerOpen]);
}
