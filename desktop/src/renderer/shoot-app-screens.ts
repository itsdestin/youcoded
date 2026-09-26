// The screens whose "open" switch lives in App.tsx, registered for `shoot` in one
// place (shoot-mode.tsx explains the mechanism; dev/workbench/screens lists them).
//
// WHY a separate file: App.tsx is the app's largest file and has a line budget.
// One call there hands over the setters it already owns; every name lives here.
// Like every useScreenOpen, each call is a no-op outside the photo-only build.
import type { Dispatch, SetStateAction } from 'react';
import { useScreenOpen } from './shoot-mode';

type Setter<T> = Dispatch<SetStateAction<T>>;

const TAKEOVER_PHASES = ['confirm', 'force', 'undeliverable', 'claim-denied'] as const;

export type AppScreenSetters = {
  sessionId: string | null;
  setSettingsOpen: Setter<boolean>;
  setActiveView: Setter<'chat' | 'terminal' | 'marketplace' | 'library'>;
  setClosePromptFor: Setter<string | null>;
  openDrawer: (searchMode: boolean) => void;
  setModelPickerOpen: Setter<boolean>;
  setPreferencesOpen: Setter<boolean>;
  setResumeRequested: Setter<boolean>;
  setOpenTasksPopupOpen: Setter<boolean>;
  toggleView: (mode: 'chat' | 'terminal') => void;
  openSessionFiles: (sessionId: string) => void;
  selectSession: (id: string) => void;
  gamePanelOpen: boolean;
  toggleGamePanel: () => void;
  openProjects: () => void;
  openPagesView: () => void;
  openPagesLibrary: () => void;
  createPage: () => void;
  openWelcomeForm: () => void;
  showTakeover: (phase: 'confirm' | 'force' | 'undeliverable' | 'claim-denied') => void;
};

export function useAppScreens(s: AppScreenSetters): void {
  const id = s.sessionId;
  useScreenOpen('settings', () => s.setSettingsOpen(true));
  // Not a screen: the driver selects an entry's practice session through this first.
  useScreenOpen('_select-session', (id) => { if (id) s.selectSession(id); });
  // The chat itself: nothing to open, it is where the app starts.
  useScreenOpen('chat', () => s.setActiveView('chat'));
  // The welcome screen shows when there is no session (its entry uses the `empty` scenario).
  useScreenOpen('welcome', () => {});
  useScreenOpen('welcome/new-session', s.openWelcomeForm);
  // The drawer in its "/" state: the slash-command search, as typing / opens it.
  useScreenOpen('chat/commands', () => s.openDrawer(true));
  // Straight to the prompt: the "don't ask again" setting would otherwise close the session.
  useScreenOpen('chat/close-session', () => { if (id) s.setClosePromptFor(id); });
  useScreenOpen('chat/skills', () => s.openDrawer(false));
  useScreenOpen('chat/model-picker', () => s.setModelPickerOpen(true));
  useScreenOpen('chat/preferences', () => s.setPreferencesOpen(true));
  useScreenOpen('chat/resume', () => s.setResumeRequested(true));
  useScreenOpen('chat/open-tasks', () => s.setOpenTasksPopupOpen(true));
  useScreenOpen('chat/terminal', () => s.toggleView('terminal'));
  useScreenOpen('chat/files', () => { if (id) s.openSessionFiles(id); });
  // The panel is a toggle: only press it when it is closed.
  useScreenOpen('chat/games', () => { if (!s.gamePanelOpen) s.toggleGamePanel(); });
  useScreenOpen('projects', s.openProjects);
  useScreenOpen('pages', s.openPagesView);
  useScreenOpen('pages/library', s.openPagesLibrary);
  useScreenOpen('pages/create', s.createPage);
  // "Open here instead?" when another computer holds a conversation, in each of its phases
  // (a fixture device name; no real handoff is waiting behind it).
  useScreenOpen('chat/takeover', (phase) => { if (phase) s.showTakeover(phase as 'confirm'); }, TAKEOVER_PHASES);
  useScreenOpen('marketplace', () => s.setActiveView('marketplace'));
  useScreenOpen('library', () => s.setActiveView('library'));
}
