import { AppIcon, ThemeMascot } from './Icons';
import { Button } from './ui';

// Plan 2b "Moved Gate" (2026-07-14). When another device takes over a session's
// lease, the holder side cleanly interrupts → flushes → releases → destroys the
// local CC session (unchanged). The session is GONE — but we keep its pill in the
// strip and, when the user clicks it, render THIS full-page gate instead of the
// chat/terminal view.
//
// Why a gate and not an inline "moved" marker (the original Task 10 design): the
// holder destroys the session immediately after the moved push, and SESSION_REMOVE
// wipes the whole chat state — so a timeline marker was appended then deleted
// back-to-back and never rendered. A dedicated gate also sidesteps three tails of
// keeping a dead session in the normal view: (1) the terminal-view xterm write
// path isn't gated by !sessionInitialized, so a second writer could re-open the
// conversation; (2) an already-dead session's ✕ no-ops (un-removable zombie);
// (3) SESSION_PROCESS_EXITED would flash a competing "session died" banner. The
// gate's ONLY interactions are Exit / Resume, so none of those can happen.
//
// Modeled on TrustGate: a full-cover content-area gate at z-10 (BELOW the
// glassmorphism chrome at z-20) so the header session strip + settings stay
// reachable — the user can switch to another session or resume/exit here.

interface Props {
  device?: string;
  onExit: () => void;
  onResume: () => void;
  // Resume actually runs on the HOST when clicked from a remote browser, which is
  // a mild semantic oddity — the caller hides the button in remote mode.
  canResume?: boolean;
}

export default function MovedGate({ device, onExit, onResume, canResume = true }: Props) {
  return (
    // z-10: must stay below glassmorphism chrome (z-20) so header/bottom bars remain accessible
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-canvas px-6">
      <ThemeMascot small={false} variant="idle" fallback={AppIcon} className="w-16 h-16 text-fg-dim mb-6" />
      <p className="text-sm text-fg font-medium mb-1">
        This session was taken over on {device ?? 'another device'}.
      </p>
      <p className="text-xs text-fg-muted mb-6 max-w-sm text-center">
        Claude Code ended here when the conversation moved. You can resume it on this
        device, or close it out.
      </p>
      <div className="flex gap-3">
        {/* The filled-grey "bg-inset hover:bg-edge" treatment collapses into the
            primitive's `secondary` outline (spec decision 60) — the two buttons
            are genuine peers here, so ghost would under-weight Exit. */}
        <Button variant="secondary" size="lg" onClick={onExit} className="py-1.5">
          Exit Session
        </Button>
        {canResume && (
          // Behavior change (spec change 75): this button's old `hover:bg-accent`
          // sat on top of a `bg-accent` base, so hovering it did nothing visible.
          // `primary` gives it a real hover fade for the first time.
          <Button size="lg" onClick={onResume} className="py-1.5">
            Resume on this device
          </Button>
        )}
      </div>
    </div>
  );
}
