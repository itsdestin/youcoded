import React, { useRef } from 'react';
import type { SkillEntry } from '../../shared/types';
import FavoriteStar from './marketplace/FavoriteStar';
import { STATUS_DOT_BG, STATUS_PILL_TONE } from './status-color-palette';

interface FavoriteProps {
  filled: boolean;
  onToggle: () => void;
}

interface PluginBadgeProps {
  name: string;
  onClick: () => void;
}

interface Props {
  skill: SkillEntry;
  onClick: (skill: SkillEntry) => void;
  /** When provided, a corner favorite star overlays the card. */
  favorite?: FavoriteProps;
  /** When provided, replaces the generic YC/Plugin/Prompt source tag with
   *  a clickable pill showing the parent plugin's marketplace displayName.
   *  Clicking routes the user to that plugin's detail page. Skills with
   *  no matching marketplace plugin fall back to the source tag. */
  pluginBadge?: PluginBadgeProps;
  /** Workbench-only preview until project availability has a real source of truth. */
  availabilityPreview?: 'automatic' | 'manual';
}

// Change 23: every badge this card renders is an IDENTITY badge — "YC",
// "Prompt", "Plugin", or a plugin's display name. None of them is a status, so
// none of them earns a status color. They all collapse to the one accent pill
// the design review approved (the blue-status alternative was offered and not
// taken). This retires the last raw #4CAF50 / #f0ad4e hexes in this file; the
// only reason they differed before was that the map grew one key at a time.
const IDENTITY_BADGE =
  'bg-accent/15 text-accent border border-accent/30';

// WHY: match the SessionStrip status pill's tinted border + neutral word +
// colored dot, instead of making the status WORD low-contrast in light themes.
// This is a preview vocabulary only; live availability needs native policy.
const AVAILABILITY_PREVIEW = {
  automatic: { tone: 'green', label: 'Automatic' },
  manual: { tone: 'amber', label: 'Manual use' },
  unavailable: { tone: 'red', label: 'Unavailable' },
} as const;
export function AvailabilityPreviewChip({ kind }: { kind: keyof typeof AVAILABILITY_PREVIEW }) {
  const { tone, label } = AVAILABILITY_PREVIEW[kind];
  return <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border pl-1 pr-1.5 py-[1px] text-2xs leading-none text-fg-2 ${STATUS_PILL_TONE[tone]}`}>
    <span className={`h-2 w-2 rounded-full ${STATUS_DOT_BG[tone]}`} aria-hidden="true" />{label}
  </span>;
}

const typeLabels: Record<string, string> = {
  prompt: 'Prompt',
  plugin: 'Plugin',
};

// Bare icon-only entry point to the same plugin detail page as PluginBadge
// (below) — sits in the card's top-right corner, left of the favorite star,
// so the marketplace link is reachable without reading the bottom-row text
// pill. Same stopPropagation reasoning as PluginBadge.
function MarketplaceIconButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title="Show Marketplace Detail Page"
      className="p-1 rounded-md bg-panel text-fg-dim hover:text-fg hover:bg-inset transition-colors"
    >
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 21v-7.5a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 .75.75V21m-4.5 0H2.36m11.14 0H18m0 0h3.64m-1.39 0V9.349M3.75 21V9.349m0 0a3.001 3.001 0 0 0 3.75-.615A2.993 2.993 0 0 0 9.75 9.75c.896 0 1.7-.393 2.25-1.016a2.993 2.993 0 0 0 2.25 1.016c.896 0 1.7-.393 2.25-1.016a3.001 3.001 0 0 0 3.75.614m-16.5 0a3.004 3.004 0 0 1-.621-4.72l1.189-1.19A1.5 1.5 0 0 1 5.378 3h13.243a1.5 1.5 0 0 1 1.06.44l1.19 1.189a3 3 0 0 1-.621 4.72M6.75 18h3.75a.75.75 0 0 0 .75-.75V13.5a.75.75 0 0 0-.75-.75H6.75a.75.75 0 0 0-.75.75v3.75c0 .414.336.75.75.75Z" />
      </svg>
    </button>
  );
}

// Clickable plugin-name pill. Shared between the source tag and this pill so
// the click-to-plugin-detail affordance looks identical everywhere. stops
// propagation so the card's own onClick doesn't also fire.
function PluginBadge({ name, onClick }: PluginBadgeProps) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={`Open ${name}`}
      className={`text-4xs font-medium px-1 py-0.5 rounded-sm shrink-0 ${IDENTITY_BADGE} hover:bg-accent/25 transition-colors truncate max-w-[120px]`}
    >
      {name}
    </button>
  );
}

// Fallback tag used when a skill has no marketplace plugin parent (self-
// authored skills, youcoded-core bare skills).
function SourceTag({ skill }: { skill: SkillEntry }) {
  const label = skill.source === 'youcoded-core'
    ? 'YC'
    : (typeLabels[skill.type] ?? 'Plugin');
  return (
    <span className={`text-4xs font-medium px-1 py-0.5 rounded-sm shrink-0 ${IDENTITY_BADGE}`}>
      {label}
    </span>
  );
}

// Latest handlers, read through a ref — the "RowMemo" pattern ResumeBrowser's
// RowMemo/rowActions.current uses. CommandDrawer.renderSkillCard rebuilds
// `onClick`/`favorite`/`pluginBadge` as fresh closures on every render (see
// CommandDrawer.tsx:167-192), so a naive default-compare memo would re-render
// every card on every chat-store dispatch (the v1.2.2 drawer flicker this
// file used to fix with a comparator that IGNORED handler identity — which
// meant a skipped render could go on calling a stale onToggle/onClick
// forever, since nothing ever refreshed it).
type Handlers = {
  onClick: (skill: SkillEntry) => void;
  onToggle?: () => void;
  onPluginClick?: () => void;
};

// Root is a <div role="button"> with `relative` so the FavoriteStar (itself a
// <button>) can sit inside without an outer wrapper distorting the drawer
// grid's flex sizing, and without nesting a button in a button. Content is
// uniform (displayName + description + badge), so no fixed height is needed —
// every tile is naturally the same shape.
//
// This card had a second `variant="marketplace"` branch until 2026-07-22. It
// was unreachable: CommandDrawer is the only importer and never passed the
// prop, and LibraryScreen's similarly-named renderSkillCard actually renders a
// MarketplaceCard. Deleted rather than migrated — MarketplaceCard owns the
// marketplace card. See spec §14.2.
//
// Reads every handler through `handlersRef` instead of taking them as props
// directly, so it is safe to memoize on DATA alone (skill/favoriteFilled/
// pluginName) with React's default shallow compare — no custom comparator.
// A skipped render still fires the newest handler: `handlersRef.current` is
// refreshed by the OUTER SkillCard below on every one of ITS renders, and the
// outer component is never memoized, so it runs on every CommandDrawer
// render even when this inner one is skipped.
function SkillCardImpl({ skill, handlersRef, hasFavorite, favoriteFilled, hasPluginBadge, pluginName, availabilityPreview }: {
  skill: SkillEntry;
  handlersRef: React.RefObject<Handlers>;
  hasFavorite: boolean;
  favoriteFilled: boolean;
  hasPluginBadge: boolean;
  pluginName?: string;
  availabilityPreview?: 'automatic' | 'manual';
}) {
  const onCardClick = () => handlersRef.current.onClick(skill);
  const onPluginClick = () => handlersRef.current.onPluginClick?.();
  const onFavoriteToggle = () => handlersRef.current.onToggle?.();
  const badge = hasPluginBadge && pluginName
    ? <PluginBadge name={pluginName} onClick={onPluginClick} />
    : <SourceTag skill={skill} />;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onCardClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCardClick(); } }}
      // Change 22: .layer-surface replaces `bg-panel border border-edge-dim`.
      // The two overrides are load-bearing, not stylistic — .layer-surface is
      // --radius-xl with a `0 8px 32px` shadow, and this grid is flat by
      // decision (mixed elevation in one grid read as inconsistent, user
      // feedback 2026-07-08). Same pair FilesTab's doc cards use.
      className="relative layer-surface !rounded-lg card-interactive p-3 text-left flex flex-col cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      style={{ boxShadow: 'none' }}
    >
      {(hasFavorite || hasPluginBadge) && (
        // Each icon carries its OWN bg-panel + hover:bg-inset — two distinct
        // bare icons, not one shared pill. (A single background behind both
        // read as one button when hovering the card — rejected 2026-09-06.)
        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
          {hasPluginBadge && <MarketplaceIconButton onClick={onPluginClick} />}
          {hasFavorite && (
            <FavoriteStar size="sm" bg filled={favoriteFilled} onToggle={onFavoriteToggle} />
          )}
        </div>
      )}
      <span className="text-sm font-medium text-fg leading-tight">{skill.displayName}</span>
      <span className="text-2xs text-fg-muted mt-1 leading-snug line-clamp-2 flex-1">{skill.description}</span>
      {/* WHY: the shipped card keeps master's exact markup; only the workbench
          preview (which passes availabilityPreview) gets the chip row. */}
      {availabilityPreview ? <div className="mt-2 flex w-full flex-wrap items-center gap-1.5">{badge}
        <span className="ml-auto"><AvailabilityPreviewChip kind={availabilityPreview} /></span>
      </div> : <div className="mt-2 self-start">{badge}</div>}
    </div>
  );
}

// Default shallow compare (no custom comparator) is now SAFE: `handlersRef`
// is the SAME ref object on every render of the outer SkillCard below (only
// its `.current` mutates), and the rest are primitives/skill's own identity —
// exactly "data props only", as intended.
const SkillCardMemo = React.memo(SkillCardImpl);

// Outer, UNMEMOIZED wrapper — called fresh on every CommandDrawer render
// (like ResumeBrowser itself, which owns rowActions.current). Its only job is
// keeping handlersRef current so SkillCardMemo can skip re-rendering on data
// alone without ever risking a stale click handler.
function SkillCard({ skill, onClick, favorite, pluginBadge, availabilityPreview }: Props) {
  const handlersRef = useRef<Handlers>({ onClick, onToggle: favorite?.onToggle, onPluginClick: pluginBadge?.onClick });
  handlersRef.current = { onClick, onToggle: favorite?.onToggle, onPluginClick: pluginBadge?.onClick };
  return (
    <SkillCardMemo
      skill={skill}
      handlersRef={handlersRef}
      hasFavorite={favorite != null}
      favoriteFilled={favorite?.filled ?? false}
      hasPluginBadge={pluginBadge != null}
      pluginName={pluginBadge?.name}
      availabilityPreview={availabilityPreview}
    />
  );
}

export default SkillCard;
