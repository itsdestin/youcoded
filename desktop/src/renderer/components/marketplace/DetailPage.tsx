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
// How those groups are ARRANGED is the one thing the guide leaves open, so it is
// a switch (`workbenchDetailLayout`, workbench-only) until Destin picks.
import React from 'react';
import { CARD_LEVEL_1, Dialog, FoldRow, SectionLabel } from '../ui';
import { useNarrowViewport } from '../../hooks/use-narrow-viewport';
import { workbenchDetailLayout } from '../../workbench-mode';
import './DetailPage.css';

export type DetailSection = {
  id: string;
  /** The small label above the section's card (sentence case, never repeats the title). */
  label: string;
  node: React.ReactNode;
  /** Short facts rather than reading: sits in the right-hand column of the wide layout. */
  side?: boolean;
  /** Stays open in the folded layout (what an item can do is read BEFORE installing —
   *  marketplace overhaul decision #3). */
  keepOpen?: boolean;
  /** One line under the fold-out row's title in the folded layout, so a closed row
   *  still says what is inside it. */
  summary?: React.ReactNode;
};

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
  title, screen, onClose, identity, sections, moreLabel,
}: {
  /** The popup's own title, e.g. "Plugin details". */
  title: string;
  /** Photo-only build: the shoot screen this popup marks itself as. */
  screen?: string;
  onClose(): void;
  /** The top card about the item (see DetailIdentity). */
  identity: React.ReactNode;
  sections: DetailSection[];
  /** Label over the fold-out card in the folded layout, e.g. "More about this plugin". */
  moreLabel: string;
}) {
  const layout = workbenchDetailLayout();
  const narrow = useNarrowViewport();
  // WHY document (600px) for the one-column layouts: it is the shared popup's width for
  // long reading (Dialog.tsx, DIALOG_WIDTHS), and these pages are mostly reading. The
  // two-column layout needs the two-pane `wide` size to fit a facts column beside it.
  const size = layout === 'columns' ? 'wide' : 'document';

  let body: React.ReactNode;
  if (layout === 'columns' && !narrow) {
    const main = sections.filter((s) => !s.side);
    const side = sections.filter((s) => s.side);
    body = (
      // WHY a 2:1 grid and not a fixed side width: the guide keeps exact sizes in the
      // shared pieces, and a ratio reflows with the window instead of needing a number.
      <div className="grid grid-cols-3 gap-4 items-start">
        <div className="col-span-2 space-y-4 min-w-0">{main.map((s) => <LabelledCard key={s.id} section={s} />)}</div>
        <div className="col-span-1 space-y-4 min-w-0">{side.map((s) => <LabelledCard key={s.id} section={s} />)}</div>
      </div>
    );
  } else if (layout === 'folded') {
    const open = sections.filter((s) => s.keepOpen);
    const folded = sections.filter((s) => !s.keepOpen);
    body = (
      <>
        {open.map((s) => <LabelledCard key={s.id} section={s} />)}
        {folded.length > 0 && (
          // WHY fold-out rows inside ONE labelled card: About → Privacy's approved recipe
          // (decisions "Nothing bare — … About": "each text section into a card, some
          // collapsible, easier to navigate and more concise"; guide "Settings" → one
          // fold-out style everywhere).
          <section data-detail-section="more">
            <SectionLabel className="mb-2">{moreLabel}</SectionLabel>
            <div className={`${CARD_LEVEL_1} p-3 space-y-2`}>
              {folded.map((s) => (
                <FoldRow key={s.id} title={s.label} description={s.summary}>
                  <div className="px-1 pb-1">{s.node}</div>
                </FoldRow>
              ))}
            </div>
          </section>
        )}
      </>
    );
  } else {
    body = sections.map((s) => <LabelledCard key={s.id} section={s} />);
  }

  return (
    <Dialog open onClose={onClose} title={title} size={size} screen={screen}>
      {identity}
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
  const narrow = useNarrowViewport();
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
