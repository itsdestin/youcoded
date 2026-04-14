// Unified card for skill + theme discovery. Replaces per-type SkillCard/
// ThemeCard in the new marketplace layout. Kept compact; the detail overlay
// carries the heavy content.

import React from "react";
import type { SkillEntry, SkillComponents } from "../../../shared/types";
import type { ThemeRegistryEntryWithStatus } from "../../../shared/theme-marketplace-types";
import { useMarketplaceStats } from "../../state/marketplace-stats-context";
import StarRating from "./StarRating";

export type MarketplaceCardEntry =
  | { kind: "skill"; entry: SkillEntry }
  | { kind: "theme"; entry: ThemeRegistryEntryWithStatus };

interface Props {
  item: MarketplaceCardEntry;
  onOpen(): void;
  installed?: boolean;
  updateAvailable?: boolean;
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

export default function MarketplaceCard({ item, onOpen, installed, updateAvailable }: Props) {
  const stats = useMarketplaceStats();

  const id = item.kind === "skill" ? item.entry.id : `theme:${item.entry.slug}`;
  const pluginStats = item.kind === "skill" ? stats.plugins[item.entry.id] : undefined;
  const themeStats = item.kind === "theme" ? stats.themes[item.entry.slug] : undefined;
  // Plugin and theme stats shapes differ on the Worker side; plugins expose
  // installs + reviews, themes expose a like count. Missing keys default to 0.
  const installs = pluginStats?.installs ?? 0;
  const rating = pluginStats?.rating;
  const ratingCount = pluginStats?.review_count ?? 0;
  const likes = themeStats?.likes ?? 0;

  const title = item.kind === "skill" ? item.entry.displayName : item.entry.name;
  const author = item.kind === "skill" ? (item.entry.author || "") : (item.entry.author || "");
  // Theme preview PNG (uploaded/regenerated on theme publish). Tokens are the
  // fallback; when the full preview exists it reads much more like "this is
  // what you'll get" than a 7-swatch strip.
  const themePreviewUrl = item.kind === "theme" ? item.entry.preview : undefined;
  // Prefer tagline when the override supplies one; falls back to the raw
  // description so cards never appear blank.
  const blurb = item.kind === "skill"
    ? (item.entry.tagline || item.entry.description || "")
    : (item.entry.description || "");
  const peek = item.kind === "skill" ? componentSummary(item.entry.components) : null;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="layer-surface text-left flex flex-col overflow-hidden transition-transform duration-200 hover:scale-[1.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      data-marketplace-card={id}
    >
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
        <div className="min-w-0">
          <h3 className="font-medium text-fg truncate">{title}</h3>
          {author && <p className="text-xs text-fg-dim truncate">{author}</p>}
        </div>
        {installed && (
          <span className="text-[10px] uppercase tracking-wide text-fg-dim shrink-0 mt-0.5">
            {updateAvailable ? "Update" : "Installed"}
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
    </button>
  );
}
