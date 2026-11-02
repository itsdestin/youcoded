import { useCallback, useEffect, useState } from 'react';
import { ThemeProvider } from '../../state/theme-context';
import { ScreenshotIcon, SizeIcon, OpenIcon, HideIcon } from './BuddyActions';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';

/**
 * Action-bar floater window (transparent). Sits BESIDE the mascot, its row's bottom level with his feet (in the taskbar
 * style, directly under the chat instead). Four actions:
 * screenshot the desktop into the chat, a bigger or smaller chat, open the main app, hide the buddy for this run.
 *
 * Buddy rebuild (2026-10-25): Destin kept the buttons beside him (buddy-rebuild-review2#C-2), the size button joined
 * them, and they are drawn ONLY with the app's own shared pieces (buddy-rebuild-review4#C-4, "it should match other
 * youcoded design standards"): four ghost icon Buttons inside the popup surface the app's menus and popovers use
 * (`.layer-surface`), each explained by the shared Tooltip above it (below it in the taskbar style) — Destin's pick,
 * review5#C-5 "panel".
 *
 * The window is larger than the row it draws: room for the tooltip above and the press bounce around — sizes and the
 * layout live in shared/buddy-geometry.ts (BAR_*). Visibility is CSS-driven via the buddy:bar-state push (the window
 * stays shown so opacity can animate); the bar appears with the chat, not on hover (main/buddy-bar-visibility.ts).
 */
function BarButton({ label, onClick, busy, hint, children }: {
  label: string;
  hint: 'top' | 'bottom';
  onClick: () => void;
  busy?: boolean;
  children: React.ReactNode; // the icon
}) {
  return (
    <Tooltip text={label} placement={hint}>
      <Button
        variant="ghost"
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

/**
 * The four action buttons in their panel, no positioning (the workbench's group picture draws them too). `hint`: which
 * side the hover hints open on — below when the bar hangs under the chat (taskbar style), where above is the chat.
 */
export function BuddyBarButtons({ hint = 'top' }: { hint?: 'top' | 'bottom' } = {}) {
  const [capturing, setCapturing] = useState(false);
  // Which way the size button goes: main tells the bar the chat's size (buddy:chat-size), so its words are right.
  const [large, setLarge] = useState(false);
  useEffect(() => window.claude?.buddy?.onChatSize?.((s) => setLarge(s === 'large')), []);

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

  // Short hint words on purpose: the hint has to fit inside this small window (BAR_SIZE), which it cannot leave.
  return (
    <div className="layer-surface flex items-center gap-0.5 p-1">
      <BarButton hint={hint} label="Screenshot desktop" onClick={onCapture} busy={capturing}><ScreenshotIcon /></BarButton>
      <BarButton hint={hint} label={large ? 'Smaller chat' : 'Bigger chat'} onClick={() => { void window.claude?.buddy?.toggleChatSize?.(); }}><SizeIcon /></BarButton>
      <BarButton hint={hint} label="Open YouCoded" onClick={() => { void window.claude?.buddy?.openMain?.(); }}><OpenIcon /></BarButton>
      <BarButton hint={hint} label="Hide buddy" onClick={() => { void window.claude?.buddy?.dismiss?.(); }}><HideIcon /></BarButton>
    </div>
  );
}

export function BuddyBarApp() {
  // CSS-driven reveal: main pushes buddy:bar-state; the window itself stays Electron-shown so opacity can animate.
  const [visible, setVisible] = useState(true);
  // Taskbar style: the bar hangs under the chat, so its row sits at the top of the window and the hints open below.
  const [under, setUnder] = useState(false);

  useEffect(() => {
    document.body.setAttribute('data-mode', 'buddy-bar');
  }, []);

  useEffect(() => {
    const off = window.claude?.buddy?.onBarState?.((s: { visible: boolean; under?: boolean }) => { setVisible(!!s.visible); setUnder(!!s.under); });
    return off;
  }, []);

  return (
    <ThemeProvider>
      <div className="buddy-bar-root" data-visible={visible ? '1' : '0'} data-under={under ? '1' : '0'}>
        <BuddyBarButtons hint={under ? 'bottom' : 'top'} />
      </div>
    </ThemeProvider>
  );
}
