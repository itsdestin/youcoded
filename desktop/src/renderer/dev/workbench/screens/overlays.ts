// App overlays, toasts and chat cards that only appear after a failure, takeover or slash command, so no
// practice session reaches them (dev/workbench/OverlaysPractice.tsx draws each real component over practice
// data). Added for the "what changed since the last release" comparison. Photo-only build only.
import type { ScreenEntry } from './types';

const piece = (which: string, extra: Partial<ScreenEntry> = {}): ScreenEntry =>
  ({ name: `dev/overlay#${which}`, tags: ['dev', 'overlay'], params: { overlay: which }, ...extra });

export const OVERLAYS: readonly ScreenEntry[] = [
  { name: 'dev/overlay', tags: ['dev', 'overlay'] },
  ...['trust', 'initializing', 'handoff-waiting', 'handoff-incomplete', 'remote-unsupported', 'compacting', 'copy-picker',
    'usage', 'usage-chatgpt', 'thinking-stalled', 'thinking-prefill', 'model-loading', 'model-reload',
    'specialist-report', 'specialist-failed'].map((w) => piece(w)),
  // Voice input that heard nothing (new since v1.3.3: the amber "No sound detected" strip and the three-reason card). waitMs lets
  // the card's popover settle into place beside the mic.
  ...['voice-silent', 'voice-no-sound', 'voice-too-quiet', 'voice-no-words'].map((w) => piece(w, { newIn: 'after', waitMs: 600 })),
];
