// Phone layout round (2026-11-05, youcoded-dev docs/active/design/
// 2026-11-04-narrow-screens/): the session list's proposed phone shapes.
//
//   dropdown — today's list at full phone width
//   sheet    — rises from the bottom, in thumb reach
//   full     — its own screen with a title and a close button
//   drawer   — slides in from the left; the side-drawer top bar's home, with the
//              ☰ menu's places under the sessions
//   hub      — round 3 (Destin: "a full second/parallel option that includes
//              active sessions + resumable sessions with restyled new session
//              button and settings/other buttons, in place of current 3 line
//              menu"): the drawer's place, opened by ☰ only — New session on
//              top, open sessions, recent past ones, the places as tiles
//
// WHY a separate file: SessionStrip.tsx is held to a line budget
// (tests/line-budgets.test.ts), and these are pieces the strip only places.
// Workbench-only (switches in workbench-mode.ts). DECIDED in round 4: the name
// opens `dropdown`; ☰ stays today's small menu. The build deletes sheet, full,
// drawer and hub (hub's reference copy: youcoded-dev
// docs/active/prototypes/2026-11-05-phone-hub/).
import React, { useEffect, useState } from 'react';
import { Button, CloseButton, SectionLabel, Tooltip } from '../ui';
import { STATUS_LABEL, type SessionStatusColor } from '../StatusDot';
import { formatRelativeTime } from '../../utils/format-time';
import { Scrim } from '../overlays/Overlay';
import { useNarrowViewport } from '../../hooks/use-narrow-viewport';
import { workbenchNarrowTop, workbenchNarrowList } from '../../workbench-mode';

export type MenuShape = 'today' | 'dropdown' | 'sheet' | 'full' | 'drawer' | 'hub';
type PhoneShape = Exclude<MenuShape, 'today'>;

/** Which phone top bar and list shape the strip draws. Both switches are
 *  `today` outside the workbench, so the app is unchanged until a pick lands.
 *  The side-drawer top bar IS a list shape: the list lives in the drawer. */
export function usePhoneMenu() {
  const narrow = useNarrowViewport();
  const narrowTop = narrow ? workbenchNarrowTop() : 'today';
  // Round 3's bars use the squeezed rows too (full width, Destin's last pick
  // is open), so the name's list is at least the full-width dropdown there.
  const round3 = narrowTop === 'plain' || narrowTop === 'lights' || narrowTop === 'hub';
  const list = narrow ? workbenchNarrowList() : 'today';
  const menuShape: MenuShape = narrowTop === 'drawer' ? 'drawer' : round3 && list === 'today' ? 'dropdown' : list;
  // "a more simply styled name dropdown button kinda like drawer": no pill
  // outline; the dot, the name and the arrow share ONE hover background.
  const plainTitle = narrowTop === 'drawer' || round3;
  return { narrowTop, menuShape, phoneRows: menuShape !== 'today', plainTitle };
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
    case 'hub':
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
  if (shape !== 'sheet' && shape !== 'drawer' && shape !== 'hub') return null;
  return <Scrim layer={2} onClick={onClose} />;
}

/** The bottom panel's grab bar, so it reads as something that slid up; the full
 *  screen's title row, since no chat is left visible to tap away on. */
export function PhoneMenuTop({ shape, onClose, onNew }: { shape: MenuShape; onClose: () => void; onNew?: () => void }) {
  // The hub's New session: the panel's first and biggest action, where the
  // Claude/ChatGPT apps put theirs, instead of half of the bottom button row.
  if (shape === 'hub') {
    return (
      <div className="shrink-0 px-3 pt-3 pb-1">
        <Button variant="primary" size="md" className="w-full" onClick={onNew}>+ New session</Button>
      </div>
    );
  }
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
  if ((shape !== 'drawer' && shape !== 'hub') || !children) return null;
  return (
    // mt-auto: in the hub the places sit at the panel's bottom edge, in thumb reach.
    <div className="mt-auto border-t border-edge py-1 shrink-0" onClickCapture={onClose}>
      {children}
    </div>
  );
}

interface PastRow { sessionId: string; name: string; projectPath: string; lastModified: number }

/** The hub's "Earlier" section: the five most recent conversations not open
 *  now, from the same list the Resume page reads (session.browse). Fetched when
 *  the panel opens, never kept live — the Resume page owns the full list.
 *  A tap opens the Resume page for now (see the round-3 deck's risk line); the
 *  built version would reopen that conversation directly. */
export function PhoneRecent({ shape, openIds, onSeeAll }: { shape: MenuShape; openIds: ReadonlySet<string>; onSeeAll: () => void }) {
  const [rows, setRows] = useState<PastRow[] | null>(null);
  const on = shape === 'hub';
  useEffect(() => {
    if (!on) return;
    let live = true;
    void (window as any).claude.session.browse().then((all: PastRow[]) => {
      if (!live) return;
      // openIds holds open sessions' ids AND names: browse() already leaves open
      // ones out in the app, but the workbench's practice list does not, and a
      // chat listed under both "Open now" and "Earlier" would read as a bug.
      setRows(all.filter((r) => !openIds.has(r.sessionId) && !openIds.has(r.name)).sort((a, b) => b.lastModified - a.lastModified).slice(0, 5));
    }).catch(() => { if (live) setRows([]); });
    return () => { live = false; };
    // Once per opening: openIds changing while the panel is up is not a reason to refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
  if (!on || !rows || rows.length === 0) return null;
  return (
    <div className="shrink-0 border-t border-edge pt-1.5">
      <div className="flex items-center mx-3">
        <SectionLabel className="flex-1">Earlier</SectionLabel>
        <button type="button" onClick={onSeeAll} className="text-xs text-fg-muted hover:text-fg px-1 py-0.5 rounded-sm">See all</button>
      </div>
      {rows.map((r) => (
        <button key={r.sessionId} type="button" onClick={onSeeAll} className="coarse-roomy w-full flex flex-col items-start px-3 py-1.5 text-left hover:bg-inset transition-colors">
          <span className="w-full truncate text-sm text-fg-2">{r.name}</span>
          <span className="w-full truncate text-3xs text-fg-muted">{r.projectPath.replace(/\\/g, '/').split('/').pop()} · {formatRelativeTime(r.lastModified)}</span>
        </button>
      ))}
    </div>
  );
}

// The status palette the strip's own dots use (SessionStrip DOT_BG) — status
// colours are theme-independent by rule, so they are fixed here too.
const LIGHT_BG: Record<SessionStatusColor, string> = {
  green: 'bg-green-400', red: 'bg-red-400', amber: 'bg-amber-400', blue: 'bg-blue-400', gray: 'bg-gray-500',
};

/** Round 3, Destin: "maybe a row of indicator lights very small below the
 *  name". One tiny light per OTHER open session, in strip order, coloured by
 *  its status — so "another chat needs you" shows without opening the list.
 *  Grey (idle) sessions are drawn faint so the coloured ones stand out. */
export function SessionLights({ ids, activeId, statuses }: { ids: string[]; activeId: string | null; statuses?: Map<string, SessionStatusColor> }) {
  const others = ids.filter((id) => id !== activeId);
  if (others.length === 0) return null;
  const counts = new Map<SessionStatusColor, number>();
  for (const id of others) { const c = statuses?.get(id) ?? 'gray'; counts.set(c, (counts.get(c) ?? 0) + 1); }
  const label = [...counts].map(([c, n]) => `${n} ${STATUS_LABEL[c].toLowerCase()}`).join(', ');
  return (
    <Tooltip text={`Other sessions: ${label}`}>
      {/* Not its own button: the name stack around it (HeaderBar) takes every click (round 4).
          `session-lights` fades while the list is open — globals.css. */}
      <span className="session-lights flex items-center justify-center gap-[3px] h-1.5 transition-opacity" aria-label={`Other sessions: ${label}`}>
        {others.slice(0, 12).map((id) => {
          const c = statuses?.get(id) ?? 'gray';
          return <span key={id} data-status={c} className={`w-1 h-1 rounded-full ${LIGHT_BG[c]} ${c === 'gray' ? 'opacity-40' : ''}`} />;
        })}
      </span>
    </Tooltip>
  );
}
