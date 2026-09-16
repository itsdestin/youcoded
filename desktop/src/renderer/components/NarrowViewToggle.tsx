// Narrow-viewport chat/terminal toggle.
//
// One button showing the icon of the view you'd switch TO — terminal glyph
// while you're in chat, chat glyph while you're in the terminal. The wide
// layout's segmented pill needs room for both icons, the active label, and the
// sliding accent pill; below 640px that space is better spent on the session
// strip.
//
// Sized to match ArtifactDrawerButton exactly (same bg-inset wrapper, same
// px-2 py-1 inner, same w-4 h-4 glyph) so the two read as a matched pair.
//
// Extracted from HeaderBar purely so the "shows the TARGET view, not the
// current one" invariant is testable — HeaderBar itself needs SessionStrip,
// ArtifactContext and platform mocks to render at all.

import { ChatIcon, TerminalIcon } from './Icons';
import { Tooltip } from './ui';

export type ViewMode = 'chat' | 'terminal';

interface Props {
  viewMode: ViewMode;
  onToggleView: (v: ViewMode) => void;
}

export default function NarrowViewToggle({ viewMode, onToggleView }: Props) {
  const nextView: ViewMode = viewMode === 'chat' ? 'terminal' : 'chat';
  const label = nextView === 'terminal' ? 'Switch to terminal' : 'Switch to chat';

  return (
    // data-view-toggle: what ViewToggleHint's coach mark points at. Both
    // toggle variants carry it so the hint follows the breakpoint switch.
    <div data-view-toggle className="bg-inset rounded-md p-0.5 shrink-0">
      <Tooltip text={label} placement="bottom">
      <button
        onClick={() => onToggleView(nextView)}
        className="coarse-hit px-2 py-1 rounded-[var(--radius-toggle)] transition-colors flex items-center text-fg-dim hover:text-fg-2"
        aria-label={label}
      >
        {nextView === 'terminal'
          ? <TerminalIcon className="w-4 h-4" />
          : <ChatIcon className="w-4 h-4" />}
      </button>
      </Tooltip>
    </div>
  );
}
