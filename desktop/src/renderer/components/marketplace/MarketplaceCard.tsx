// Unified card for skill + theme + plugin discovery. Corner affordance
// cycles through three states (install / installing / favorited) via
// InstallFavoriteCorner; integrations render through the same component via
// optional iconUrl + accentColor props (no separate IntegrationCard).

import React, { useState } from "react";
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
}

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

export default function MarketplaceCard({ item, onOpen, installed, updateAvailable, iconUrl, accentColor, suppressCorner }: Props) {
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
      <div className="p-4 flex flex-col gap-2 flex-1">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-3 min-w-0">
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
            <h3 className="font-medium text-fg truncate">{title}</h3>
            {author && <p className="text-xs text-fg-dim truncate">{author}</p>}
          </div>
        </div>
        {/* Status badge — z-10 keeps it above the corner star overlay so
            Installed/Update reads fully rather than being clipped by the
            corner affordance. */}
        {(isInstalling || updateAvailable || isInstalled) && (
          <span
            className={`relative z-10 text-[10px] uppercase tracking-wide shrink-0 mt-0.5 px-2 py-0.5 rounded-full ${
              isInstalling
                ? 'text-accent border border-accent/50 bg-accent/10 animate-pulse'
                : updateAvailable
                  ? 'text-fg-dim'
                  : 'text-fg-dim'
            }`}
          >
            {isInstalling ? 'Installing…' : updateAvailable ? 'Update' : 'Installed'}
          </span>
        )}
      </div>
      {blurb && <p className="text-sm text-fg-2 line-clamp-2">{blurb}</p>}
      <div className="mt-auto flex items-center gap-3 text-xs text-fg-dim pt-1">
        {rating != null && ratingCount > 0 && (
          <StarRating value={rating} count={ratingCount} size="sm" />
        )}
        {installs > 0 && <span>{installs.toLocaleString()} installs</span>}
        {likes > 0 && <span>{likes.toLocaleString()} likes</span>}
        {peek && <span className="text-fg-muted truncate">{peek}</span>}
      </div>
      </div>
    </div>
  );
}
