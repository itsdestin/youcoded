// Unified card for skill + theme + plugin discovery. Corner affordance
// cycles through three states (install / installing / favorited) via
// InstallFavoriteCorner; integrations render through the same component via
// optional iconUrl + accentColor props (no separate IntegrationCard).

import React, { useId, useState } from "react";
import type { SkillEntry, SkillComponents } from "../../../shared/types";
import type { ThemeRegistryEntryWithStatus } from "../../../shared/theme-marketplace-types";
import { useMarketplaceStats } from "../../state/marketplace-stats-context";
import { useMarketplace } from "../../state/marketplace-context";
import StarRating from "./StarRating";
import InstallFavoriteCorner from "./InstallFavoriteCorner";

export type MarketplaceCardEntry =
  | { kind: "skill"; entry: SkillEntry }
  | { kind: "theme"; entry: ThemeRegistryEntryWithStatus };

interface Props {
  item: MarketplaceCardEntry;
  onOpen(): void;
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
const STATUS_TONE_CLASS: Record<'ok' | 'warn' | 'err' | 'neutral' | 'locked', string> = {
  ok: 'bg-green-500/15 text-green-400 border border-green-500/30',
  warn: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
  err: 'bg-red-500/15 text-red-400 border border-red-500/30',
  neutral: 'bg-inset text-fg-2 border border-edge',
  // Platform-blocked — muted slate reading as "not for this platform" without
  // the alarm of err/warn. Distinct from neutral so "macOS Only" doesn't blur
  // into "Coming soon".
  locked: 'bg-slate-500/10 text-fg-dim border border-slate-500/30',
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

export default function MarketplaceCard({ item, onOpen, installed, updateAvailable, iconUrl, accentColor, suppressCorner, statusBadge, pluginBadge, compact }: Props) {
  const stats = useMarketplaceStats();
  const mp = useMarketplace();
  const kind = item.kind;
  const installKey = kind === "theme" ? `theme:${item.entry.slug}` : item.entry.id;
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

  const toggleFavorite = () => {
    if (kind === "theme") mp.favoriteTheme(item.entry.slug, !isFavorited).catch(() => {});
    else mp.setFavorite(item.entry.id, !isFavorited).catch(() => {});
  };

  const install = () => {
    if (kind === "theme") mp.installTheme(item.entry.slug).catch(() => {});
    else mp.installSkill(item.entry.id).catch(() => {});
  };

  const id = item.kind === "skill" ? item.entry.id : `theme:${item.entry.slug}`;
  const pluginStats = item.kind === "skill" ? stats.plugins[item.entry.id] : undefined;
  const themeStats = item.kind === "theme" ? stats.themes[item.entry.slug] : undefined;
  const installs = pluginStats?.installs ?? 0;
  const rating = pluginStats?.rating;
  const ratingCount = pluginStats?.review_count ?? 0;
  const likes = themeStats?.likes ?? 0;

  const title = item.kind === "skill" ? item.entry.displayName : item.entry.name;
  const author = item.kind === "skill" ? (item.entry.author || "") : (item.entry.author || "");
  const themePreviewUrl = item.kind === "theme" ? item.entry.preview : undefined;
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
    const compactStatus: { text: string; tone: 'ok' | 'warn' | 'err' | 'neutral' | 'locked' } | null = statusBadge
      ? statusBadge
      : isLocalTheme
        ? { text: 'Local', tone: 'neutral' }
        : isInstalling
          ? { text: 'Installing…', tone: 'neutral' }
          : updateAvailable
            ? { text: 'Update', tone: 'warn' }
            : isInstalled
              ? { text: 'Installed', tone: 'neutral' }
              : null;

    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
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
              <img src={themePreviewUrl!} alt="" className="w-full h-full object-cover" loading="lazy" />
            )}
          </div>
        )}

        {/* Center column. min-w-0 is load-bearing — without it the truncate
            below stops working because the flex item can grow past parent. */}
        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-fg truncate">{title}</h3>
          {author && <p className="text-xs text-fg-dim truncate">{author}</p>}
          {blurb && <p className="text-xs text-fg-2 line-clamp-2">{blurb}</p>}
          {(rating != null && ratingCount > 0) || installs > 0 || likes > 0 ? (
            <div className="mt-1 flex items-center gap-3 text-xs text-fg-dim">
              {rating != null && ratingCount > 0 && (
                <StarRating value={rating} count={ratingCount} size="sm" />
              )}
              {installs > 0 && <span>{installs.toLocaleString()} installs</span>}
              {likes > 0 && <span>{likes.toLocaleString()} likes</span>}
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
          {compactStatus && (
            <span
              className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ${STATUS_TONE_CLASS[compactStatus.tone]}`}
            >
              {compactStatus.text}
            </span>
          )}
          {!suppressCorner && kind === 'skill' && !isInstalled && !isInstalling && (
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
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="relative layer-surface text-left flex flex-col overflow-hidden transition-transform duration-200 hover:scale-[1.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      data-marketplace-card={id}
      style={accentColor ? { borderColor: accentColor } : undefined}
    >
      {/* Corner affordance — install → spinner → favorite star, all at the
          same absolute coordinates. Themes skip the install affordance so the
          corner is only wired for skills. Integrations opt out entirely via
          suppressCorner since their install/connect flow goes through onOpen. */}
      {!suppressCorner && (
        kind === "skill" ? (
          <InstallFavoriteCorner
            installed={isInstalled}
            installing={isInstalling}
            favorited={isFavorited}
            onInstall={install}
            onToggleFavorite={toggleFavorite}
          />
        ) : (
          isInstalled && (
            <InstallFavoriteCorner
              installed
              installing={isInstalling}
              favorited={isFavorited}
              onInstall={install}
              onToggleFavorite={toggleFavorite}
            />
          )
        )
      )}
      {themePreviewUrl && (
        <img
          src={themePreviewUrl}
          alt=""
          loading="lazy"
          className="w-full h-36 object-cover border-b border-edge-dim"
        />
      )}
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
            {author && <p className="hidden sm:block text-xs text-fg-dim truncate">{author}</p>}
            {isLocalTheme && (
              <div className="mt-1 inline-flex items-center gap-1 group relative">
                <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/30">
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
        {statusBadge ? (
          <span
            className={`relative z-10 text-[10px] uppercase tracking-wide shrink-0 mt-0.5 px-2 py-0.5 rounded-full ${STATUS_TONE_CLASS[statusBadge.tone]}`}
          >
            {statusBadge.text}
          </span>
        ) : (isInstalling || updateAvailable || isInstalled) && (
          <span
            className={`relative z-10 text-[10px] uppercase tracking-wide shrink-0 mt-0.5 px-2 py-0.5 rounded-full ${
              isInstalling
                ? 'text-accent border border-accent/50 bg-accent/10 animate-pulse'
                : 'text-fg-dim'
            }`}
          >
            {isInstalling ? 'Installing…' : updateAvailable ? 'Update' : 'Installed'}
          </span>
        )}
      </div>
      {blurb && <p className="text-xs text-fg-2 line-clamp-2">{blurb}</p>}
      {/* Plugin-name badge — jumps to the parent plugin's detail page.
          Only rendered for skills that belong to a marketplace plugin;
          stopPropagation prevents the card's own onClick from firing. */}
      {pluginBadge && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); pluginBadge.onClick(); }}
          title={`Open ${pluginBadge.name}`}
          className="self-start text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0 bg-accent/10 text-accent border border-accent/30 hover:bg-accent/20 transition-colors truncate max-w-full"
        >
          {pluginBadge.name}
        </button>
      )}
      <div className="mt-auto flex items-center gap-2 sm:gap-3 text-xs text-fg-dim pt-1 min-w-0">
        {/* Author appears here at narrow only — keeps the byline visible without
            spending a whole row on it. Hidden at sm+ since it has its own line
            under the title up top. */}
        {author && <span className="sm:hidden text-fg-dim truncate">{author}</span>}
        {rating != null && ratingCount > 0 && (
          <StarRating value={rating} count={ratingCount} size="sm" />
        )}
        {installs > 0 && <span className="shrink-0">{installs.toLocaleString()} installs</span>}
        {likes > 0 && <span className="shrink-0">{likes.toLocaleString()} likes</span>}
        {/* Component peek (e.g. "2 skills · 3 commands") is wide-only —
            saves a row at narrow where space is tight. */}
        {peek && <span className="hidden sm:inline text-fg-muted truncate">{peek}</span>}
      </div>
      </div>
    </div>
  );
}
