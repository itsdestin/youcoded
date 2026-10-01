// prompt-card-reader.ts — decides, from what a terminal's screen shows, when a card goes up and when it comes down. One per session.
//
// WHY (2026-10-01 one-core R5-4b): this was the body of the renderer's usePromptDetector. The computer's main process now reads every Claude Code
// terminal itself (main/session-screens.ts) and publishes the card once, so a phone gets setup cards with no computer window open. The Android app's
// own runtime has no such host and keeps reading in its renderer until the Android rebuild. Both must make the SAME decisions from the same screen, so
// the decisions live here once and each caller only supplies how to read the screen, what is waiting on the person, and where a card goes.
//
// What it does (unchanged from the window's detector): read the visible screen's Ink select menu (shared/ink-select-parser.ts); a menu that is a known
// setup prompt (or, while the session is still starting, any Claude Code dialog) becomes a card after a short debounce, if no permission ask owns the menu;
// a menu that leaves is dismissed after a debounce; a different menu replaces the card; an answered, navigated card whose identical dialog is still up a
// second later gets a fresh one (Claude Code asked the same question again).
import { parseInkSelect, menuToButtons, type ParsedMenu } from './ink-select-parser';
import { cardTitleFor, PROMPT_DEBOUNCE_MS, POST_PERMISSION_COOLDOWN_MS, DISMISS_DEBOUNCE_MS, REISSUE_MS } from './prompt-card-rules';
import type { PromptCardButton } from './session-live-types';

interface CardToShow {
  promptId: string;
  title: string;
  description?: string;
  buttons: PromptCardButton[];
  defaultIndex?: number;
}

export interface PromptCardReaderDeps {
  /** The visible screen as text (shared/terminal-screen-text.ts), or null / '' when there is no terminal to read. */
  readScreen(): string | null | undefined;
  /** What the session is waiting on, or null when it cannot be known right now (nothing is shown or dismissed then). */
  need(): { asking: boolean; started: boolean } | null;
  /** When the last live permission ask closed (ms), or 0: the menu may still be redrawing, so it is not read as a new one. */
  askClearedAt(): number;
  /** Was the card with this id answered (by the person, on any screen)? Only asked for a navigated card. */
  isAnswered(promptId: string): boolean;
  show(card: CardToShow): void;
  dismiss(promptId: string): void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export class PromptCardReader {
  private lastMenuId: string | null = null;
  private shownMenuId: string | null = null;
  private shownPromptId: string | null = null;
  private shownHasPick = false;
  private pendingShow: unknown | null = null;
  private dismissTimer: unknown | null = null;
  private reissueTimer: unknown | null = null;

  constructor(private readonly deps: PromptCardReaderDeps) {}

  /** A menu is on screen, or a card/timer of this reader is still waiting to be settled: the terminal is still worth reading. */
  get busy(): boolean { return this.lastMenuId !== null || this.pendingShow !== null || this.dismissTimer !== null; }

  /** Is a card from this reader up? (And is it one a navigation answer applies to? Main uses this to know an Enter is an answer.) */
  get shownNavigatedCard(): boolean { return this.shownPromptId !== null && this.shownHasPick; }
  get shownCardId(): string | null { return this.shownPromptId; }

  /** The screen changed (or a timer's worth of time passed): decide. Returns whether anything here still needs the screen. */
  scan(): void {
    const need = this.deps.need();
    if (!need) return;
    // A live ask silences the reader: the permission card owns that menu (a kept ask, whose hook closed, does not).
    if (need.asking) return;
    // The permission just closed and Claude Code may still be redrawing its menu: do not read it as a new one.
    const cleared = this.deps.askClearedAt();
    if (cleared && this.deps.now() - cleared < POST_PERMISSION_COOLDOWN_MS) return;
    const screen = this.deps.readScreen();
    if (!screen) return;

    const menu = parseInkSelect(screen);
    const lastMenuId = this.lastMenuId;
    const starting = !need.started;

    if (menu) {
      this.clear('dismissTimer');
      if (menu.id !== lastMenuId) {
        // A DIFFERENT menu replaced the previous one: retire the old card BEFORE the known-title gate below can bail out, or a recognised card
        // followed by an unrecognised menu would stay open forever and block sends (crash-resumed sessions, 2026-07-16). Gated on a card
        // actually shown, so id churn from false-positive "menus" (a streaming numbered list) costs nothing.
        this.clear('pendingShow');
        if (lastMenuId && this.shownMenuId === lastMenuId) {
          this.shownMenuId = null;
          const id = this.shownPromptId ?? lastMenuId;
          this.shownPromptId = null;
          this.deps.dismiss(id);
        }
        this.clear('reissueTimer');
        this.lastMenuId = menu.id;
        // Only known setup prompts become cards; permission prompts and numbered lists are skipped (hooks handle permissions).
        const title = cardTitleFor(menu, starting);
        if (title === null) return;
        this.scheduleShow(menu, title);
      } else {
        // The SAME menu still (or again): a readable menu with no card showing and none scheduled gets one now (an unreadable frame inside the
        // debounce cancelled the timer; review F2 of the window's detector, 2026-09-24).
        const title = cardTitleFor(menu, starting);
        if (title !== null && this.shownMenuId !== menu.id && this.pendingShow === null) this.scheduleShow(menu, title);
        // Its card was ANSWERED and an identical dialog is (still) there: Claude Code asked the same question again.
        if (title !== null && this.shownMenuId === menu.id) this.checkReissue(menu, title);
      }
    } else if (lastMenuId && this.dismissTimer === null) {
      // The menu is gone: debounce the dismissal so a brief redraw (clear -> redraw) does not reset duplicate detection.
      this.clear('pendingShow');
      this.dismissTimer = this.deps.setTimer(() => {
        this.dismissTimer = null;
        const shownId = this.shownPromptId ?? lastMenuId;
        if (this.shownMenuId === lastMenuId) this.shownMenuId = null;
        this.shownPromptId = null;
        this.lastMenuId = null;
        this.deps.dismiss(shownId);
      }, DISMISS_DEBOUNCE_MS);
    }
  }

  private clear(which: 'pendingShow' | 'dismissTimer' | 'reissueTimer'): void {
    const h = this[which];
    if (h !== null) { this.deps.clearTimer(h); this[which] = null; }
  }

  private scheduleShow(menu: ParsedMenu, title: string, promptId: string = menu.id): void {
    // Debounce: give the hook system time to deliver a PermissionRequest (the permission card handles that one instead).
    this.pendingShow = this.deps.setTimer(() => {
      this.pendingShow = null;
      const need = this.deps.need();
      if (!need || need.asking) return;
      const cleared = this.deps.askClearedAt();
      if (cleared && this.deps.now() - cleared < POST_PERMISSION_COOLDOWN_MS) return;
      // The menu must STILL be on screen: showing a card for a menu that has gone strands a card whose only clearer is a later screen change,
      // and an idle terminal produces none (the "SHOW fired for a vanished menu" race, 2026-07-17).
      const nowScreen = this.deps.readScreen();
      const nowMenu = nowScreen ? parseInkSelect(nowScreen) : null;
      if (!nowMenu || nowMenu.id !== menu.id) return;
      const buttons = menuToButtons(menu);
      const verified = buttons.some((b) => b.pick);
      this.shownMenuId = menu.id;
      this.shownPromptId = promptId;
      this.shownHasPick = verified;
      this.deps.show({
        promptId, title,
        ...(menu.description !== undefined ? { description: menu.description } : {}),
        buttons: buttons.map((b) => ({
          label: b.label, input: b.input,
          ...(b.submitInput !== undefined ? { submitInput: b.submitInput } : {}),
          ...(b.pick ? { pick: b.pick } : {}),
        })),
        // An unnumbered dialog is answered by moving Claude Code's own cursor, so the card starts where that cursor is.
        ...(verified ? { defaultIndex: nowMenu.selectedIndex } : {}),
      });
    }, PROMPT_DEBOUNCE_MS);
  }

  /**
   * A card answered by verified navigation whose identical dialog is still on screen REISSUE_MS later gets a fresh card (a new id, `<menu id>~1`; the
   * answered one stays as the record of the first answer). Guarded hard: only an ANSWERED card; only a navigated one (its driver confirmed Claude Code
   * redrew after the Enter, while a digit answer completes before anything is known and a slow-to-leave menu would earn a "~1" card for a question
   * already answered); at most once per dialog; and re-checked when the timer fires.
   */
  private checkReissue(menu: ParsedMenu, title: string): void {
    if (this.reissueTimer !== null) return;
    const promptId = this.shownPromptId ?? menu.id;
    if (promptId === `${menu.id}~1`) return;
    if (!this.shownHasPick || !this.deps.isAnswered(promptId)) return;
    this.reissueTimer = this.deps.setTimer(() => {
      this.reissueTimer = null;
      const nowScreen = this.deps.readScreen();
      const nowMenu = nowScreen ? parseInkSelect(nowScreen) : null;
      if (!nowMenu || nowMenu.id !== menu.id) return;
      if (!this.deps.isAnswered(promptId)) return;
      // The answered card leaves (a host drops it from its record; a window's reducer keeps an ANSWERED card as the first answer's record).
      this.deps.dismiss(promptId);
      this.scheduleShow(nowMenu, title, `${menu.id}~1`);
    }, REISSUE_MS);
  }

  /** Stop everything this reader has scheduled and forget its state (the terminal is gone). */
  dispose(): void {
    this.clear('pendingShow'); this.clear('dismissTimer'); this.clear('reissueTimer');
    this.lastMenuId = null; this.shownMenuId = null; this.shownPromptId = null; this.shownHasPick = false;
  }
}
