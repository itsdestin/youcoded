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
  /** The small label above the section's card (sentence case, never repeats the title). */
  label: string;
  node: React.ReactNode;
  /** Short facts rather than reading: sits in the right-hand column. */
  side?: boolean;
};

/** True inside the narrow right-hand column: buttons there stack full width, as in any
 *  narrow space (guide "Buttons": stacked when narrow; decisions BP-1) — the column is
 *  about 250px, narrower than the guide's 420px "narrow popup". */
const NarrowColumn = React.createContext(false);

/** A labelled group: the small label, then one first-level card holding it. */
function LabelledCard({ section }: { section: DetailSection }) {
  return (
    <section data-detail-section={section.id}>
      <SectionLabel className="mb-2">{section.label}</SectionLabel>
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
export function DetailIdentity({
  icon, name, status, quickActions, chips, description, children, actions,
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
}) {
  return (
    <div className={`${CARD_LEVEL_1} p-4 space-y-3`} data-detail-identity>
      <div className="flex items-start gap-3">
        {icon}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            {/* Session details' name size (text-lg semibold) — the subject of the popup. */}
            <div className="text-lg font-semibold text-fg leading-tight break-words min-w-0">{name}</div>
            {status}
          </div>
        </div>
        {quickActions && <div className="shrink-0 flex items-center gap-1 -mt-1 -mr-1">{quickActions}</div>}
      </div>
      {/* WHY one row that never wraps and fades at its end (decisions G-9, U-1): the
          chips are short facts, and a second row of them pushed the description down by a
          line at phone width. Full card width (not beside the quick actions) so a phone
          shows as many as it can before the fade. DetailPage.css draws the fade. */}
      {chips && <div data-detail-chips className="-mt-1 flex items-center gap-1.5 flex-nowrap overflow-hidden">{chips}</div>}
      {description && <p className="text-sm text-fg-2">{description}</p>}
      {children}
      {actions}
    </div>
  );
}

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
  const narrow = phone || inColumn;
  const items = React.Children.toArray(children).filter(Boolean);
  if (items.length === 0) return null;
  const stacked = narrow || items.length === 1;
  return (
    <div data-detail-actions className={stacked ? 'flex flex-col-reverse gap-2' : 'flex items-center justify-end gap-2'}>
      {stacked
        ? items.map((child, i) => <div key={i} className="flex flex-col">{child}</div>)
        : items}
    </div>
  );
}
