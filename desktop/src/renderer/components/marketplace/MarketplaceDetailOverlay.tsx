// Unified detail overlay — replaces SkillDetail + ThemeDetail. Opens inside
// the marketplace/library screen as a layer-2 popup. Renders skill OR theme
// content from the same shell; the "What's inside" section only shows for
// skills with extracted `components` data.

import React, { useEffect, useState } from "react";
import { Scrim, OverlayPanel } from "../overlays/Overlay";
import { useMarketplace } from "../../state/marketplace-context";
import { useMarketplaceStats } from "../../state/marketplace-stats-context";
import { useMarketplaceAuth } from "../../state/marketplace-auth-context";
import { useTheme } from "../../state/theme-context";
import type { SkillEntry, SkillComponents } from "../../../shared/types";
import { isBundledPlugin, BUNDLED_REASON } from "../../../shared/bundled-plugins";
import type { ThemeRegistryEntryWithStatus } from "../../../shared/theme-marketplace-types";
import StarRating from "./StarRating";
import RatingSubmitModal from "./RatingSubmitModal";
import ReviewList from "./ReviewList";
import LikeButton from "./LikeButton";
import FileViewerOverlay, { type FileViewerTarget } from "./FileViewerOverlay";

export type DetailTarget =
  | { kind: "skill"; id: string }
  | { kind: "theme"; slug: string };

interface Props {
  target: DetailTarget;
  onClose(): void;
  // Share plumbing — App.tsx owns the ShareSheet/ThemeShareSheet components
  // so the sheet can layer above this overlay cleanly. Optional so the screen
  // works standalone in tests.
  onOpenShareSheet?(skillId: string): void;
  onOpenThemeShare?(themeSlug: string): void;
}

export default function MarketplaceDetailOverlay({
  target, onClose, onOpenShareSheet, onOpenThemeShare,
}: Props) {
  const mp = useMarketplace();
  // Needed for Apply action and isActive check in ThemeBody
  const { theme: activeThemeSlug, setTheme } = useTheme();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lookup the target in the already-fetched context. No per-overlay fetch —
  // keeps the overlay snappy and avoids cache-invalidation questions.
  let content: React.ReactNode;
  if (target.kind === "skill") {
    const entry = mp.skillEntries.find((e) => e.id === target.id)
      || mp.installedSkills.find((e) => e.id === target.id);
    if (!entry) {
      content = <NotFound label="Skill" onClose={onClose} />;
    } else {
      const installed = mp.installedSkills.some((e) => e.id === target.id);
      const favorited = mp.favorites.includes(target.id);
      const installing = mp.installingIds.has(`skill:${target.id}`);
      const errEntry = mp.installError.get(`skill:${target.id}`);
      content = (
        <SkillBody
          entry={entry}
          installed={installed}
          favorited={favorited}
          isInstalling={installing}
          installError={errEntry?.message ?? null}
          onInstall={() => mp.installSkill(entry.id).catch(() => undefined)}
          onUninstall={() => mp.uninstallSkill(entry.id).catch(() => undefined)}
          onToggleFavorite={() => mp.setFavorite(entry.id, !favorited).catch(() => undefined)}
          onShare={onOpenShareSheet ? () => onOpenShareSheet(entry.id) : undefined}
        />
      );
    }
  } else {
    const entry = mp.themeEntries.find((e) => e.slug === target.slug);
    if (!entry) {
      content = <NotFound label="Theme" onClose={onClose} />;
    } else {
      const installing = mp.installingIds.has(`theme:${target.slug}`);
      const errEntry = mp.installError.get(`theme:${target.slug}`);
      const favorited = mp.themeFavorites.includes(target.slug);
      const isActive = activeThemeSlug === target.slug;
      content = (
        <ThemeBody
          entry={entry}
          isInstalling={installing}
          installError={errEntry?.message ?? null}
          isActive={isActive}
          favorited={favorited}
          onInstall={() => mp.installTheme(entry.slug).catch(() => undefined)}
          onUninstall={() => mp.uninstallTheme(entry.slug).catch(() => undefined)}
          onApply={() => setTheme(entry.slug)}
          onToggleFavorite={() => mp.favoriteTheme(entry.slug, !favorited).catch(() => undefined)}
          onShare={onOpenThemeShare ? () => onOpenThemeShare(entry.slug) : undefined}
        />
      );
    }
  }

  return (
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        className="fixed inset-8 md:inset-16 flex flex-col overflow-hidden"
      >
        <header className="flex items-center justify-between p-4 border-b border-edge-dim">
          <h2 className="text-lg font-semibold text-fg">Details</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-fg-dim hover:text-fg text-sm px-2 py-1"
            aria-label="Close"
          >
            Esc · Close
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-6">{content}</div>
      </OverlayPanel>
    </>
  );
}

function NotFound({ label, onClose }: { label: string; onClose(): void }) {
  return (
    <div className="text-center py-12 text-fg-dim">
      <p>{label} not found in the current registry.</p>
      <button type="button" onClick={onClose} className="mt-4 underline text-fg-2">Close</button>
    </div>
  );
}

// ── Icon buttons ────────────────────────────────────────────────────────────
// Icon-only buttons for the skill/theme header. Keep small so they fit next
// to the primary Install/Uninstall action without wrapping.

function IconButton({
  onClick, title, active = false, children, ariaPressed,
}: {
  onClick?(): void;
  title: string;
  active?: boolean;
  ariaPressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      title={title}
      aria-label={title}
      aria-pressed={ariaPressed}
      className={`p-2 rounded-md border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        active
          ? "bg-accent/15 border-accent text-accent"
          : "bg-inset border-edge hover:border-edge-dim text-fg-2 hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={filled ? 0 : 1.8} strokeLinejoin="round">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.6" y1="13.5" x2="15.4" y2="17.5" />
      <line x1="15.4" y1="6.5" x2="8.6" y2="10.5" />
    </svg>
  );
}

// ── Skill body ──────────────────────────────────────────────────────────────

function SkillBody({
  entry, installed, favorited, isInstalling, installError,
  onInstall, onUninstall, onToggleFavorite, onShare,
}: {
  entry: SkillEntry;
  installed: boolean;
  favorited: boolean;
  isInstalling: boolean;
  installError: string | null;
  onInstall(): void;
  onUninstall(): void;
  onToggleFavorite(): void;
  onShare?(): void;
}) {
  const stats = useMarketplaceStats();
  const pluginStats = stats.plugins[entry.id];
  const rating = pluginStats?.rating;
  const reviewCount = pluginStats?.review_count ?? 0;

  const auth = useMarketplaceAuth();
  const [ratingOpen, setRatingOpen] = useState(false);
  const [reviewRefresh, setReviewRefresh] = useState(0);
  // File viewer for items in the "What's inside" peek — nested layer-3 overlay
  // that reads local install first, remote raw URL as fallback.
  const [fileTarget, setFileTarget] = useState<FileViewerTarget | null>(null);

  return (
    <article className="flex flex-col gap-4 max-w-3xl mx-auto">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-fg">{entry.displayName}</h1>
          {entry.author && <p className="text-sm text-fg-dim">{entry.author}</p>}
          {entry.tagline && <p className="mt-2 text-base text-fg-2">{entry.tagline}</p>}
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {/* Favorite: only meaningful for installed skills (it drives the
              command drawer starred list). Gated + tooltipped when not. */}
          <IconButton
            title={
              !installed ? "Install to favorite"
                : favorited ? "Unfavorite" : "Favorite"
            }
            active={favorited}
            ariaPressed={favorited}
            onClick={installed ? onToggleFavorite : undefined}
          >
            <StarIcon filled={favorited} />
          </IconButton>
          {/* Share: link + QR. ShareSheet needs local files, so gated on
              installed — matches legacy marketplace behavior. */}
          <IconButton
            title={installed ? "Share link · QR" : "Install to share"}
            onClick={installed && onShare ? onShare : undefined}
          >
            <ShareIcon />
          </IconButton>
          {isInstalling ? (
            <button
              type="button"
              disabled
              className="px-4 py-2 rounded-md bg-accent/70 text-on-accent cursor-wait flex items-center gap-2"
            >
              <span className="inline-block w-3 h-3 border-2 border-on-accent border-t-transparent rounded-full animate-spin" />
              Installing…
            </button>
          ) : installed ? (
            // Bundled plugins ship with YouCoded — disable the Uninstall
            // button + show the reason on hover. The IPC handler also rejects
            // bundled IDs, but disabling here gives users the right signal
            // before they even click.
            (() => {
              const bundled = isBundledPlugin(entry.id);
              return (
                <button
                  type="button"
                  onClick={onUninstall}
                  disabled={bundled}
                  title={bundled ? BUNDLED_REASON : undefined}
                  className="px-4 py-2 rounded-md bg-inset text-fg border border-edge hover:border-edge-dim disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-edge"
                >
                  Uninstall
                </button>
              );
            })()
          ) : (
            <button
              type="button"
              onClick={onInstall}
              className={`px-4 py-2 rounded-md bg-accent text-on-accent hover:opacity-90 ${installError ? 'ring-2 ring-red-500' : ''}`}
              title={installError || undefined}
            >
              {installError ? 'Retry Install' : 'Install'}
            </button>
          )}
        </div>
      </header>

      {/* Tags + audience + life area — only render when at least one is set,
          so legacy entries without these fields don't get an empty row. */}
      <MetadataChips entry={entry} />

      {entry.longDescription ? (
        <section>
          <h2 className="text-sm uppercase tracking-wide text-fg-dim mb-2">About</h2>
          <div className="prose prose-sm max-w-none text-fg-2 whitespace-pre-wrap">
            {entry.longDescription}
          </div>
        </section>
      ) : (
        <p className="text-fg-2">{entry.description}</p>
      )}

      <ComponentsPeek
        components={entry.components}
        onOpenFile={(kind, name) => setFileTarget({
          pluginId: entry.id,
          pluginName: entry.displayName,
          kind,
          name,
        })}
      />

      {/* Reviews section — shown for all marketplace skills. Write button
          gated behind signed-in + installed (server also enforces this). */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <h2 className="text-sm uppercase tracking-wide text-fg-dim">Reviews</h2>
            {rating != null && reviewCount > 0 && (
              <StarRating value={rating} count={reviewCount} size="sm" />
            )}
          </div>
          <button
            type="button"
            onClick={() => setRatingOpen(true)}
            disabled={!installed || !auth.signedIn}
            className="text-sm px-3 py-1 rounded-md border border-edge-dim hover:border-edge text-fg-2 hover:text-fg disabled:opacity-50 disabled:cursor-not-allowed"
            title={
              !installed ? "Install to review"
                : !auth.signedIn ? "Sign in to review"
                : "Write a review"
            }
          >
            Write a review
          </button>
        </div>
        <ReviewList pluginId={entry.id} refreshKey={reviewRefresh} />
      </section>

      <RatingSubmitModal
        pluginId={entry.id}
        open={ratingOpen}
        onClose={() => setRatingOpen(false)}
        onSubmitted={() => setReviewRefresh((n) => n + 1)}
      />

      {entry.repoUrl && (
        <footer className="text-xs text-fg-dim">
          Source: <a className="underline" href={entry.repoUrl} target="_blank" rel="noreferrer">{entry.repoUrl}</a>
        </footer>
      )}

      {fileTarget && (
        <FileViewerOverlay
          target={fileTarget}
          onClose={() => setFileTarget(null)}
        />
      )}
    </article>
  );
}

// Small chip row — tags (hash-style), audience, and life areas. Only renders
// when at least one field is populated.
function MetadataChips({ entry }: { entry: SkillEntry }) {
  const tags = entry.tags || [];
  const lifeAreas = entry.lifeArea || [];
  const hasAudience = !!entry.audience;
  if (!tags.length && !lifeAreas.length && !hasAudience) return null;

  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {tags.map((t) => (
        <span key={`tag-${t}`} className="text-xs px-2 py-0.5 rounded-full bg-inset text-fg-2 border border-edge-dim">
          #{t}
        </span>
      ))}
      {lifeAreas.map((a) => (
        <span key={`area-${a}`} className="text-xs px-2 py-0.5 rounded-full bg-accent/10 text-fg border border-accent/30 capitalize">
          {a}
        </span>
      ))}
      {hasAudience && (
        <span className="text-xs px-2 py-0.5 rounded-full bg-inset text-fg-dim border border-edge-dim">
          {entry.audience === "developer" ? "For developers" : "For everyone"}
        </span>
      )}
    </div>
  );
}

function ComponentsPeek({
  components,
  onOpenFile,
}: {
  components?: SkillComponents | null;
  onOpenFile(kind: "skill" | "command" | "agent", name: string): void;
}) {
  // `null` = extraction failed — hide the peek entirely (don't alarm the user
  // with a scary error message). `undefined` = pre-Phase-1 cached entry;
  // same hide behavior. Empty object = plugin genuinely has nothing.
  if (!components) return null;

  // Clickable kinds open the in-app file viewer. Hooks + MCP servers aren't
  // markdown files — they stay as plain text lines.
  const clickable: Array<{ label: string; kind: "skill" | "command" | "agent"; items: string[] }> = [
    { label: "Skills", kind: "skill" as const, items: components.skills },
    { label: "Commands", kind: "command" as const, items: components.commands },
    { label: "Agents", kind: "agent" as const, items: components.agents },
  ].filter((s) => s.items.length > 0);

  const textOnly: Array<[string, string[]]> = [
    ["Hooks", components.hooks],
    ["MCP servers", components.mcpServers],
  ].filter(([, arr]) => arr.length > 0) as Array<[string, string[]]>;

  if (!clickable.length && !textOnly.length && !components.hasHooksManifest && !components.hasMcpConfig) return null;

  return (
    <section>
      <h2 className="text-sm uppercase tracking-wide text-fg-dim mb-2">What's inside</h2>
      <div className="layer-surface p-3 flex flex-col gap-2 text-sm">
        {clickable.map(({ label, kind, items }) => (
          <div key={label} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-fg-dim">{label}:</span>
            {items.map((name, i) => (
              <React.Fragment key={name}>
                <button
                  type="button"
                  onClick={() => onOpenFile(kind, name)}
                  className="text-fg-2 hover:text-accent underline decoration-dotted underline-offset-2"
                  title={`View ${name}`}
                >
                  {name}
                </button>
                {i < items.length - 1 && <span className="text-fg-dim">,</span>}
              </React.Fragment>
            ))}
          </div>
        ))}
        {textOnly.map(([label, items]) => (
          <div key={label}>
            <span className="text-fg-dim">{label}:</span>{" "}
            <span className="text-fg-2">{items.join(", ")}</span>
          </div>
        ))}
        {components.hasHooksManifest && !components.hooks.length && (
          <div className="text-fg-dim">Hooks configured via hooks-manifest.json</div>
        )}
        {components.hasMcpConfig && !components.mcpServers.length && (
          <div className="text-fg-dim">MCP servers via .mcp.json</div>
        )}
      </div>
    </section>
  );
}

// ── Theme body ──────────────────────────────────────────────────────────────

function ThemeBody({
  entry, isInstalling, installError, isActive, favorited,
  onInstall, onUninstall, onApply, onToggleFavorite, onShare,
}: {
  entry: ThemeRegistryEntryWithStatus;
  isInstalling: boolean;
  installError: string | null;
  isActive: boolean;
  favorited: boolean;
  onInstall(): void;
  onUninstall(): void;
  onApply(): void;
  onToggleFavorite(): void;
  onShare?(): void;
}) {
  const stats = useMarketplaceStats();
  const themeStats = stats.themes[entry.slug];
  const likes = themeStats?.likes ?? 0;
  const installed = !!entry.installed;
  return (
    <article className="flex flex-col gap-4 max-w-3xl mx-auto">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-fg">{entry.name}</h1>
          {entry.author && <p className="text-sm text-fg-dim">{entry.author}</p>}
          {entry.description && <p className="mt-2 text-fg-2">{entry.description}</p>}
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {/* Theme "favorite" = public like on the Worker. No local-only state. */}
          <LikeButton themeId={entry.slug} initialCount={likes} />
          {/* Local favorite (drives Appearance panel). Distinct from LikeButton
              which is a public count. Gated to installed. */}
          <IconButton
            title={!installed ? "Install to favorite" : favorited ? "Unfavorite" : "Favorite"}
            active={favorited}
            ariaPressed={favorited}
            onClick={installed ? onToggleFavorite : undefined}
          >
            <StarIcon filled={favorited} />
          </IconButton>
          <IconButton
            title="Share link · QR"
            onClick={onShare}
          >
            <ShareIcon />
          </IconButton>
          {isInstalling ? (
            <button
              type="button"
              disabled
              className="px-4 py-2 rounded-md bg-accent/70 text-on-accent cursor-wait flex items-center gap-2"
            >
              <span className="inline-block w-3 h-3 border-2 border-on-accent border-t-transparent rounded-full animate-spin" />
              Installing…
            </button>
          ) : !installed ? (
            <button
              type="button"
              onClick={onInstall}
              className={`px-4 py-2 rounded-md bg-accent text-on-accent hover:opacity-90 ${installError ? 'ring-2 ring-red-500' : ''}`}
              title={installError || undefined}
            >
              {installError ? 'Retry Install' : 'Install'}
            </button>
          ) : isActive ? (
            <>
              <button type="button" disabled className="px-4 py-2 rounded-md bg-inset text-fg-dim border border-edge cursor-default">
                Active
              </button>
              <button type="button" onClick={onUninstall} className="px-3 py-2 rounded-md text-fg-dim hover:text-fg text-sm">
                Uninstall
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={onApply} className="px-4 py-2 rounded-md bg-accent text-on-accent hover:opacity-90">
                Apply theme
              </button>
              <button type="button" onClick={onUninstall} className="px-3 py-2 rounded-md text-fg-dim hover:text-fg text-sm">
                Uninstall
              </button>
            </>
          )}
        </div>
      </header>
      {/* PNG preview — uploaded on publish. Shown first when present so the
          user sees the real rendered screen. Token swatches follow as a
          fallback/supplement for themes whose PNG hasn't regenerated. */}
      {entry.preview && (
        <section>
          <img
            src={entry.preview}
            alt={`${entry.name} preview`}
            loading="lazy"
            className="w-full rounded-md border border-edge-dim"
          />
        </section>
      )}
      {entry.previewTokens && (
        <section className="flex gap-2 flex-wrap">
          {Object.entries(entry.previewTokens).map(([name, color]) => (
            <span
              key={name}
              title={name}
              className="inline-block w-8 h-8 rounded border border-edge-dim"
              style={{ background: color as string }}
            />
          ))}
        </section>
      )}
    </article>
  );
}
