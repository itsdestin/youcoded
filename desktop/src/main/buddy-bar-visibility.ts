/**
 * Decides whether the buddy action bar should be visible: it is shown IFF the
 * chat is open.
 *
 * The bar used to also reveal on hover (spec §4.1), but its four actions are
 * only useful alongside an open chat, so a hover-reveal fired constantly for
 * nothing — the cursor merely passing over the buddy summoned it. Clicking the
 * mascot toggles the chat and the bar now rides along with it (Destin
 * 2026-07-16), which also makes the reveal a deliberate moment worth animating
 * (styles/buddy.css → buddy-btn-pop).
 *
 * That leaves this class trivial, and deliberately so: it exists to hold the
 * only-fire-on-change rule, which the callers would otherwise each reinvent.
 * It once tracked hover too, to suppress the docked→peek idle timer; both the
 * timer and the hover plumbing are gone (see buddy-dock.ts).
 *
 * Pure logic — unit-tested without Electron.
 */
export class BarVisibilityTracker {
  private chatOpen = false;
  private visible = false;

  constructor(private readonly onChange: (visible: boolean) => void) {}

  setChatOpen(open: boolean): void {
    this.chatOpen = open;
    const want = this.wantsVisible();
    if (want === this.visible) return;
    this.visible = want;
    this.onChange(want);
  }

  wantsVisible(): boolean {
    return this.chatOpen;
  }

  /** Drop all state without firing onChange — used when the buddy is torn down. */
  reset(): void {
    this.chatOpen = false;
    this.visible = false;
  }
}
