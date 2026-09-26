import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import ArcadeShell from './ArcadeShell';
import { GameConnection } from '../../state/game-types';
import { useTheme } from '../../state/theme-context';
import { clampDrawerWidth, applyGameWidthVar } from '../../state/drawer-width';
import { ScreenMark } from '../../shoot-mode';

interface Props {
  connection: GameConnection;
  /** Chess's own PartyKit client (spec §3.1). Same interface, its own room —
   *  passed straight through to the shell, which picks by the open game's id. */
  chessConnection: GameConnection;
  incognito?: boolean;
  onToggleIncognito?: () => void;
}

// Host for the games pane. Everything that used to live here — the "Connect 4"
// title, the close button, and the lobby-vs-board branch — moved into
// <ArcadeShell>, which routes between the picker and whichever game is open
// (spec §4). This file is now just the pane's outer shell: the surface, and
// the resize handle that goes with it (§4.3).
export default function GamePanel({ connection, chessConnection, incognito, onToggleIncognito }: Props) {
  const { gamePaneWidth, setGamePaneWidth, resetGamePaneWidth } = useTheme();
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  const dragRaf = useRef(0);
  const [dragging, setDragging] = useState(false);

  // Drag-to-resize (spec §4.3), deliberately identical in feel to the artifact
  // drawer's handle (SessionDrawer.tsx) — same 6px hit area, same cursor, same
  // double-click-to-reset — so the two right-hand panes don't drag differently.
  // The pane sits on the RIGHT, so dragging its LEFT edge left grows it:
  // width = startWidth + (startX - clientX).
  // The live preview writes the <html> --game-pane-width var once per frame,
  // NOT React state: a re-render per mousemove would re-render the whole game
  // board mid-drag. Pointer-up commits through setGamePaneWidth (clamp +
  // localStorage), which is also what records "the user has resized this pane".
  const onHandlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragState.current = { startX: e.clientX, startWidth: gamePaneWidth };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onHandlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = dragState.current;
    if (!s) return;
    const next = clampDrawerWidth(s.startWidth + (s.startX - e.clientX), window.innerWidth);
    cancelAnimationFrame(dragRaf.current);
    dragRaf.current = requestAnimationFrame(() => applyGameWidthVar(next));
  };
  const onHandlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = dragState.current;
    if (!s) return;
    dragState.current = null;
    setDragging(false);
    cancelAnimationFrame(dragRaf.current);
    setGamePaneWidth(s.startWidth + (s.startX - e.clientX)); // setter clamps + persists
  };

  return (
    // Fills the framed-shell's drawer-pane slot (see ChatView). The pane's own
    // chrome — width, rounded corners, top/bottom chrome-height margins, and the
    // chrome-glass frame around it — comes from .drawer-pane in globals.css, so
    // this root only sets the interior surface (bg-inset, matching the artifact
    // drawer's aside) and fills its container. It no longer carries the old
    // w-80 / border-l / bg-panel slide-out styling.
    // relative: positioning context for the resize handle below.
    <div className="relative h-full flex flex-col overflow-hidden bg-inset">
      <ScreenMark name="chat/games" />
      {/* w-1.5 is a 6px hit area hugging the pane's left edge; the visible
          affordance is the hover/drag accent tint. Theme tokens only — no new
          backdrop-filter (react-renderer rule). */}
      <div
        className={`absolute left-0 inset-y-0 w-1.5 cursor-col-resize z-10 transition-colors ${dragging ? 'bg-accent/50' : 'hover:bg-accent/30'}`}
        title="Drag to resize · double-click to reset"
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerUp}
        onDoubleClick={resetGamePaneWidth}
      />
      <ArcadeShell connection={connection} chessConnection={chessConnection} incognito={incognito} onToggleIncognito={onToggleIncognito} />
    </div>
  );
}
