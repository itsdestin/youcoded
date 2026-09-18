// Unified card for skill + theme + plugin discovery. Corner affordance
// cycles through three states (install / installing / favorited) via
// InstallFavoriteCorner; integrations render through the same component via
// optional iconUrl + accentColor props (no separate IntegrationCard).

import { memo, useId, useState } from "react";
import type { SkillEntry, SkillComponents } from "../../../shared/types";
import type { ThemeRegistryEntryWithStatus } from "../../../shared/theme-marketplace-types";
import { useMarketplaceStats } from "../../state/marketplace-stats-context";
import { useMarketplace, installTrackingKey } from "../../state/marketplace-context";
// P-21 #3: "1 installs" / "1 likes" — counts go through the shared pluraliser.
import { plural } from "../../../shared/plural";
import InstallFavoriteCorner from "./InstallFavoriteCorner";
// Task 1: the "Update" corner is a real button now — see UpdateButton.tsx for
// why it had to become a shared component.
import UpdateButton from "./UpdateButton";
// Marketplace overhaul (2026-08-27): origin + scan badges, risky-capability
// glyphs and the thumbs summary replace the star rating on every card.
import { ScanBadge, AuthorBadge } from "./TrustBadges";
import { capabilityLine } from "./CapabilityList";
import { ThumbsSummary } from "./FeedbackSection";
import { CATALOG_TYPE_LABEL, isInstallableSource } from "../../../shared/catalog-types";

export type MarketplaceCardEntry =
  | { kind: "skill"; entry: SkillEntry }
  | { kind: "theme"; entry: ThemeRegistryEntryWithStatus };

interface Props {
  item: MarketplaceCardEntry;
  // Task 8 (render-cost consolidation 2026-09-18): takes the card's OWN id
  // (this card's `id` local below — bare skill id, or `theme:<slug>`) rather
  // than being called with none. The card is memoized (see the `export
  // default` below); a per-row list now hands every card the SAME onOpen
  // reference and lets each one report which row it is, instead of a fresh
  // `() => open(id)` closure per row that would defeat the memo every render.
  onOpen(id: string): void;
  installed?: boolean;
  updateAvailable?: boolean;
  /** Optional custom icon (integrations). Renders top-left inside the tile. */
  iconUrl?: string;
  /** Optional accent border color (integrations). */
  accentColor?: string;
  /** Integrations handle install/connect through their own flow (handleIntegration
   *  routed via onOpen) — hide the corner download/favorite affordance in that case. */
  suppressCorner?: boolean;
  /** Override the default Installed/Update/Installing badge with an explicit
   *  status pill. Used by integrations whose state ("Coming soon", "Needs
   *  auth", "Connected", "Error", "Deprecated", "Not installed") doesn't
   *  fit the generic plugin state vocabulary. */
  statusBadge?: {
    text: string;
    tone: 'ok' | 'warn' | 'err' | 'neutral' | 'locked';
  };
  /** When provided, renders a clickable pill showing the parent plugin's
   *  marketplace displayName. Clicking jumps to that plugin's detail page.
   *  Used by the CommandDrawer + Library skill cards so users can identify
   *  which plugin a skill belongs to and navigate to it. */
  pluginBadge?: {
    name: string;
    onClick: () => void;
  };
  /** When true, render as a horizontal list row optimized for narrow viewports.
   *  Used by MarketplaceGrid below 640px. Rails always pass false (omit). */
  compact?: boolean;
}

// Tone-class map copied from the retired IntegrationCard.tsx so integrations
// keep their status-pill colors after the IntegrationCard → MarketplaceCard
// consolidation. Status colors are intentionally hardcoded (not theme tokens)
// since green/amber/red carry semantic meaning independent of the active theme.
export const STATUS_TONE_CLASS: Record<'ok' | 'warn' | 'err' | 'neutral' | 'locked', string> = {
  ok: 'bg-green-500/15 text-green-400 border border-green-500/30',
  warn: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
  err: 'bg-red-500/15 text-red-400 border border-red-500/30',
  neutral: 'bg-inset text-fg-2 border border-edge',
  // Platform-blocked — reads as "not for this platform" without the alarm of
  // err/warn. Change 24: was `bg-slate-500/10 border-slate-500/30`, a stock
  // Tailwind hue that ignored the theme; the inset/edge tokens give the same
  // recessed reading on all 11 themes. Still distinct from `neutral` (which is
  // solid bg-inset + fg-2) so "macOS Only" doesn't blur into "Coming soon".
  locked: 'bg-inset/50 text-fg-dim border border-edge',
};

function componentSummary(c: SkillComponents | null | undefined): string | null {
  if (!c) return null;
  const parts: string[] = [];
  if (c.skills.length) parts.push(`${c.skills.length} skill${c.skills.length > 1 ? "s" : ""}`);
  if (c.commands.length) parts.push(`${c.commands.length} command${c.commands.length > 1 ? "s" : ""}`);
  if (c.hooks.length || c.hasHooksManifest) parts.push(`${c.hooks.length || "manifest"} hook${c.hooks.length === 1 ? "" : "s"}`);
  if (c.agents.length) parts.push(`${c.agents.length} agent${c.agents.length > 1 ? "s" : ""}`);
  if (c.mcpServers.length || c.hasMcpConfig) parts.push("MCP");
  return parts.join(" · ") || null;
}

function MarketplaceCard({ item, onOpen, installed, updateAvailable, iconUrl, accentColor, suppressCorner, statusBadge, pluginBadge, compact }: Props) {
  const stats = useMarketplaceStats();
  const mp = useMarketplace();
  const kind = item.kind;
  // Fix: this used to be the BARE marketplace id for a plugin, while
  // marketplace-context records progress under `skill:<id>` — so the lookup
  // below never matched and a plugin install showed no "Installing…" state
  // at all. Both sides now build the key with the same helper.
  const installKey = kind === "theme"
    ? installTrackingKey("theme", item.entry.slug)
    : installTrackingKey("skill", item.entry.id);
  const isInstalling = mp.installingIds.has(installKey);
  const isFavorited =
    kind === "theme"
      ? mp.themeFavorites.includes(item.entry.slug)
      : mp.favorites.includes(item.entry.id);
  const isInstalled = !!installed;
  // Derived: true only when this card represents a locally-built theme (not in marketplace).
  const isLocalTheme = item.kind === 'theme' && !!item.entry.isLocal;
  const localTooltipId = useId();
  const [iconFailed, setIconFailed] = useState(false);
  // Task 3: a theme preview that fails to download used to leave a blank grey
  // band with no fallback and no retry (ROADMAP: Devil's Garden, Kuromi
  // Dreamer). Every other <img> on this card already had an onError; this one
  // did not, so any hiccup fetching the PNG was permanent and silent.
  const [themePreviewFailed, setThemePreviewFailed] = useState(false);

  const toggleFavorite = () => {
    if (kind === "theme") mp.favoriteTheme(item.entry.slug, !isFavorited).catch(() => {});
    else mp.setFavorite(item.entry.id, !isFavorited).catch(() => {});
  };

  const install = () => {
    if (kind === "theme") mp.installTheme(item.entry.slug).catch(() => {});
    else mp.installSkill(item.entry.id).catch(() => {});
  };

  const id = item.kind === "skill" ? item.entry.id : `theme:${item.entry.slug}`;
  // What mp.update() wants: the bare marketplace id for a plugin, the bare slug
  // for a theme (it adds the `theme:` prefix itself).
  const updateId = item.kind === "skill" ? item.entry.id : item.entry.slug;
  // The corner offers Update whenever one is available — except on integrations
  // (they supply their own statusBadge) and local themes, which have no
  // marketplace copy to update from.
  const showUpdateAction = !!updateAvailable && !statusBadge && !isLocalTheme;
  const pluginStats = item.kind === "skill" ? stats.plugins[item.entry.id] : undefined;
  const themeStats = item.kind === "theme" ? stats.themes[item.entry.slug] : undefined;
  // Task 22: a theme's downloads live under themes[slug], not plugins[] — the
  // Worker counts them from a separate `theme:<slug>` id. Reading only
  // pluginStats meant a theme card's count was always 0, so it never rendered.
  const installs = (item.kind === "theme" ? themeStats?.installs : pluginStats?.installs) ?? 0;
  const likes = themeStats?.likes ?? 0;
  const author = item.entry.author || "";
  // Overhaul: the catalog block (absent on pre-overhaul rows → no badges).
  const catalog = item.kind === "skill" ? item.entry.catalog : undefined;
  // A non-bundle kind gets its name in the byline ("Skill · Anthropic") so a
  // split view says what each card IS; bundles stay unlabeled like today.
  const typeLabel = catalog && catalog.itemType !== "plugin" ? CATALOG_TYPE_LABEL[catalog.itemType].one : null;
  const thumbs = pluginStats ? <ThumbsSummary up={pluginStats.thumbs_up} down={pluginStats.thumbs_down} /> : null;
  // Round 2: safety first, then who made it; the risky abilities as words.
  const trust = catalog ? (
    <div className="flex items-center gap-1 flex-nowrap min-w-0" data-trust>
      <ScanBadge scan={catalog.scan} responsiveLabel />
      {/* 2026-08-31: the source chip moved to the detail page. On a card it was a
          third chip competing with the two that answer what you actually ask while
          scanning a grid — is this safe, and who made it. Where it was mirrored from
          matters when you are deciding to install, which is the detail page. */}
      {/* Round 3: the author is a chip here, not a grey line under the title. */}
      {author && <AuthorBadge author={author} />}
    </div>
  ) : null;
  // Task 21: a row the installer cannot take gets no Install affordance at all —
  // the detail overlay offers "Open source" instead. Themes are always
  // installable, so this only gates the skill side.
  // `!isInstalled` is load-bearing: an ALREADY-installed item is described by the
  // locally scanned entry, which carries no sourceType at all, and this must not
  // strip its favorite star (the corner's installed state) on that account.
  const notInstallable = kind === "skill" && !isInstalled && !isInstallableSource(item.entry);
  const corner = suppressCorner || notInstallable ? null : kind === "skill" ? (
    <InstallFavoriteCorner inline installed={isInstalled} installing={isInstalling} favorited={isFavorited} onInstall={install} onToggleFavorite={toggleFavorite} />
  ) : isInstalled ? (
    <InstallFavoriteCorner inline installed installing={isInstalling} favorited={isFavorited} onInstall={install} onToggleFavorite={toggleFavorite} />
  ) : null;
  // Round 3: "412 installs" → a download arrow and the number; the words are
  // on hover.
  const installCount = installs > 0 ? (
    <span className="inline-flex items-center gap-1 shrink-0" title={plural(installs, "install")}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      {installs.toLocaleString()}
    </span>
  ) : null;
  const capLine = catalog ? capabilityLine(catalog.capabilities) : null;

  const title = item.kind === "skill" ? item.entry.displayName : item.entry.name;
  const themePreviewUrl = item.kind === "theme" && !themePreviewFailed ? item.entry.preview : undefined;
  // Fallback for a preview that would not load: the theme's own colours. Not a
  // screenshot, but it identifies the theme and the card stops looking broken.
  const themeTokens = item.kind === "theme" ? item.entry.previewTokens : undefined;
  const themeSwatches = item.kind === "theme" && themePreviewFailed && themeTokens && Object.keys(themeTokens).length > 0 ? (
    <div data-theme-swatches className="w-full h-36 flex border-b border-edge-dim" title={`${item.entry.name} colours — preview image unavailable`}>
      {Object.entries(themeTokens).map(([name, color]) => (
        <span key={name} className="flex-1" style={{ background: color as string }} />
      ))}
    </div>
  ) : null;
  const blurb = item.kind === "skill"
    ? (item.entry.tagline || item.entry.description || "")
    : (item.entry.description || "");
  const peek = item.kind === "skill" ? componentSummary(item.entry.components) : null;

  const showIcon = !!iconUrl && !iconFailed;

  // Compact list-row layout for narrow viewports. Outer click and keyboard
  // affordance match the wide layout so detail overlays open the same way.
  if (compact) {
    // 52x52 thumbnail rendered ONLY when we have a real image source —
    // explicit iconUrl (integrations) or themePreviewUrl (themes). When
    // neither is available (the typical skill plugin case), we drop the
    // thumbnail entirely rather than rendering a fallback letter chip;
    // a giant "S" / "M" / "Y" placeholder added more visual noise than
    // information for skill cards.
    const showThumbnail = showIcon || !!themePreviewUrl;

    // Status pill: "Local" for local themes wins over generic Installed/Update,
    // since local themes are always "installed" but the more interesting fact
    // is that they're not in the marketplace.
    // Task 1: the "Update" pill is gone from this list — an available update is
    // now a real button (rendered below), not a label that did nothing.
    const compactStatus: { text: string; tone: 'ok' | 'warn' | 'err' | 'neutral' | 'locked' } | null = statusBadge
      ? statusBadge
      : isLocalTheme
        ? { text: 'Local', tone: 'neutral' }
        : isInstalling
          ? { text: 'Installing…', tone: 'neutral' }
          : isInstalled
            ? { text: 'Installed', tone: 'neutral' }
            : null;

    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen(id);
          }
        }}
        className="layer-surface flex flex-row items-center gap-3 p-3 text-left transition-colors hover:bg-inset focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        data-marketplace-card={id}
        data-marketplace-card-compact="true"
        style={accentColor ? { borderColor: accentColor } : undefined}
      >
        {/* 52x52 thumbnail rendered only when we have a real image source
            (integration iconUrl or theme preview). Skill plugins without an
            icon get no thumbnail at all — the title carries the identity. */}
        {showThumbnail && (
          <div className="w-[52px] h-[52px] rounded-md shrink-0 overflow-hidden bg-inset flex items-center justify-center">
            {showIcon ? (
              <img src={iconUrl!} alt="" className="w-full h-full object-contain" onError={() => setIconFailed(true)} />
            ) : (
              <img src={themePreviewUrl!} alt="" className="w-full h-full object-cover" loading="lazy" onError={() => setThemePreviewFailed(true)} />
            )}
          </div>
        )}

        {/* Center column. min-w-0 is load-bearing — without it the truncate
            below stops working because the flex item can grow past parent. */}
        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-fg truncate">{title}</h3>
          {(typeLabel || (!catalog && author)) && (
            <p className="text-xs text-fg-dim truncate">{[typeLabel, catalog ? null : author].filter(Boolean).join(" · ")}</p>
          )}
          {blurb && <p className="text-xs text-fg-2 line-clamp-2">{blurb}</p>}
          {trust && <div className="mt-1">{trust}</div>}
          {thumbs || installs > 0 || likes > 0 ? (
            <div className="mt-1 flex items-center gap-3 text-xs text-fg-dim">
              {thumbs}
              {installCount}
              {likes > 0 && <span>{plural(likes, "like")}</span>}
            </div>
          ) : null}
        </div>

        {/* Right column: status pill + inline install button. The install
            button gives mobile users a one-tap install affordance without
            having to open the detail overlay first (spec §4: "inline install
            button, small download icon, 32×32 tap target"). e.stopPropagation
            prevents the card's own onOpen from firing at the same time.
            Themes route install through the detail overlay, so no inline
            install button for them. The button is sized for a 42px tap target
            via p-3 — well above WCAG 2.2's 24px minimum and close to iOS
            HIG's 44pt recommendation. */}
        <div className="shrink-0 flex flex-col items-end gap-1.5">
          {showUpdateAction ? (
            <UpdateButton id={updateId} kind={kind} />
          ) : compactStatus ? (
            <span
              className={`text-3xs uppercase tracking-wide px-2 py-0.5 rounded-full ${STATUS_TONE_CLASS[compactStatus.tone]}`}
            >
              {compactStatus.text}
            </span>
          ) : null}
          {!suppressCorner && !notInstallable && kind === 'skill' && !isInstalled && !isInstalling && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); install(); }}
              aria-label="Install"
              title="Install"
              className="p-3 rounded-md text-fg-dim hover:text-fg hover:bg-inset transition-colors"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(id);
        }
      }}
      // hover-lift replaces `transition-transform duration-200 hover:scale-[1.02]`:
      // same lift on desktop, but guarded by @media (hover: hover) so a tap on
      // Android doesn't leave the card stuck at 1.02 (spec §9.E).
      className="relative layer-surface text-left flex flex-col overflow-hidden hover-lift focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      data-marketplace-card={id}
      style={accentColor ? { borderColor: accentColor } : undefined}
    >
      {/* Corner affordance — install → spinner → favorite star, all at the
          same absolute coordinates. Themes skip the install affordance so the
          corner is only wired for skills. Integrations opt out entirely via
          suppressCorner since their install/connect flow goes through onOpen. */}
      {themePreviewUrl && (
        <img
          src={themePreviewUrl}
          alt=""
          loading="lazy"
          className="w-full h-36 object-cover border-b border-edge-dim"
          onError={() => setThemePreviewFailed(true)}
        />
      )}
      {themeSwatches}
      {/* p-3/gap-1.5 at narrow shrinks the rail tile so 2-3 fit on a phone screen
          without losing the visual-card feel. Wide stays at p-4/gap-2. */}
      <div className="p-3 sm:p-4 flex flex-col gap-1.5 sm:gap-2 flex-1">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 sm:gap-3 min-w-0">
          {/* Integration icon — renders alongside the title, not the corner,
              so it never collides with the install/favorite affordance. */}
          {showIcon && (
            <div className="w-8 h-8 rounded-md shrink-0 overflow-hidden bg-inset flex items-center justify-center">
              <img
                src={iconUrl!}
                alt=""
                className="w-full h-full object-contain"
                onError={() => setIconFailed(true)}
              />
            </div>
          )}
          <div className="min-w-0">
            <h3 className="font-medium text-fg truncate text-sm sm:text-base">{title}</h3>
            {/* Author on its own line at sm+; at narrow we hide it here and
                render it inline with the bottom stats row to save vertical
                space — see the bottom row below. */}
            {(typeLabel || (!catalog && author)) && (
              <p className="hidden sm:block text-xs text-fg-dim truncate">{[typeLabel, catalog ? null : author].filter(Boolean).join(" · ")}</p>
            )}
            {/* Overhaul: who made it + was it checked, right under the byline
                so the two trust signals are read before the blurb. */}
            {trust && <div className="mt-1">{trust}</div>}
            {isLocalTheme && (
              <div className="mt-1 inline-flex items-center gap-1 group relative">
                <span className="text-3xs uppercase tracking-wide px-2 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/30">
                  Local
                </span>
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="text-fg-muted hover:text-fg-2 leading-none focus:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded-full"
                  aria-label="What does Local mean?"
                  aria-describedby={localTooltipId}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    <text x="8" y="11" textAnchor="middle" fontSize="9" fontWeight="600" fill="currentColor">i</text>
                  </svg>
                </button>
                {/* Tooltip — only shown on hover/focus of the (i). The group-hover on the
                     parent inline-flex handles both badge hover and the icon button. */}
                <div
                  id={localTooltipId}
                  role="tooltip"
                  className="pointer-events-none absolute top-full left-0 mt-1 w-64 z-20 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity layer-surface p-3 text-xs text-fg-2 leading-relaxed"
                >
                  Local only. Built by you with Claude — not in the marketplace, so it can't be shared or re-downloaded. Deleting it removes the files permanently. You can publish it later from the theme detail view.
                </div>
              </div>
            )}
          </div>
        </div>
        {/* Status badge — z-10 keeps it above the corner star overlay so
            Installed/Update reads fully rather than being clipped by the
            corner affordance. When the caller supplies an explicit
            statusBadge (integrations), it overrides the generic plugin-state
            vocabulary so labels like "Connected" / "Needs auth" / "Coming
            soon" can surface instead of just "Installed". */}
        <div className="flex items-center gap-1 shrink-0">
        {statusBadge ? (
          <span
            className={`relative z-10 text-3xs uppercase tracking-wide shrink-0 px-2 py-0.5 rounded-full ${STATUS_TONE_CLASS[statusBadge.tone]}`}
          >
            {statusBadge.text}
          </span>
        ) : showUpdateAction ? (
          // Task 1: this corner used to render the word "Update" inside a
          // <span> with no handler — on every card, for plugins and themes
          // alike. It is the real action now.
          <UpdateButton id={updateId} kind={kind} />
        ) : (isInstalling || isInstalled) && (
          <span
            className={`relative z-10 text-3xs uppercase tracking-wide shrink-0 px-2 py-0.5 rounded-full ${
              isInstalling
                ? 'text-accent border border-accent/50 bg-accent/10 animate-pulse'
                : 'text-fg-dim'
            }`}
          >
            {isInstalling ? 'Installing…' : 'Installed'}
          </span>
        )}
        {/* Round 3: the star / download / spinner sits in the title row right
            beside the status pill instead of floating in the corner. Themes
            only get it once installed (favorite); integrations opt out. */}
        {corner}
        </div>
      </div>
      {/* Round 2: the blurb reserves two lines even when it is one, so every
          card in a row keeps the same shape (Destin: "not symmetrical"). */}
      <p className="text-xs text-fg-2 line-clamp-2 min-h-[2rem]">{blurb}</p>
      {/* Plugin-name badge — jumps to the parent plugin's detail page.
          Only rendered for skills that belong to a marketplace plugin;
          stopPropagation prevents the card's own onClick from firing. */}
      {pluginBadge && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); pluginBadge.onClick(); }}
          title={`Open ${pluginBadge.name}`}
          className="self-start text-3xs font-medium px-2 py-0.5 rounded-full shrink-0 bg-accent/10 text-accent border border-accent/30 hover:bg-accent/20 transition-colors truncate max-w-full"
        >
          {pluginBadge.name}
        </button>
      )}
      <div className="mt-auto flex flex-col gap-1 pt-1 min-w-0">
        {/* Round 2: what it can do, as WORDS on their own line — "Runs
            commands · Uses the internet · Needs a key". Only the risky kinds,
            only when there are any; the sentences are on the detail page. */}
        {capLine && <p className="hidden sm:block text-2xs text-fg-dim truncate" title={capLine}>{capLine}</p>}
        <div className="flex items-center gap-2 sm:gap-3 text-xs text-fg-dim min-w-0">
          {/* Author appears here at narrow only — keeps the byline visible without
              spending a whole row on it. Hidden at sm+ since it has its own line
              under the title up top. */}
          {!catalog && author && <span className="sm:hidden text-fg-dim truncate">{author}</span>}
          {thumbs}
          {installCount}
          {likes > 0 && <span className="shrink-0">{plural(likes, "like")}</span>}
          {/* Component peek (e.g. "2 skills · 3 commands") is wide-only and
              right-aligned so the row reads: feedback left, contents right. */}
          {peek && <span className="hidden sm:inline text-fg-muted truncate ml-auto text-right">{peek}</span>}
        </div>
      </div>
      </div>
    </div>
  );
}

// WHY memo (Task 8, render-cost consolidation 2026-09-18): the two lists that
// now window through useChunkedReveal (MarketplaceScreen's bottom catalog and
// search grid) still redraw 50-100 cards on every parent re-render otherwise —
// mp.installingIds/mp.favorites etc. change on every install click. Memoizing
// only pays off with a stable `onOpen` (see the Props comment above); callers
// of lists that stay small (rails, Your Library) may keep inline closures —
// they cost a few dozen skipped bail-outs, not tens of thousands of elements.
export default memo(MarketplaceCard);
