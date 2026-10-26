import { useCallback, useEffect, useState } from 'react';
import { ThemeProvider } from '../../state/theme-context';
import { CameraIcon, SizeIcon, OpenIcon, HideIcon } from './BuddyActions';

/**
 * Action-bar floater window (transparent). Sits BESIDE the mascot, its row lined up with his hands. Four actions:
 * screenshot the desktop into the chat, a bigger or smaller chat, open the main app, hide the buddy for this run.
 *
 * Buddy rebuild (2026-10-25): Destin kept the buttons beside him (buddy-rebuild-review2#C-2, "i liked them as separate
 * buttons by the buddy. i just want to make them nicer/clearer/prettier"), so the size button joined them and their
 * look moved into buddy.css: one frosted pill (buddy-rebuild-review3#C-3) whose words appear when pointed at, in one
 * of three ways chosen on a deck (`data-style`, buddy.css says each).
 *
 * The window is larger than the row it draws so the hover grow has room — sizes and the layout live in
 * main/buddy-bar-geometry.ts. Visibility is CSS-driven via the buddy:bar-state push (the window stays shown so opacity
 * can animate); the bar appears with the chat, not on hover (main/buddy-bar-visibility.ts).
 */
export type BuddyBarStyle = 'pill-grow' | 'pill-open' | 'pill-caption';

function BarButton({ label, word, onClick, busy, children }: {
  label: string;
  word: string;
  onClick: () => void;
  busy?: boolean;
  children: React.ReactNode; // the icon
}) {
  return (
      // WHY `title`, not the app's Tooltip: this window is barely bigger than its buttons, so a drawn tooltip would be
      // cut off at its edge. The system's own tooltip can leave the window.
      <button
        onClick={onClick}
        aria-label={label}
        title={label}
        disabled={busy}
        className="buddy-bar-btn"
        // Busy is an ATTRIBUTE, not an inline style: the hover/press bounce lives in buddy.css, and an inline
        // `transition`/`transform` here would beat the stylesheet and kill it (2026-07-17).
        data-busy={busy ? '1' : '0'}
        // No focus ring flash on press: a frameless window with no keyboard path to these.
        onMouseDown={(e) => e.preventDefault()}
      >
        <span className="buddy-bar-icon">{children}</span>
        <span className="buddy-bar-word">{word}</span>
      </button>
  );
}

/** The four action buttons alone, no positioning (the workbench's group picture draws them too). */
export function BuddyBarButtons() {
  const [capturing, setCapturing] = useState(false);
  // Which way the size button goes: main tells the bar the chat's size (buddy:chat-size), so its words are right.
  const [large, setLarge] = useState(false);
  useEffect(() => (window.claude?.buddy as any)?.onChatSize?.((s: 'small' | 'large') => setLarge(s === 'large')), []);

  const onCapture = useCallback(async () => {
    if (capturing) return;
    setCapturing(true);
    try {
      await window.claude?.buddy?.captureDesktop?.();
    } finally {
      // Hold the pressed state ~150ms so the click is visibly acknowledged.
      setTimeout(() => setCapturing(false), 150);
    }
  }, [capturing]);

  return (
    <>
      <BarButton label="Screenshot your desktop into the chat" word="Screenshot desktop" onClick={onCapture} busy={capturing}><CameraIcon /></BarButton>
      <BarButton label={large ? 'Smaller chat window' : 'Bigger chat window'} word={large ? 'Smaller window' : 'Bigger window'} onClick={() => { void (window.claude?.buddy as any)?.toggleChatSize?.(); }}><SizeIcon /></BarButton>
      <BarButton label="Open YouCoded" word="Open YouCoded" onClick={() => { void window.claude?.buddy?.openMain?.(); }}><OpenIcon /></BarButton>
      <BarButton label="Hide the buddy until restart" word="Hide until restart" onClick={() => { void window.claude?.buddy?.dismiss?.(); }}><HideIcon /></BarButton>
    </>
  );
}

export function BuddyBarApp({ barStyle = 'pill-grow' }: { barStyle?: BuddyBarStyle } = {}) {
  // CSS-driven reveal: main pushes buddy:bar-state; the window itself stays Electron-shown so opacity can animate.
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    document.body.setAttribute('data-mode', 'buddy-bar');
  }, []);

  useEffect(() => {
    const off = window.claude?.buddy?.onBarState?.((s: { visible: boolean }) => setVisible(!!s.visible));
    return off;
  }, []);

  return (
    <ThemeProvider>
      <div className="buddy-bar-root" data-style={barStyle} data-visible={visible ? '1' : '0'}>
        <BuddyBarButtons />
      </div>
    </ThemeProvider>
  );
}
