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
];
