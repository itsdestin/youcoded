// src/renderer/components/guide/guide-stops.ts
//
// The tour as DATA: eight stops, each naming what the buddy says, which screen
// the app opens while it says it, which control gets ringed, and what "Do it
// now" does. Reordering or dropping a stop is an edit here, never in the tour.
// The list is Destin's (2026-09-10 deck, S-1 holds); the sentences are the
// builder's and go to him on the review deck.
//
// Order (UX tester run 1, U6): the stops walk FORWARD through the app — the
// form, then the Projects screen twice in a row, then Settings twice in a row,
// then Help — instead of zig-zagging back to screens already visited.

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
  /** Said instead of `text` when none of the stop's anchors is on screen —
   *  a stop about something the person has not made yet (UX tester, U4). */
  textWhenMissing?: string;
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
    // No ring: the buddy beside this bubble IS the one talking (U29 — a ring
    // around the big welcome mascot made it look like two different buddies).
    text: 'Hi, I’m your buddy. I’ll show you around the app. Skip any time, and find me again under Settings, Help & feedback.',
    screen: 'welcome',
    pose: 'welcome',
  },
  {
    id: 'sessions',
    text: 'A session is one conversation with the assistant, working in one folder. Pick the folder and the model here and press Create; each session gets its own tab along the top.',
    screen: 'welcome-form',
    anchor: 'new-session-form',
    pose: 'inquisitive',
  },
  {
    id: 'tags',
    text: 'This button holds a session’s tags and a note to your future self. Both show under All Sessions, so a conversation from last month is easy to find again.',
    textWhenMissing: 'Once you have a session, the tag button in its side panel holds tags and a note to your future self. Both show under All Sessions, so old conversations are easy to find.',
    screen: 'drawer',
    anchor: 'tags-notes',
    pose: 'inquisitive',
  },
  {
    id: 'projects',
    text: 'Any folder you keep coming back to can be a project. The assistant keeps its instructions, memories and conversations together, so you never start from zero there.',
    screen: 'projects',
    anchor: ['add-project', 'project-hero'],
    pose: 'inquisitive',
  },
  {
    id: 'files',
    text: 'Files the assistant makes show up here, and beside each conversation. Open, edit or send any of them.',
    screen: 'projects',
    anchor: ['files-tab', 'projects-empty'],
    pose: 'inquisitive',
  },
  {
    id: 'models',
    text: 'The account you signed in with is what answers you, and it is already set up. If you ever want a different AI service, or one that runs free on your own computer, you add it here.',
    screen: 'settings:cloud',
    anchor: 'providers',
    pose: 'inquisitive',
  },
  {
    id: 'themes',
    text: 'Make it yours: pick a theme here. Browse Theme Marketplace, just below, has more themes and plugins made by other people.',
    screen: 'settings:appearance',
    anchor: 'theme-grid',
    pose: 'inquisitive',
  },
  {
    id: 'help',
    text: 'Help, bug reports, the community and this tour all live here. That’s the tour — enjoy.',
    screen: 'settings:help',
    anchor: 'help-popup',
    pose: 'welcome',
  },
];
