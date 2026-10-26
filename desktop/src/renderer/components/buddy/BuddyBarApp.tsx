import { useCallback, useEffect, useState } from 'react';
import { ThemeProvider } from '../../state/theme-context';
import { CameraIcon, SizeIcon, OpenIcon, HideIcon } from './BuddyActions';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';

/**
 * Action-bar floater window (transparent). Sits BESIDE the mascot, its row lined up with his hands. Four actions:
 * screenshot the desktop into the chat, a bigger or smaller chat, open the main app, hide the buddy for this run.
 *
 * Buddy rebuild (2026-10-25): Destin kept the buttons beside him (buddy-rebuild-review2#C-2, "i liked them as separate
 * buttons by the buddy. i just want to make them nicer/clearer/prettier"), so the size button joined them and their
 * look is now drawn by the app's own shared pieces (buddy-rebuild-review4#C-4) in one of three arrangements chosen on a
 * deck (`BuddyBarStyle`): separate raised buttons, icon buttons in the app's popup panel, or the same panel with words.
 *
 * The window is larger than the row it draws so the hover grow has room — sizes and the layout live in
 * main/buddy-bar-geometry.ts. Visibility is CSS-driven via the buddy:bar-state push (the window stays shown so opacity
 * can animate); the bar appears with the chat, not on hover (main/buddy-bar-visibility.ts).
 */
export type BuddyBarStyle = 'raised' | 'panel' | 'panel-words';

/** One action. `style` picks which of the app's own pieces draws it (buddy-rebuild-review4#C-4: "it should match other
 *  youcoded design standards/elements"): the shared Button — 'raised', the variant made for a control sitting on a
 *  picture, here the desktop; or 'ghost' inside the app's popup surface — and the shared Tooltip for its explanation. */
function BarButton({ barStyle, label, word, onClick, busy, children }: {
  barStyle: BuddyBarStyle;
  label: string;
  word: string;
  onClick: () => void;
  busy?: boolean;
  children: React.ReactNode; // the icon
}) {
  if (barStyle === 'panel-words') {
    return (
      <Button variant="ghost" size="sm" onClick={onClick} disabled={busy} className="buddy-bar-btn gap-1.5" data-busy={busy ? '1' : '0'}>
        {children}{word}
      </Button>
    );
  }
  return (
    <Tooltip text={label} placement="top">
      <Button
        variant={barStyle === 'raised' ? 'raised' : 'ghost'}
        size="icon"
        aria-label={label}
        onClick={onClick}
        disabled={busy}
        className="buddy-bar-btn"
        // Busy is an ATTRIBUTE: the press bounce lives in buddy.css (2026-07-17).
        data-busy={busy ? '1' : '0'}
      >
        {children}
      </Button>
    </Tooltip>
  );
}

/** The four action buttons alone, no positioning (the workbench's group picture draws them too). */
export function BuddyBarButtons({ barStyle = 'raised' }: { barStyle?: BuddyBarStyle }) {
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

  const buttons = (
    <>
      <BarButton barStyle={barStyle} label="Screenshot your desktop into the chat" word="Screenshot" onClick={onCapture} busy={capturing}><CameraIcon /></BarButton>
      <BarButton barStyle={barStyle} label={large ? 'Smaller chat window' : 'Bigger chat window'} word={large ? 'Smaller' : 'Bigger'} onClick={() => { void (window.claude?.buddy as any)?.toggleChatSize?.(); }}><SizeIcon /></BarButton>
      <BarButton barStyle={barStyle} label="Open YouCoded" word="Open" onClick={() => { void window.claude?.buddy?.openMain?.(); }}><OpenIcon /></BarButton>
      <BarButton barStyle={barStyle} label="Hide the buddy until restart" word="Hide" onClick={() => { void window.claude?.buddy?.dismiss?.(); }}><HideIcon /></BarButton>
    </>
  );
  // 'panel' styles sit in the app's popup surface (.layer-surface: the theme's panel colour, edge, shadow and corner).
  return barStyle === 'raised'
    ? <div className="flex items-center gap-1.5">{buttons}</div>
    : <div className="layer-surface flex items-center gap-0.5 p-1">{buttons}</div>;
}

export function BuddyBarApp({ barStyle = 'raised' }: { barStyle?: BuddyBarStyle } = {}) {
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
        <BuddyBarButtons barStyle={barStyle} />
      </div>
    </ThemeProvider>
  );
}
