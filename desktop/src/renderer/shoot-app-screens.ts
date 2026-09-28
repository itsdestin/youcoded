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
const FIRST_TIME_KINDS = ['skip-permissions', 'full-auto', 'small-model'] as const;

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
  // Opens the pre-resume model picker the same way a real resume of a native
  // session with no binding yet does (handleResumeSession's native branch).
  showNativeResumeModel: () => void;
  // Fakes the main process's onCloseRequest push (App.tsx's own real trigger
  // needs a whole-app quit to race, which a browser tab can't do).
  setQuitPrompt: Setter<{ requestId: string; sessions: number } | null>;
  // The three useFirstTimeGate() instances App.tsx owns. Each `gate` shows the
  // dialog only when its kind was never acknowledged before (localStorage) —
  // true by default in a fresh photo-only tab, so `() => {}` (never actually
  // run) is enough to force it open.
  gateSkip: (proceed: () => void) => void;
  gateSmallModel: (proceed: () => void) => void;
  gateFullAuto: (proceed: () => void) => void;
  // SkillEditor's own id prop — App.tsx holds the only state, with no live
  // trigger wired to it yet; a fixture id opens the real editor, a bogus one
  // opens its "not found" branch.
  setEditorSkillId: Setter<string | null>;
  // ThemeShareSheet's / ShareSheet's own slug/id props — same shape as above,
  // reusing marketplace/detail's and marketplace/theme-detail's fixture items.
  setPublishThemeSlug: Setter<string | null>;
  setShareSkillId: Setter<string | null>;
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
  // Same fixture pattern as chat/takeover just below: a fake session/project id
  // stands in for a real native resume with no model bound yet.
  useScreenOpen('chat/resume/pick-model', s.showNativeResumeModel);
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
  // The main process's "N sessions are still running" quit confirmation —
  // faked directly since a browser tab has no whole-app quit to race it with.
  useScreenOpen('chat/quit-sessions', () => s.setQuitPrompt({ requestId: 'shoot-quit', sessions: 2 }));
  // Each first-run warning, once per kind — `gate(() => {})` shows the dialog
  // (never runs `proceed`) as long as this kind was never acknowledged, true
  // by default in a fresh photo-only tab.
  useScreenOpen('chat/first-time-warning', (kind) => {
    if (kind === 'skip-permissions') s.gateSkip(() => {});
    else if (kind === 'full-auto') s.gateFullAuto(() => {});
    else if (kind === 'small-model') s.gateSmallModel(() => {});
  }, FIRST_TIME_KINDS);
  useScreenOpen('chat/skills/edit', () => s.setEditorSkillId('civic-report'));
  useScreenOpen('chat/skills/edit-missing', () => s.setEditorSkillId('shoot-skill-missing'));
  useScreenOpen('marketplace/theme-share', () => s.setPublishThemeSlug('meadow-mist'));
  useScreenOpen('marketplace/share', () => s.setShareSkillId('civic-report'));
}
