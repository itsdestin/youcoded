// The buddy's own windows (dev/workbench/BuddyPractice.tsx frames the workbench's buddy pages at the window's real size).
// Added for the v1.3.3 -> now comparison: the buddy chat was rebuilt to draw the main chat, and nothing showed it.
// No newIn: the buddy chat window existed in v1.3.3 (older design: pill + bubble feed), so the before side has a version to compare.
import type { ScreenEntry } from './types';

const buddy = (which: string, w: number, h: number, extra: Partial<ScreenEntry> = {}): ScreenEntry =>
  ({ name: `dev/buddy#${which}`, tags: ['dev', 'buddy', 'narrow'], viewport: { width: w, height: h }, params: { buddy: which }, mark: 'dev/buddy', ...extra });

export const BUDDY: readonly ScreenEntry[] = [
  { name: 'dev/buddy', tags: ['dev', 'buddy', 'narrow'], viewport: { width: 320, height: 480 } },
  buddy('chat', 320, 480, { sameAs: { name: 'dev/buddy', why: 'the plain name opens the same default chat window' } }),
  buddy('chat-large', 440, 660),
  buddy('chat-question', 320, 480),
  buddy('chat-question-large', 440, 660),
  buddy('chat-approval', 320, 480),
  buddy('welcome', 320, 480),
  buddy('group', 900, 680),
  buddy('moods', 640, 160),
];
