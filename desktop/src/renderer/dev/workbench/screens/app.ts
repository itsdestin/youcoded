// App-wide dialogs that belong to no one area: a quit (or the last window's close) refused for
// unsaved text edits (Task 6 fix rounds 9–11; components/UnsavedBeforeQuit.tsx).
import type { ScreenEntry } from './types';

const app = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['app', ...tags] });

export const APP: readonly ScreenEntry[] = [
  // An open editor, a parked draft that can be opened, one whose file is gone.
  app('app/unsaved-before-quit', 'dialog'),
  // A short window: the list scrolls and the buttons stay put (close-session-4, the footer slot).
  { ...app('app/unsaved-before-quit#short', 'dialog'), viewport: { width: 1440, height: 480 } },
  // Refused after teardown, when it was a restart: the chats have stopped; it will quit instead.
  app('app/unsaved-before-quit/after-restart', 'dialog'),
  // "Discard and quit" asks in place first.
  app('app/unsaved-before-quit/discard', 'dialog'),
  // No "all saved" state (final-review#CH-21): once nothing is unsaved the quit just goes on.
  // Not a screen of the app: every shared hand-drawn icon at 48px (dev/workbench/IconSheet.tsx),
  // so a malformed drawing is visible at a glance. Photo-only build only.
  { name: 'dev/icons', tags: ['dev'], viewport: { width: 1440, height: 1300 } },
  // Not a screen either: every status tag on a popup and in a card, at fixed positions, so its
  // tint can be measured per theme (dev/workbench/PillSheet.tsx). The stronger-tint variant
  // (dev/pills#strong) is gone: not adopted (final-review#TL-0).
  { name: 'dev/pills', tags: ['dev'] },
  // Open tasks with tasks in it — the real popup over practice tasks (dev/workbench/
  // OpenTasksPractice.tsx), since no practice conversation creates tasks. Both folded sections
  // start open (five or fewer in each), as in the app (submit-ticket-5#ST5-Q2).
  { name: 'dev/open-tasks', tags: ['dev'], mark: 'chat/open-tasks' },
  // The same popup over a native session's TodoWrite list (Open tasks rework, 2026-10-13: the
  // path that showed nothing before).
  { name: 'dev/open-tasks#native', tags: ['dev'], mark: 'chat/open-tasks', params: { tasks: 'native' } },
  // The phone's start-up screens (dev/workbench/GatePractice.tsx) and its two new notices (ToastPractice.tsx): the real gate / toast over
  // pretend connections, at phone size. Phone-reliability review deck, 2026-10-22.
  ...(['connecting', 'unreachable', 'tab', 'login'] as const).map((g) => ({
    // WHY no newIn (2026-11-07): newIn means "new since the last release" — these four gate screens were in
    // v1.3.3's GatePractice, so a release comparison must not call them new
    name: `dev/gate#${g}`, tags: ['dev', 'narrow'], viewport: { width: 390, height: 844 }, params: { gate: g },
  })),
  // The browser page's password screen after the computer said no (GatePractice.tsx): too many wrong passwords, a refusal for another
  // reason, a sign-in timed out after 90 days unused (new words), and the Android app refusing a computer that is not on Tailscale
  // (a notice over the phone's own app, so it waits for the notice to appear).
  ...(['login-too-many', 'login-refused'] as const).map((g) => ({
    name: `dev/gate#${g}`, tags: ['dev', 'narrow', 'error-state'], viewport: { width: 390, height: 844 }, params: { gate: g },
    open: [{ do: 'type', target: { role: 'textbox', label: 'Password' }, text: 'practice-password' }, 'Connect'],
    ...(g === 'login-too-many' ? { newIn: 'after' as const } : {}),
  })),
  { name: 'dev/gate#login-expired', tags: ['dev', 'narrow'], viewport: { width: 390, height: 844 }, params: { gate: 'login-expired' }, newIn: 'after' as const },
  { name: 'dev/gate#tailscale', tags: ['dev', 'narrow', 'error-state'], viewport: { width: 390, height: 844 }, session: 'wb-1', params: { gate: 'tailscale' }, waitMs: 3000, newIn: 'after' as const },
  ...(['lost', 'password'] as const).map((t) => ({
    // WHY only "lost" is new: the password toast was already in v1.3.3's ToastPractice
    name: `dev/toast#${t}`, tags: ['dev', 'narrow'], viewport: { width: 390, height: 844 }, session: 'wb-1', params: { toast: t }, ...(t === 'lost' ? { newIn: 'after' as const } : {}),
  })),
  // The workbench tool-card gallery, one section per picture (dev/workbench/ToolsPractice.tsx): every tool
  // card from its recorded fixtures — common calls, agents, failures and approvals, admin password,
  // chatsearch, delivered files, skills, grouped cards. Tall window so a section needs no scrolling.
  ...['Individual tool cards', 'Agents & specialists', 'Failures & status variants', 'Admin password', 'Chatsearch cards', 'Deliverable cards', 'Skill cards', 'Grouped tool cards'].map((t, i) => ({
    name: i === 0 ? 'dev/tools' : `dev/tools#${t.toLowerCase().replace(/[^a-z]+/g, '-').replace(/-$/, '')}`,
    tags: ['dev'], viewport: { width: 1440, height: i === 0 ? 1500 : 1100 }, params: { section: String(i) },
  })),
  // Plugin off-switch heads-up: the app's own toast with its "Show" button, at desktop and phone width.
  { name: 'dev/toast#turned-off', tags: ['dev'], session: 'wb-1', params: { toast: 'turned-off' }, newIn: 'after' as const },
  // Card #216: the "signed out of your YouCoded account" heads-up with its "Sign in again" button.
  // The same screen with nothing shown: what the app looked like before the notice existed (the deck's Before picture).
  { name: 'dev/toast#none', tags: ['dev'], session: 'wb-1', params: { toast: 'none' }, newIn: 'after' as const, sameAs: { name: 'chat#queue-idle-after', why: 'The same chat with no notice raised (the Before picture for the signed-out notice).' } },
  { name: 'dev/toast#signed-out', tags: ['dev'], session: 'wb-1', params: { toast: 'signed-out' }, newIn: 'after' as const },
  { name: 'dev/toast#turned-off-phone', tags: ['dev', 'narrow'], viewport: { width: 390, height: 844 }, session: 'wb-1', params: { toast: 'turned-off' }, newIn: 'after' as const },
];
