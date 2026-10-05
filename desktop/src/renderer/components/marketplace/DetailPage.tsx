// The one shell every Marketplace detail page is built from — plugins, skills,
// connections, themes and integrations alike (redesign 2026-10-04, backlog row 9:
// "these pages feel dated… not synced with our modern settings menus / session
// switcher / resume browser… rethink how we show these pages").
//
// WHY one shell: the old pages were a near-full-screen panel with their own header
// ("Details" and the words Esc and Close), a bare column of text and controls sitting straight on
// the panel, and a second hand-copied version for integrations that had drifted
// (its own header size, a full-width line, hand-typed buttons). Every piece here is
// one the design guide names, so the page reads like Session details, Account and
// Backup & sync:
//   - the shared popup (`Dialog`): one-line title, the ✕, the tapered line, Esc
//     (guide "Popups and side panels"; decisions B-1, H-2);
//   - a top card about the thing itself — name with its status pill on the top line,
//     one row of chips under it, the description (guide "Cards" → text order;
//     decisions U-1, G-9), its quick actions at the top right (guide "Cards");
//   - every other group is a small label and then a card (guide "Spacing" →
//     "Nothing sits bare", "A label comes first"; decisions NB-1…3).
// How the groups are ARRANGED was the one thing the guide left open; Destin picked two
// columns (marketplace-detail-1#MD-1): the reading on the left, the short facts on the
// right, one column at phone width. The one-column and folded drafts were removed.
import React from 'react';
import { CARD_LEVEL_1, Dialog, SectionLabel } from '../ui';
import { useNarrowViewport } from '../../hooks/use-narrow-viewport';
import './DetailPage.css';

export type DetailSection = {
  id: string;
  /** The small label above the section's card (sentence case, never repeats the title).
   *  Empty = no label: only for a card that is a PICTURE of the item (a theme's preview) —
   *  Destin dropped "Preview" there (marketplace-detail-2#M2-3: "dont need the text
   *  'preview'"), the same exception as the top card. */
  label: string;
  node: React.ReactNode;
  /** Short facts rather than reading: sits in the right-hand column. */
  side?: boolean;
};

/** True inside the narrow right-hand column: buttons there stack full width, as in any
 *  narrow space (guide "Buttons": stacked when narrow; decisions BP-1) — the column is
 *  about 250px, narrower than the guide's 420px "narrow popup". */
const NarrowColumn = React.createContext(false);

/** True when the top card puts its buttons on its text's line (`iconLayout="row"`): they
 *  then hug the right like any text-and-buttons line (guide "Buttons" → text and buttons
 *  in one box, on one line when they fit; decisions NB-2), never full width. */
const InlineActions = React.createContext(false);

/** A labelled group: the small label, then one first-level card holding it. */
function LabelledCard({ section }: { section: DetailSection }) {
  return (
    <section data-detail-section={section.id}>
      {section.label && <SectionLabel className="mb-2">{section.label}</SectionLabel>}
      <div className={`${CARD_LEVEL_1} p-3`}>{section.node}</div>
    </section>
  );
}

export function DetailPage({
  title, screen, onClose, identity, sections, hero, identitySide = false,
}: {
  /** The popup's own title, e.g. "Plugin details". */
  title: string;
  /** Photo-only build: the shoot screen this popup marks itself as. */
  screen?: string;
  onClose(): void;
  /** The top card about the item (see DetailIdentity). */
  identity: React.ReactNode;
  sections: DetailSection[];
  /** Something shown first, full width, above everything (a theme's preview picture). */
  hero?: React.ReactNode;
  /** Put the top card at the head of the right-hand column instead of across the top. */
  identitySide?: boolean;
}) {
  const narrow = useNarrowViewport();
  const main = sections.filter((s) => !s.side);
  const side = sections.filter((s) => s.side);
  const sideItems = [
    ...(identitySide ? [<NarrowColumn.Provider key="identity" value>{identity}</NarrowColumn.Provider>] : []),
    ...side.map((s) => <LabelledCard key={s.id} section={s} />),
  ];
  const mainItems = main.map((s) => <LabelledCard key={s.id} section={s} />);

  let body: React.ReactNode;
  if (narrow) {
    // Phone width: one column, the top card first, then the reading, then the facts.
    body = <>{identitySide && identity}{mainItems}{side.map((s) => <LabelledCard key={s.id} section={s} />)}</>;
  } else if (sideItems.length === 0 || mainItems.length === 0) {
    // Nothing to put beside it (a theme with only its preview): one column, full width.
    body = <>{identitySide && identity}{mainItems}{side.map((s) => <LabelledCard key={s.id} section={s} />)}</>;
  } else {
    body = (
      // WHY a 2:1 grid and not a fixed side width: the guide keeps exact sizes in the
      // shared pieces, and a ratio reflows with the window instead of needing a number.
      <div className="grid grid-cols-3 gap-4 items-start">
        <div className="col-span-2 space-y-4 min-w-0">{mainItems}</div>
        <div className="col-span-1 space-y-4 min-w-0">{sideItems}</div>
      </div>
    );
  }

  return (
    // WHY `wide`: the two-pane popup size (Dialog.tsx) — the only shared width with room
    // for a facts column beside the reading.
    <Dialog open onClose={onClose} title={title} size="wide" screen={screen}>
      {hero}
      {!identitySide && identity}
      {body}
    </Dialog>
  );
}

/**
 * The top card: the item itself. Name and status pill on the top line, quick actions
 * (favourite, share, like) at its top right, one row of chips, the description, then
 * anything about this one item (a notice, "Part of …") and its buttons — all INSIDE the
 * card (guide "Card levels": text that describes a card lives inside it; "Status and
 * notices": a notice about one thing sits inside that thing).
 *
 * WHY no label above it: it is the page's subject, like Session details' name card —
 * the one approved popup that opens on the thing it is about. A label here could only
 * repeat the title. (Recorded as a conflict with "A label comes first" in the friction log.)
 */
/** The chip row: one line that scrolls sideways (round 5, marketplace-detail-4#M4-2).
 *  WHY no wheel translation: like the Marketplace rails, the row takes the browser's own
 *  sideways scrolling — touch swipe, trackpad two-finger, and Shift + mouse wheel. Turning
 *  a plain vertical wheel into sideways scrolling would trap the popup's own scrolling
 *  whenever the pointer crossed the row. The fade tells the eye there is more. */
function ChipRow({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [fade, setFade] = React.useState<'none' | 'left' | 'right' | 'both'>('none');
  // 1px slack absorbs sub-pixel scroll positions (MarketplaceRail's rule).
  const update = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 1) { setFade('none'); return; }
    const left = el.scrollLeft > 1, right = el.scrollLeft < max - 1;
    setFade(left && right ? 'both' : left ? 'left' : right ? 'right' : 'none');
  }, []);
  // Window resize only, as the rails do: the row's width follows the window.
  React.useEffect(() => {
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [update, children]);
  return (
    // WHY py-1 with a matching -my-1 (Destin, marketplace-detail-5#M5-3: "the bottom of the
    // claude chip is clipping"): a sideways-scrolling box clips vertically too (CSS turns
    // overflow-y to auto alongside overflow-x), exactly at its content edge — and at a
    // fractional screen scale (1.5×) the chips' 1px bottom border rounded just outside it.
    // The padding gives the borders room inside the clip; the negative margin keeps the
    // card's spacing unchanged. Pinned in tests/marketplace-detail-shell.test.ts.
    <div ref={ref} data-detail-chips data-fade={fade} onScroll={update}
      className="flex-1 min-w-0 flex items-center gap-1.5 flex-nowrap overflow-x-auto py-1 -my-1">
      {children}
    </div>
  );
}

export function DetailIdentity({
  icon, name, status, quickActions, chips, description, children, actions,
  iconLayout = 'top', quickActionsOnTitle = false,
}: {
  icon?: React.ReactNode;
  name: React.ReactNode;
  status?: React.ReactNode;
  quickActions?: React.ReactNode;
  chips?: React.ReactNode;
  description?: React.ReactNode;
  /** Notices and rows about this item, between the description and the buttons. */
  children?: React.ReactNode;
  /** <DetailActions> — the item's buttons. */
  actions?: React.ReactNode;
  /** How an icon tile lines up with the words. `row` (Destin picked it, marketplace-detail-4
   *  #M4-1): one row, tile | name + description | buttons on one centre line — the Account
   *  profile card and the shared setting row (guide "Settings": control at the right,
   *  vertically centred). `top`: no icon, or the icon beside the name only. */
  iconLayout?: 'top' | 'row';
  /** Keep the quick actions on the name's line even in the narrow column; the name then
   *  wraps between words, never inside one. */
  quickActionsOnTitle?: boolean;
}) {
  const phone = useNarrowViewport();
  const inColumn = React.useContext(NarrowColumn);
  // WHY (round 3): in the narrow right-hand column the quick actions moved down beside
  // the chips, because beside the name "Meadow Mist" broke mid-word. A draft can now put
  // them back on the name's line (`quickActionsOnTitle`) with word-only wrapping instead.
  const actionsBelow = inColumn && !quickActionsOnTitle;
  const row = iconLayout === 'row' && !phone;
  const nameLine = (
    <div className="flex items-center gap-2 min-w-0 flex-wrap">
      {/* Session details' name size (text-lg semibold) — the subject of the popup.
          `break-normal` where the name shares its line: wrap between words only. */}
      <div className={`text-lg font-semibold text-fg leading-tight min-w-0 ${quickActionsOnTitle ? 'break-normal' : 'break-words'}`}>{name}</div>
      {status}
    </div>
  );
  const chipRow = (chips || (actionsBelow && quickActions)) && (
    <div className="-mt-1 flex items-center gap-2 min-w-0">
      <ChipRow>{chips}</ChipRow>
      {actionsBelow && quickActions && <div className="shrink-0 flex items-center gap-1 -mr-1">{quickActions}</div>}
    </div>
  );
  const quick = !actionsBelow && quickActions && <div className="shrink-0 flex items-center gap-1 -mt-1 -mr-1">{quickActions}</div>;
  const desc = description && <p className="text-sm text-fg-2">{description}</p>;

  if (row) {
    return (
      <div className={`${CARD_LEVEL_1} p-3 space-y-2`} data-detail-identity>
        <div className="flex items-center gap-3">
          {icon}
          <div className="min-w-0 flex-1 space-y-0.5">{nameLine}{desc}</div>
          <InlineActions.Provider value>{actions}</InlineActions.Provider>
          {quick}
        </div>
        {chipRow}
        {children}
      </div>
    );
  }
  return (
    <div className={`${CARD_LEVEL_1} p-4 space-y-3`} data-detail-identity>
      <div className="flex gap-3 items-start">
        {icon}
        <div className="min-w-0 flex-1 space-y-1">{nameLine}</div>
        {quick}
      </div>
      {chipRow}
      {desc}
      {children}
      {actions}
    </div>
  );
}

/** Added to the filled buttons beside an outlined one on a detail page.
 *  WHY (found 2026-10-05 by shoot's "parts agree" pass on its first run): an outlined button's 1px
 *  border makes it 2px taller than a filled one (Uninstall 38px beside Connect / Apply theme
 *  36px). A transparent border gives the filled one the same box. Scoped to the detail pages: the
 *  same 2px difference exists wherever the app pairs the two, and the fix belongs in the Button
 *  primitive — an app-wide size change left for Destin's call, not made here. */
export const PAIRED_PRIMARY = 'border border-transparent';

/**
 * The item's buttons, placed by the guide's width rule (guide "Buttons"; decisions
 * BP-1, BP-3, BW-1/2): one button is full width; two sit side by side hugging the right
 * edge, the filled one on the right — or, at phone width, stack full width with the
 * filled one on top. Pass children in reading order: less important first, the one
 * filled (main) action LAST.
 */
export function DetailActions({ children }: { children: React.ReactNode }) {
  // Both hooks always run (never short-circuit a hook call).
  const phone = useNarrowViewport();
  const inColumn = React.useContext(NarrowColumn);
  const inline = React.useContext(InlineActions);
  const narrow = phone || inColumn;
  const items = React.Children.toArray(children).filter(Boolean);
  if (items.length === 0) return null;
  const stacked = !inline && (narrow || items.length === 1);
  return (
    <div data-detail-actions className={stacked ? 'flex flex-col-reverse gap-2' : `flex items-center justify-end gap-2${inline ? ' shrink-0' : ''}`}>
      {stacked
        ? items.map((child, i) => <div key={i} className="flex flex-col">{child}</div>)
        : items}
    </div>
  );
}
