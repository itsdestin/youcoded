import React, { useState, useCallback } from 'react';

interface TerminalToolbarProps {
  sessionId: string;
}

/**
 * Android-only toolbar providing special keys (Ctrl, Esc, Tab, arrows)
 * for terminal mode. Sends escape sequences directly to the PTY via sendInput.
 */
export default function TerminalToolbar({ sessionId }: TerminalToolbarProps) {
  const [ctrlActive, setCtrlActive] = useState(false);

  const send = useCallback((input: string) => {
    window.claude.session.sendInput(sessionId, input);
  }, [sessionId]);

  const handleCtrl = useCallback(() => {
    setCtrlActive(prev => !prev);
  }, []);

  return (
    <div className="flex items-center gap-1 px-2 py-1 bg-panel border-t border-edge-dim shrink-0 overflow-x-auto">
      <ToolbarButton
        label="Ctrl"
        active={ctrlActive}
        onClick={handleCtrl}
      />
      <ToolbarButton label="Esc" onClick={() => send('\x1b')} />
      <ToolbarButton label="Tab" onClick={() => send('\t')} />
      <div className="w-px h-5 bg-edge-dim mx-1" />
      <ToolbarButton label="←" onClick={() => send('\x1b[D')} />
      <ToolbarButton label="→" onClick={() => send('\x1b[C')} />
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
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title || label}
      className={`
        min-w-[36px] px-2 py-1 rounded text-xs font-medium
        transition-colors select-none
        ${active
          ? 'bg-accent text-on-accent'
          : 'bg-inset text-fg-muted hover:text-fg hover:bg-well'
        }
      `}
    >
      {label}
    </button>
  );
}
