// Phone layout round (2026-11-05, youcoded-dev docs/active/design/
// 2026-11-04-narrow-screens/): the session list's proposed phone shapes.
//
//   dropdown — today's list at full phone width
//   sheet    — rises from the bottom, in thumb reach
//   full     — its own screen with a title and a close button
//   drawer   — slides in from the left; the side-drawer top bar's home, with the
//              ☰ menu's places under the sessions
//
// WHY a separate file: SessionStrip.tsx is held to a line budget
// (tests/line-budgets.test.ts), and these are pieces the strip only places.
// Workbench-only until Destin picks a shape (switches in workbench-mode.ts);
// the losing shapes are deleted then.
import React from 'react';
import { CloseButton } from '../ui';
import { Scrim } from '../overlays/Overlay';
import { useNarrowViewport } from '../../hooks/use-narrow-viewport';
import { workbenchNarrowTop, workbenchNarrowList } from '../../workbench-mode';

export type MenuShape = 'today' | 'dropdown' | 'sheet' | 'full' | 'drawer';
type PhoneShape = Exclude<MenuShape, 'today'>;

/** Which phone top bar and list shape the strip draws. Both switches are
 *  `today` outside the workbench, so the app is unchanged until a pick lands.
 *  The side-drawer top bar IS a list shape: the list lives in the drawer. */
export function usePhoneMenu() {
  const narrow = useNarrowViewport();
  const narrowTop = narrow ? workbenchNarrowTop() : 'today';
  const menuShape: MenuShape = narrowTop === 'drawer' ? 'drawer' : narrow ? workbenchNarrowList() : 'today';
  return { narrowTop, menuShape, phoneRows: menuShape !== 'today' };
}

/** Q-1 option A, "full name, small count": the "+N" chip leaves the row so the
 *  name gets its room, and the count rides on the arrow that opens the list.
 *  Inline beside the arrow, not a corner badge: the strip is overflow-hidden
 *  and would clip one. */
export function PhoneCount({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="min-w-[14px] h-[14px] px-1 rounded-full bg-well text-fg-2 text-4xs font-semibold leading-[14px] text-center">
      {n}
    </span>
  );
}

/** Inline overrides for the list's panel. Inline rather than classes so the
 *  panel keeps its literal class list, which tests/float-chrome-pops.test.ts
 *  and the float chrome's `.session-menu` styling read. */
export function phoneMenuStyle(shape: PhoneShape, trigger: DOMRect | undefined): React.CSSProperties {
  // The on-screen keyboard shrinks the visible area; --vvp-offset is the app's
  // own measure of it (hooks/useVisualViewport.ts), as the today branch uses.
  const avail = 'calc(100vh - var(--vvp-offset, 0px))';
  const none = 0;
  switch (shape) {
    case 'dropdown': {
      const top = (trigger?.bottom ?? 40) + 4;
      const below = `calc(100vh - ${top + 8}px - var(--vvp-offset, 0px))`;
      return { top, left: 8, right: 8, width: 'auto', maxHeight: below, '--session-menu-available-height': below, animation: 'dropdown-in 120ms var(--ease-out) both' } as React.CSSProperties;
    }
    case 'sheet':
      return {
        left: 0, right: 0, bottom: 'var(--vvp-offset, 0px)', width: 'auto',
        borderLeftWidth: none, borderRightWidth: none, borderBottomWidth: none,
        borderRadius: '1rem 1rem 0 0',
        maxHeight: `calc(${avail} * 0.85)`, '--session-menu-available-height': `calc(${avail} * 0.85)`,
        animation: 'phone-sheet-in 180ms var(--ease-out) both',
      } as React.CSSProperties;
    case 'full':
      return {
        top: 0, left: 0, right: 0, bottom: 'var(--vvp-offset, 0px)', width: 'auto',
        borderWidth: none, borderRadius: 0,
        '--session-menu-available-height': avail,
        animation: 'dropdown-in 120ms var(--ease-out) both',
      } as React.CSSProperties;
    case 'drawer':
      return {
        top: 0, bottom: 0, left: 0, width: 'min(20rem, 86vw)',
        borderLeftWidth: none, borderTopWidth: none, borderBottomWidth: none,
        borderRadius: '0 1rem 1rem 0',
        '--session-menu-available-height': avail,
        animation: 'phone-drawer-in 180ms var(--ease-out) both',
      } as React.CSSProperties;
  }
}

/** Shapes that cover the chat dim it; a tap on the dimmed part closes the list
 *  (the strip's outside-click closer also sees it). */
export function PhoneMenuScrim({ shape, onClose }: { shape: MenuShape; onClose: () => void }) {
  if (shape !== 'sheet' && shape !== 'drawer') return null;
  return <Scrim layer={2} onClick={onClose} />;
}

/** The bottom panel's grab bar, so it reads as something that slid up; the full
 *  screen's title row, since no chat is left visible to tap away on. */
export function PhoneMenuTop({ shape, onClose }: { shape: MenuShape; onClose: () => void }) {
  if (shape === 'sheet') {
    return (
      <div className="shrink-0 flex justify-center pt-2 pb-1" aria-hidden>
        <span className="w-10 h-1 rounded-full bg-edge" />
      </div>
    );
  }
  if (shape === 'full') {
    return (
      <div className="shrink-0 flex items-center gap-2 px-3 h-11 border-b border-edge">
        <span className="flex-1 text-sm font-medium text-fg">Your sessions</span>
        <CloseButton onClick={onClose} label="Close sessions" />
      </div>
    );
  }
  return null;
}

/** The ☰ menu's places under the sessions in the side drawer, Settings last
 *  (the way the Claude and ChatGPT apps end their side panels). Any tap on one
 *  closes the drawer. */
export function PhoneDrawerFooter({ shape, onClose, children }: { shape: MenuShape; onClose: () => void; children?: React.ReactNode }) {
  if (shape !== 'drawer' || !children) return null;
  return (
    <div className="border-t border-edge py-1 shrink-0" onClickCapture={onClose}>
      {children}
    </div>
  );
}
