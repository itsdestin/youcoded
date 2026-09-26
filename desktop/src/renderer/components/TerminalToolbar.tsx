import { useState, useCallback } from 'react';
import { isAndroid } from '../platform';
import { Button } from './ui';

interface TerminalToolbarProps {
  sessionId: string;
}

/**
 * Android/remote-only toolbar providing special keys (Ctrl, Esc, Tab, arrows)
 * for terminal mode. Sends escape sequences directly to the PTY via sendInput.
 *
 * Styled to match QuickChips so terminal-view and chat-view share the same
 * "row of pill buttons above the input bar" visual. Consumer (InputBar) is
 * responsible for slotting this into the same container position QuickChips
 * occupies in chat view.
 */
export default function TerminalToolbar({ sessionId }: TerminalToolbarProps) {
  const [ctrlActive, setCtrlActive] = useState(false);

  const send = useCallback((input: string) => {
    window.claude.session.sendInput(sessionId, input);
  }, [sessionId]);

  const handleCtrl = useCallback(() => {
    setCtrlActive(prev => !prev);
  }, []);

  // Match QuickChips: h-6 desktop-remote / h-8 Android for comfier touch targets
  const buttonHeight = isAndroid() ? 'h-8' : 'h-6';
  const separatorHeight = isAndroid() ? 'h-6' : 'h-4';

  return (
    <div className="flex gap-1 px-3 py-1 overflow-x-auto scrollbar-none items-center">
      <ToolbarButton
        label="Ctrl"
        active={ctrlActive}
        onClick={handleCtrl}
        heightClass={buttonHeight}
      />
      <ToolbarButton label="Esc" onClick={() => send('\x1b')} heightClass={buttonHeight} />
      <ToolbarButton label="Tab" onClick={() => send('\t')} heightClass={buttonHeight} />
      {/* Enter and Space as their own keys (second review F2): answering a
          menu in terminal view on a phone — above all a startup dialog the chat
          cannot show — needs Enter to confirm and Space to tick a box in a
          multi-select (the several-MCP-servers list). */}
      <ToolbarButton label="Enter" onClick={() => send('\r')} heightClass={buttonHeight} />
      <ToolbarButton label="Space" onClick={() => send(' ')} heightClass={buttonHeight} />
      <div className={`shrink-0 w-px ${separatorHeight} bg-edge-dim mx-0.5`} />
      <ToolbarButton label="←" onClick={() => send('\x1b[D')} heightClass={buttonHeight} />
      <ToolbarButton label="→" onClick={() => send('\x1b[C')} heightClass={buttonHeight} />
    </div>
  );
}

/**
 * Floating up/down arrow buttons — rendered separately above the bottom bar
 * so they overlay the terminal view without taking up space in the flex layout.
 */
export function TerminalScrollButtons({ sessionId }: TerminalToolbarProps) {
  const send = useCallback((input: string) => {
    window.claude.session.sendInput(sessionId, input);
  }, [sessionId]);

  return (
    <div className="absolute bottom-2 right-2 flex flex-col gap-1.5 z-10 pointer-events-auto">
      <ScrollButton label="↑" name="Scroll up" onClick={() => send('\x1b[A')} />
      <ScrollButton label="↓" name="Scroll down" onClick={() => send('\x1b[B')} />
    </div>
  );
}

function ScrollButton({ label, name, onClick }: { label: string; name: string; onClick: () => void }) {
  return (
    // Change 41. The 40x40 geometry is KEPT rather than taking size="icon"'s 28px:
    // this floats over a terminal and is a primary touch control on Android, so
    // shrinking it by 30% to match a popup ✕ would be a regression dressed as
    // consistency. What the primitive is here for is the focus ring and the
    // accessible name — the label is a bare "↑"/"↓" glyph, which a screen reader
    // announces as "up arrow" with no hint that it scrolls anything.
    <Button
      variant="secondary"
      onClick={onClick}
      aria-label={name}
      className="w-10 h-10 p-0 rounded-md text-base bg-inset select-none"
    >
      <span aria-hidden>{label}</span>
    </Button>
  );
}

function ToolbarButton({
  label,
  onClick,
  active = false,
  title,
  heightClass,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  title?: string;
  heightClass: string;
}) {
  // Shape/typography mirrors QuickChips so the two rows are indistinguishable
  // when swapped. Active state (Ctrl toggle) keeps the accent highlight so
  // the sticky-modifier affordance stays visible.
  return (
    <button
      type="button"
      onClick={onClick}
      title={title || label}
      className={`shrink-0 ${heightClass} min-w-[2.25rem] px-2.5 rounded-md border text-2xs transition-colors select-none ${
        active
          ? 'bg-accent text-on-accent border-accent'
          : 'bg-panel border-edge-dim text-fg-2 hover:bg-inset hover:text-fg'
      }`}
    >
      {label}
    </button>
  );
}
