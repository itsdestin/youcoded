import React, { useState, useCallback } from 'react';
import { isAndroid } from '../platform';

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
      <ScrollButton label="↑" onClick={() => send('\x1b[A')} />
      <ScrollButton label="↓" onClick={() => send('\x1b[B')} />
    </div>
  );
}

function ScrollButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-10 h-10 rounded-md text-base font-medium bg-inset text-fg-muted hover:text-fg hover:bg-well transition-colors select-none flex items-center justify-center border border-edge-dim"
    >
      {label}
    </button>
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
      className={`shrink-0 ${heightClass} min-w-[2.25rem] px-2.5 rounded-md border text-[11px] transition-colors select-none ${
        active
          ? 'bg-accent text-on-accent border-accent'
          : 'bg-panel border-edge-dim text-fg-2 hover:bg-inset hover:text-fg'
      }`}
    >
      {label}
    </button>
  );
}
