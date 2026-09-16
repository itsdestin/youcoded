// Unified detail overlay — replaces SkillDetail + ThemeDetail. Opens inside
// the marketplace/library screen as a layer-2 popup. Renders skill OR theme
// content from the same shell; the "What's inside" section only shows for
// skills with extracted `components` data.

import React, { useState } from "react";
import { useEscClose } from "../../hooks/use-esc-close";
import { Scrim, OverlayPanel } from "../overlays/Overlay";
import { useMarketplace, installTrackingKey } from "../../state/marketplace-context";
import { useMarketplaceStats } from "../../state/marketplace-stats-context";
import { useAccount } from "../../state/account-context";
import { useTheme } from "../../state/theme-context";
import type { SkillEntry, SkillComponents } from "../../../shared/types";
import { isBundledPlugin, BUNDLED_REASON } from "../../../shared/bundled-plugins";
import type { ThemeRegistryEntryWithStatus } from "../../../shared/theme-marketplace-types";
import LikeButton from "./LikeButton";
// Marketplace overhaul (2026-08-27): trust line, "What this can do", and the
// Feedback section (thumbs + comments) replace star reviews.
import { SourceBadge, ScanBadge, AuthorBadge } from "./TrustBadges";
import { CapabilityList } from "./CapabilityList";
import FeedbackSection from "./FeedbackSection";
import { CATALOG_TYPE_LABEL, isInstallableSource } from "../../../shared/catalog-types";
import FileViewerOverlay, { type FileViewerTarget } from "./FileViewerOverlay";
// Task 1: an installed item with an update available needs a way to take it —
// the overlay swapped straight to Uninstall once installed, so the only route
// was uninstall-then-reinstall (ROADMAP:736 for themes).
import UpdateButton from "./UpdateButton";
import { Button, CloseButton, Callout } from "../ui";
// Task 3: `longDescription` is markdown and used to be printed verbatim, so a
// listing that wrote "**Heading**" showed the asterisks.
import MarkdownContent from "../MarkdownContent";

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
  // Overhaul: jump to another item's page from this one — a member's
  // "Part of …" link, or a bundle's "What's inside" rows. The screen owns
  // the target, so this just swaps it.
  onNavigate?(target: DetailTarget): void;
}

export default function MarketplaceDetailOverlay({
  target, onClose, onOpenShareSheet, onOpenThemeShare, onNavigate,
}: Props) {
  const mp = useMarketplace();
  // Needed for Apply action and isActive check in ThemeBody
  const { theme: activeThemeSlug, setTheme } = useTheme();

  useEscClose(true, onClose);

  // Lookup the target in the already-fetched context. No per-overlay fetch —
  // keeps the overlay snappy and avoids cache-invalidation questions.
  let content: React.ReactNode;
  if (target.kind === "skill") {
    const entry = mp.skillEntries.find((e) => e.id === target.id)
      || mp.installedSkills.find((e) => e.id === target.id);
    if (!entry) {
      content = <NotFound label="Skill" onClose={onClose} />;
    } else {
      // Match by either the bare plugin id OR a scanned skill's pluginName.
      // The provider drops bare plugin-level entries when individual skills
      // were scanned (anti-duplicate-card guard for the command drawer), so
      // for any plugin that ships skills, only namespaced ids appear in
      // installedSkills and the bare id never matches. See MarketplaceScreen
      // installedIds memo for the same fix at the grid level.
      // Overhaul: a member row counts as installed when its bundle is.
      const bundleId = entry.catalog?.partOf?.id;
      const installed = mp.installedSkills.some(
        (e) => e.id === target.id || e.pluginName === target.id
          || (!!bundleId && (e.id === bundleId || e.pluginName === bundleId)),
      );
      // Members reachable from a bundle's "What's inside": `<bundle>/<name>`
      // rows the catalog shipped. Absent → fall back to the file viewer.
      const memberId = (name: string): string | null => {
        const id = `${entry.id}/${name}`;
        return mp.skillEntries.some((e) => e.id === id) ? id : null;
      };
      const favorited = mp.favorites.includes(target.id);
      const installing = mp.installingIds.has(installTrackingKey('skill', target.id));
      const errEntry = mp.installError.get(installTrackingKey('skill', target.id));
      content = (
        <SkillBody
          entry={entry}
          installed={installed}
          favorited={favorited}
          isInstalling={installing}
          // Only an INSTALL failure feeds "Retry Install" — the key is shared with
          // uninstall and update (error inventory 2026-09-10, false message 14).
          installError={errEntry?.op === 'install' ? errEntry.message : null}
          updateAvailable={!!mp.updateAvailable[target.id]}
          onNavigate={onNavigate}
          memberId={memberId}
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
      const installing = mp.installingIds.has(installTrackingKey('theme', target.slug));
      const errEntry = mp.installError.get(installTrackingKey('theme', target.slug));
      const favorited = mp.themeFavorites.includes(target.slug);
      const isActive = activeThemeSlug === target.slug;
      content = (
        <ThemeBody
          entry={entry}
          isInstalling={installing}
          // Same rule as SkillBody above: only an INSTALL failure feeds "Retry Install".
          installError={errEntry?.op === 'install' ? errEntry.message : null}
          updateAvailable={!!mp.updateAvailable[target.slug]}
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
      {/* Inset shrinks to 8px on narrow so the popup fills the phone screen
          (the desktop 32–64px insets crushed the body into a ~290px column). */}
      <OverlayPanel
        layer={2}
        className="fixed inset-2 sm:inset-8 md:inset-16 flex flex-col overflow-hidden"
      >
        <header className="flex items-center justify-between p-3 sm:p-4 border-b border-edge-dim">
          <h2 className="text-lg font-semibold text-fg">Details</h2>
          {/* Wide: Esc-text hint. Narrow: bordered close-X matching the marketplace top bar. */}
          <button
            type="button"
            onClick={onClose}
            className="hidden sm:inline-block text-fg-dim hover:text-fg text-sm px-2 py-1"
            aria-label="Close"
          >
            Esc · Close
          </button>
          {/* panel-glass + the border survive as className overrides: this narrow-only
              closer is deliberately a bordered container matching the marketplace top bar. */}
          <CloseButton
            onClick={onClose}
            className="sm:hidden panel-glass bg-inset rounded-md border border-edge-dim hover:border-edge"
          />
        </header>
        <div className="flex-1 overflow-y-auto p-3 sm:p-6">{content}</div>
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
  entry, installed, favorited, isInstalling, installError, updateAvailable,
  onInstall, onUninstall, onToggleFavorite, onShare, onNavigate, memberId,
}: {
  entry: SkillEntry;
  installed: boolean;
  favorited: boolean;
  isInstalling: boolean;
  installError: string | null;
  updateAvailable: boolean;
  onInstall(): void;
  onUninstall(): void;
  onToggleFavorite(): void;
  onShare?(): void;
  onNavigate?(target: DetailTarget): void;
  memberId(name: string): string | null;
}) {
  // File viewer for items in the "What's inside" peek — nested layer-3 overlay
  // that reads local install first, remote raw URL as fallback.
  const [fileTarget, setFileTarget] = useState<FileViewerTarget | null>(null);
  const catalog = entry.catalog;
  const typeLabel = catalog ? CATALOG_TYPE_LABEL[catalog.itemType].one : null;

  return (
    <article className="flex flex-col gap-4 max-w-3xl mx-auto">
      {/* Header stacks at narrow so the title/tagline get the full row width
          and the icon cluster drops below — at sm+ they sit side-by-side. */}
      <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold text-fg">{entry.displayName}</h1>
          {typeLabel && <p className="text-sm text-fg-dim">{typeLabel}</p>}
          {/* Legacy rows (no catalog block) keep the author as text. */}
          {!catalog && entry.author && <p className="text-sm text-fg-dim">{entry.author}</p>}
          {/* Overhaul: the trust line — was it checked, who made it (origin +
              author chips), and where it came from. Badges, then plain text;
              never a score. */}
          {catalog && (
            <div className="mt-2 flex items-center gap-1.5 flex-wrap text-xs text-fg-dim" data-trust-line>
              <ScanBadge scan={catalog.scan} size="md" />
              <SourceBadge origin={catalog.origin} size="md" />
              {entry.author && <AuthorBadge author={entry.author} size="md" />}
              {catalog.partOf && (
                <button
                  type="button"
                  onClick={onNavigate ? () => onNavigate({ kind: "skill", id: catalog.partOf!.id }) : undefined}
                  className="underline decoration-dotted underline-offset-2 text-fg-2 hover:text-accent"
                >
                  Part of {catalog.partOf.displayName}
                </button>
              )}
            </div>
          )}
          {entry.tagline && <p className="mt-2 text-sm sm:text-base text-fg-2">{entry.tagline}</p>}
        </div>
        <div className="shrink-0 flex items-center gap-2 flex-wrap">
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
                <>
                  {/* Update sits BEFORE Uninstall: it is the action a user with
                      an out-of-date item actually wants, and putting it after
                      makes Uninstall the first thing under the cursor. */}
                  {updateAvailable && <UpdateButton id={entry.id} kind="skill" variant="button" />}
                  {/* Was a FILLED inset button, which read as a second primary
                      sitting next to Install. Bordered secondary makes the
                      hierarchy obvious. */}
                  <Button
                    variant="secondary"
                    size="lg"
                    onClick={onUninstall}
                    disabled={bundled}
                    title={bundled ? BUNDLED_REASON : undefined}
                  >
                    Uninstall
                  </Button>
                </>
              );
            })()
          ) : !isInstallableSource(entry) ? (
            // Task 21: rows the installer cannot take (Connections from the MCP
            // registry, single-file listings) never reach an Install button — it
            // would only ever fail. Point at the source instead. Checked AFTER
            // `installed` on purpose: an installed item is described by the
            // locally scanned entry, which has no sourceType, and must keep its
            // Uninstall button.
            <Button
              variant="secondary"
              size="lg"
              onClick={() => entry.repoUrl && window.open(entry.repoUrl, '_blank', 'noopener')}
              disabled={!entry.repoUrl}
              title={entry.repoUrl ? undefined : 'This listing does not say where its source lives.'}
            >
              Open source
            </Button>
          ) : (
            <Button
              size="lg"
              onClick={onInstall}
              // ring-red-500 -> the destructive token: identical #DD4444 today,
              // but theme-overridable now.
              className={installError ? 'ring-2 ring-destructive' : ''}
              title={installError || undefined}
            >
              {installError ? 'Retry Install' : 'Install'}
            </Button>
          )}
        </div>
      </header>

      {/* Overhaul (decision #3): what it does to your machine, in plain
          words, BEFORE the description — read it, then decide. */}
      {catalog && <CapabilityList catalog={catalog} />}

      {/* Task 21: say plainly why there is no Install button, right where the
          user is looking for one. */}
      {!installed && !isInstallableSource(entry) && (
        <Callout tone="info">
          {/* Name the thing rather than always saying "connection": most of these
              rows ARE connections, but single-file listings are not, and calling
              one a connection would be plainly wrong. */}
          This {catalog ? CATALOG_TYPE_LABEL[catalog.itemType].one.toLowerCase() : 'listing'} isn't
          installable from here yet. What this can do lists how it runs (as a package or a
          remote service); add it from the source page.
        </Callout>
      )}

      {/* Tags + audience + life area — only render when at least one is set,
          so legacy entries without these fields don't get an empty row. */}
      <MetadataChips entry={entry} />

      {entry.longDescription ? (
        <section>
          <h2 className="text-sm uppercase tracking-wide text-fg-dim mb-2">About</h2>
          <div className="prose prose-sm max-w-none text-fg-2">
            <MarkdownContent content={entry.longDescription} />
          </div>
        </section>
      ) : (
        <p className="text-fg-2">{entry.description}</p>
      )}

      <ComponentsPeek
        components={entry.components}
        onOpenFile={(kind, name) => {
          // Overhaul (decision #1): a member with its own catalog row opens
          // its own page (with its own Install); otherwise the raw file.
          const id = memberId(name);
          if (id && onNavigate) { onNavigate({ kind: "skill", id }); return; }
          setFileTarget({ pluginId: entry.id, pluginName: entry.displayName, kind, name });
        }}
      />

      {/* Overhaul (decision #4): thumbs + comments replace star reviews. */}
      <FeedbackSection pluginId={entry.id} installed={installed} />

      {entry.repoUrl && (
        <footer className="text-xs text-fg-dim flex flex-wrap gap-x-2">
          <span>Source: <a className="underline" href={entry.repoUrl} target="_blank" rel="noreferrer">{entry.repoUrl}</a></span>
          {/* Overhaul: the licence and the exact upstream version we pinned —
              the two facts a mirrored listing owes its author and its user. */}
          {catalog?.license && <span>· {catalog.license}</span>}
          {catalog?.sourceCommit && <span title="The listing is pinned to this exact upstream version; an author can't swap the files after we checked them.">· pinned to {catalog.sourceCommit}</span>}
          {catalog && !catalog.license && <span>· licence not stated</span>}
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
  entry, isInstalling, installError, updateAvailable, isActive, favorited,
  onInstall, onUninstall, onApply, onToggleFavorite, onShare,
}: {
  entry: ThemeRegistryEntryWithStatus;
  isInstalling: boolean;
  installError: string | null;
  updateAvailable: boolean;
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

  // Confirmation wrapper — locally-built themes are permanent deletes (no marketplace copy to reinstall from)
  const handleUninstall = () => {
    const confirmCopy = entry.isLocal
      ? `Permanently delete "${entry.name}"? This theme was built locally — there's no marketplace copy, so the files will be removed forever and can't be recovered.`
      : `Uninstall "${entry.name}"? You can reinstall it later from the marketplace.`;
    if (!window.confirm(confirmCopy)) return;
    onUninstall();
  };

  return (
    <article className="flex flex-col gap-4 max-w-3xl mx-auto">
      {/* Header stacks at narrow — see SkillBody for the rationale. */}
      <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold text-fg">{entry.name}</h1>
          {entry.author && <p className="text-sm text-fg-dim">{entry.author}</p>}
          {entry.description && <p className="mt-2 text-sm sm:text-base text-fg-2">{entry.description}</p>}
        </div>
        <div className="shrink-0 flex items-center gap-2 flex-wrap">
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
            <Button
              size="lg"
              onClick={onInstall}
              // ring-red-500 -> the destructive token: identical #DD4444 today,
              // but theme-overridable now.
              className={installError ? 'ring-2 ring-destructive' : ''}
              title={installError || undefined}
            >
              {installError ? 'Retry Install' : 'Install'}
            </Button>
          ) : isActive ? (
            <>
              {/* "Active" is a disabled state marker, not an action — secondary
                  reads as the inert sibling of the ghost Uninstall beside it. */}
              <Button variant="secondary" size="lg" disabled>
                Active
              </Button>
              {/* installTheme already overwrites an installed slug in place, so
                  the update path always worked — there was simply no button. */}
              {updateAvailable && <UpdateButton id={entry.slug} kind="theme" variant="button" />}
              <Button variant="ghost" size="lg" onClick={handleUninstall}>
                Uninstall
              </Button>
            </>
          ) : (
            <>
              <Button size="lg" onClick={onApply}>
                Apply theme
              </Button>
              {updateAvailable && <UpdateButton id={entry.slug} kind="theme" variant="button" />}
              <Button variant="ghost" size="lg" onClick={handleUninstall}>
                Uninstall
              </Button>
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
