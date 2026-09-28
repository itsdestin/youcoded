import React, { useEffect, useState } from 'react';
import { Button } from './ui/Button';
import { AppIcon, ThemeMascot } from './Icons';
import { useUnreadableStartupDialog } from '../state/startup-dialog-store';
import { onBufferReady } from '../hooks/terminal-registry';
import { isAndroid } from '../platform';

/** How long the session's terminal must have been SILENT before the cover
 *  says "Something may be wrong".
 *
 *  WHY silence, not time since launch (second review F3, 2026-09-24): a start
 *  that is working keeps drawing — the banner, the input box, a dialog. The
 *  honest signal of "stuck" is no hook AND nothing happening on screen. And
 *  WHY longer on the phone: Android now waits for Claude Code's first hook
 *  (review F1), and a cold Node start on a slow phone can sit silent for
 *  several seconds before its first output, which is normal there. */
export const INIT_SLOW_WARNING_MS = 6000;
export const INIT_SLOW_WARNING_ANDROID_MS = 15000;

/**
 * The cover over a Claude Code session's chat until it has started (moved out
 * of App.tsx 2026-09-24, unchanged apart from the startup-dialog notice).
 * Terminal view stays reachable underneath; App mounts this only in chat view,
 * and not while a prompt card is waiting (the card must be seen).
 *
 * Safety net: when Claude Code is showing a startup dialog the app cannot turn
 * into buttons (usePromptDetector → startup-dialog-store), the cover says so AT
 * ONCE, in Claude Code's own words, with the one place it can be answered —
 * never a silent "Initializing…" followed by a vague hint.
 */
export function InitializingCover({ sessionId, onOpenTerminal, children }: {
  sessionId: string;
  onOpenTerminal: () => void;
  /** The plain "Initializing session..." line — kept in App.tsx, where the
   *  select-none ast-grep rule pins it. */
  children: React.ReactNode;
}) {
  const unreadable = useUnreadableStartupDialog(sessionId);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const quietMs = isAndroid() ? INIT_SLOW_WARNING_ANDROID_MS : INIT_SLOW_WARNING_MS;
    let t: ReturnType<typeof setTimeout>;
    const restart = () => { clearTimeout(t); t = setTimeout(() => setSlow(true), quietMs); };
    setSlow(false);
    restart();
    // Any drawing in this session's terminal restarts the clock (and takes
    // back a hint shown during a pause that has now ended).
    const unsub = onBufferReady((sid) => { if (sid === sessionId) { setSlow(false); restart(); } });
    return () => { clearTimeout(t); unsub(); };
  }, [sessionId]);

  return (
    // z-10: must stay below glassmorphism chrome (z-20) so header/bottom bars remain accessible
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-canvas">
      <ThemeMascot small={false} variant="idle" fallback={AppIcon} className="w-16 h-16 text-fg-dim mb-6 animate-pulse" />
      {unreadable ? (
        <div className="text-xs text-fg-muted text-center max-w-xs flex flex-col items-center gap-2" data-testid="startup-dialog-unreadable">
          <p className="text-sm text-fg-dim font-medium select-none">Claude Code is asking something</p>
          {unreadable.heading && <p className="text-fg-2">&ldquo;{unreadable.heading}&rdquo;</p>}
          <p>YouCoded can&rsquo;t show these options here. Answer it in terminal view.</p>
          <Button variant="secondary" size="sm" onClick={onOpenTerminal}>Answer in terminal view</Button>
        </div>
      ) : children}
      {slow && !unreadable && (
        <div className="mt-4 text-xs text-fg-muted text-center max-w-xs flex flex-col items-center gap-2">
          <p>Something may be wrong. The terminal may show what it is waiting on.</p>
          {/* One tap to the terminal — and because the cover is hidden in
              terminal view, switching also clears it. */}
          <Button variant="secondary" size="sm" onClick={onOpenTerminal}>Check terminal view</Button>
        </div>
      )}
    </div>
  );
}
