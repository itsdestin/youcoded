// The screens whose "open" switch lives in App.tsx, registered for `shoot` in one
// place (shoot-mode.tsx explains the mechanism; dev/workbench/screens lists them).
//
// WHY a separate file: App.tsx is the app's largest file and has a line budget.
// One call there hands over the setters it already owns; every name lives here.
// Like every useScreenOpen, each call is a no-op outside the photo-only build.
import type { Dispatch, SetStateAction } from 'react';
import { useScreenOpen } from './shoot-mode';

type Setter<T> = Dispatch<SetStateAction<T>>;

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
  gamePanelOpen: boolean;
  toggleGamePanel: () => void;
  openProjects: () => void;
  openPages: () => void;
};

export function useAppScreens(s: AppScreenSetters): void {
  const id = s.sessionId;
  useScreenOpen('settings', () => s.setSettingsOpen(true));
  // The chat itself: nothing to open, it is where the app starts.
  useScreenOpen('chat', () => s.setActiveView('chat'));
  // The welcome screen shows when there is no session (its entry uses the `empty` scenario).
  useScreenOpen('welcome', () => {});
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
  useScreenOpen('pages', s.openPages);
  useScreenOpen('marketplace', () => s.setActiveView('marketplace'));
  useScreenOpen('library', () => s.setActiveView('library'));
}
