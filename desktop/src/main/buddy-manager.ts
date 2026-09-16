import type { BrowserWindow, WebContents } from 'electron';

// WHY: main.ts must not care whether the buddy is three windows (Win/mac/X11)
// or one overlay window (Linux Wayland). Everything main.ts needs is here.
export interface BuddyManager {
  show(): void;
  hide(): void;
  dismiss(): void;
  getStatus(): { dismissed: boolean; visible: boolean };
  toggleChat(): void;
  setViewedSession(sessionId: string): void;
  getViewedSession(): string | null;
  setAttentionNeeded(needed: boolean): void;
  isBuddyWindow(win: BrowserWindow): boolean;
  /** Windows to hide while capturing the desktop (capture-icon flow). */
  captureWindows(): BrowserWindow[];
  /** WebContents that hosts the buddy chat — target for BUDDY_ATTACH_FILE. */
  chatWebContents(): WebContents | null;
  /** Per-frame drag path used ONLY by the three-window model; overlay no-ops. */
  moveMascot(targetX: number, targetY: number): void;
  /** Cursor offset from the grab point, in the mascot window's own coordinates. */
  moveMascotFromPointer(localDx: number, localDy: number): void;
  dragEnded(): void;
}

// WHY: one decision point, pure and testable. The overlay was built because
// Wayland forbids window positioning; everywhere else keeps three windows.
//
// WHY 'windows' is now the default EVERYWHERE, including Linux Wayland
// (2026-07-23): Electron's setIgnoreMouseEvents is a TOTAL no-op on native
// Wayland — probe-verified with live clicks, both with and without
// {forward:true} — so the screen-sized overlay cannot pass clicks through
// and becomes an invisible full-screen click-eater. The overlay code stays
// dormant behind the YOUCODED_BUDDY_STRATEGY=overlay override until the
// platform grows the primitive. On Wayland this means NO buddy (same as
// before this feature — not a regression). Full evidence and next steps:
// youcoded-dev/docs/active/investigations/
// 2026-07-23-buddy-overlay-wayland-presentation.md
export function chooseBuddyStrategy(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>
): 'overlay' | 'windows' {
  if (platform !== 'linux') return 'windows';
  if (env.YOUCODED_BUDDY_STRATEGY === 'windows' || env.YOUCODED_BUDDY_STRATEGY === 'overlay') {
    return env.YOUCODED_BUDDY_STRATEGY; // dev/test override + future re-enable path
  }
  return 'windows';
}
