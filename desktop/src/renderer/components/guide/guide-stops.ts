// src/renderer/components/guide/guide-stops.ts
//
// The tour as DATA: eight stops, each naming what the buddy says, which screen
// the app opens while it says it, which control gets ringed, and what "Do it
// now" does. Reordering or dropping a stop is an edit here, never in the tour.
// The list is Destin's (2026-09-10 deck, S-1 holds); the sentences are the
// builder's and go to him on the review deck.

/** A screen the app opens for a stop. App.tsx maps these onto its own
 *  open/close state; the tour never touches that state directly. */
export type GuideScreen =
  | 'welcome'              // the between-sessions screen, form closed
  | 'welcome-form'         // the same, with the New Session form open
  | 'projects'             // the Projects screen
  | 'settings:cloud'       // Settings → Assistant settings → Cloud providers
  | 'settings:appearance'  // Settings → Appearance
  | 'settings:help'        // Settings → Help & feedback
  | 'drawer';              // the open session's drawer, if there is one

export type GuideAction =
  | { kind: 'click-anchor'; anchor: string; label: string }
  | { kind: 'marketplace'; label: string };

export interface GuideStop {
  id: string;
  /** One or two sentences. Plain words; a college student knows every one. */
  text: string;
  screen: GuideScreen;
  /** The element carrying `data-guide-anchor="<this>"` gets the ring. A list
   *  is tried in order — the Projects stop rings "Add a project" on a fresh
   *  install and the project card once one exists. */
  anchor?: string | string[];
  action?: GuideAction;
  /** The buddy waves on the first stop and looks curious on the rest. */
  pose: 'welcome' | 'inquisitive';
}

export const GUIDE_STOPS: readonly GuideStop[] = [
  {
    id: 'buddy',
    text: 'Hi, I’m your buddy. I’ll show you around in about a minute. You can skip any time, and find me again under Settings.',
    screen: 'welcome',
    anchor: 'welcome-mascot',
    pose: 'welcome',
  },
  {
    id: 'sessions',
    text: 'A session is one conversation with the assistant, working in one folder. Pick the folder and the model here; the strip along the top switches between sessions once you have a few.',
    screen: 'welcome-form',
    anchor: 'new-session-form',
    pose: 'inquisitive',
  },
  {
    id: 'projects',
    text: 'A project is a folder you keep coming back to. Its context files and conversations stay with it, and this screen shows what the assistant made there.',
    screen: 'projects',
    anchor: ['add-project', 'project-hero'],
    action: { kind: 'click-anchor', anchor: 'add-project', label: 'Add a project' },
    pose: 'inquisitive',
  },
  {
    id: 'models',
    text: 'This is where you choose which service answers you: the plan you signed in with, another provider, or a model running on your own computer.',
    screen: 'settings:cloud',
    anchor: 'providers',
    pose: 'inquisitive',
  },
  {
    id: 'tags',
    text: 'Every session can carry tags and a note to your future self. Both show up in Resume, so a conversation from last month is easy to find again.',
    screen: 'drawer',
    anchor: 'tags-notes',
    pose: 'inquisitive',
  },
  {
    id: 'files',
    text: 'Files the assistant makes or changes show up here, and in the file pane beside a conversation. You can open, edit or send any of them.',
    screen: 'projects',
    anchor: ['files-tab', 'projects-empty'],
    pose: 'inquisitive',
  },
  {
    id: 'themes',
    text: 'Make it yours: pick a theme here, and browse the Marketplace for more themes and plugins made by other people.',
    screen: 'settings:appearance',
    anchor: 'theme-grid',
    action: { kind: 'marketplace', label: 'Open the Marketplace' },
    pose: 'inquisitive',
  },
  {
    id: 'help',
    text: 'When you need a hand: the community, a bug report, known issues and this tour again all live here. That’s the tour — enjoy.',
    screen: 'settings:help',
    anchor: 'help-popup',
    pose: 'welcome',
  },
];
