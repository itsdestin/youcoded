// The Marketplace detail page — opens over the marketplace or Your library when
// a card is clicked. Renders a skill-like item (plugin, skill, specialist,
// connection, prompt) or a theme. Integrations have their own page
// (IntegrationDetailOverlay.tsx) built from the same shell.
//
// Redesign 2026-10-04 (redesign-backlog row 9): presentation only — every action,
// its order of precedence and its error handling are what they were. The shell,
// the top card and the labelled sections come from DetailPage.tsx; its header
// comment says which guide rule each piece follows.

import React, { useEffect, useState } from "react";
import { useMarketplace, installTrackingKey } from "../../state/marketplace-context";
import { useMarketplaceStats } from "../../state/marketplace-stats-context";
import { useTheme } from "../../state/theme-context";
import type { SkillEntry, SkillComponents } from "../../../shared/types";
import { isBundledPlugin, BUNDLED_REASON } from "../../../shared/bundled-plugins";
import type { ThemeRegistryEntryWithStatus } from "../../../shared/theme-marketplace-types";
import LikeButton from "./LikeButton";
// Marketplace overhaul (2026-08-27): trust chips, "What this can do", and the
// Feedback section (thumbs + comments) replace star reviews.
import { SourceBadge, ScanBadge, AuthorBadge, MetaChip } from "./TrustBadges";
import { CapabilityList } from "./CapabilityList";
import FeedbackSection, { MIN_VOTES_FOR_PCT, ThumbIcon, thumbsSummary } from "./FeedbackSection";
import { CATALOG_TYPE_LABEL, isInstallableSource } from "../../../shared/catalog-types";
import FileViewerOverlay, { type FileViewerTarget } from "./FileViewerOverlay";
// Task 1: an installed item with an update available needs a way to take it.
import UpdateButton from "./UpdateButton";
import { Button, Callout, CARD_LEVEL_1, Pill, SettingRow } from "../ui";
// Task 3: `longDescription` is markdown and used to be printed verbatim.
import MarkdownContent from "../MarkdownContent";
import { DetailActions, DetailIdentity, DetailPage, type DetailSection } from "./DetailPage";

export type DetailTarget =
  | { kind: "skill"; id: string }
  | { kind: "theme"; slug: string };

interface Props {
  target: DetailTarget;
  onClose(): void;
  // Share plumbing — App.tsx owns the ShareSheet/ThemeShareSheet components
  // so the sheet can layer above this popup cleanly. Optional so the screen
  // works standalone in tests.
  onOpenShareSheet?(skillId: string): void;
  onOpenThemeShare?(themeSlug: string): void;
  // Overhaul: jump to another item's page from this one — a member's
  // "Part of …" row, or a bundle's "What's inside" rows. The screen owns
  // the target, so this just swaps it.
  onNavigate?(target: DetailTarget): void;
  /** Photo-only build: the shoot screen this popup marks itself as (defaults by kind). */
  screen?: string;
}

export default function MarketplaceDetailOverlay({
  target, onClose, onOpenShareSheet, onOpenThemeShare, onNavigate, screen,
}: Props) {
  const mp = useMarketplace();
  // Needed for Apply action and isActive check in ThemeDetail
  const { theme: activeThemeSlug, setTheme } = useTheme();
  // WHY no useEscClose here any more: the shared popup (Dialog, inside DetailPage)
  // registers Escape itself — two registrations would be two closes to unwind.

  // Lookup the target in the already-fetched context. No per-popup fetch —
  // keeps the popup snappy and avoids cache-invalidation questions.
  if (target.kind === "skill") {
    const entry = mp.skillEntries.find((e) => e.id === target.id)
      || mp.installedSkills.find((e) => e.id === target.id);
    if (!entry) return <NotFound what="plugin" onClose={onClose} />;
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
    const member = (name: string): SkillEntry | null =>
      mp.skillEntries.find((e) => e.id === `${entry.id}/${name}`) ?? null;
    const favorited = mp.favorites.includes(target.id);
    const errEntry = mp.installError.get(installTrackingKey('skill', target.id));
    return (
      <SkillDetail
        entry={entry}
        screen={screen ?? 'marketplace/detail'}
        onClose={onClose}
        installed={installed}
        favorited={favorited}
        isInstalling={mp.installingIds.has(installTrackingKey('skill', target.id))}
        // Only an INSTALL failure feeds "Retry install" — the key is shared with
        // uninstall and update (error inventory 2026-09-10, false message 14).
        installError={errEntry?.op === 'install' ? errEntry.message : null}
        updateAvailable={!!mp.updateAvailable[target.id]}
        onNavigate={onNavigate}
        member={member}
        onInstall={() => mp.installSkill(entry.id).catch(() => undefined)}
        onUninstall={() => mp.uninstallSkill(entry.id).catch(() => undefined)}
        onToggleFavorite={() => mp.setFavorite(entry.id, !favorited).catch(() => undefined)}
        onShare={onOpenShareSheet ? () => onOpenShareSheet(entry.id) : undefined}
      />
    );
  }

  const entry = mp.themeEntries.find((e) => e.slug === target.slug);
  if (!entry) return <NotFound what="theme" onClose={onClose} />;
  const errEntry = mp.installError.get(installTrackingKey('theme', target.slug));
  const favorited = mp.themeFavorites.includes(target.slug);
  return (
    <ThemeDetail
      entry={entry}
      screen={screen ?? 'marketplace/theme-detail'}
      onClose={onClose}
      isInstalling={mp.installingIds.has(installTrackingKey('theme', target.slug))}
      // Same rule as SkillDetail above: only an INSTALL failure feeds "Retry install".
      installError={errEntry?.op === 'install' ? errEntry.message : null}
      updateAvailable={!!mp.updateAvailable[target.slug]}
      isActive={activeThemeSlug === target.slug}
      favorited={favorited}
      onInstall={() => mp.installTheme(entry.slug).catch(() => undefined)}
      onUninstall={() => mp.uninstallTheme(entry.slug).catch(() => undefined)}
      onApply={() => setTheme(entry.slug)}
      onToggleFavorite={() => mp.favoriteTheme(entry.slug, !favorited).catch(() => undefined)}
      onShare={onOpenThemeShare ? () => onOpenThemeShare(entry.slug) : undefined}
    />
  );
}

// WHY a popup with one card and no button: the ✕ is the way out (guide "Buttons":
// close is always the ✕ — the old underlined "Close" text was a link pretending to be
// a button), and a single-card popup needs no label above it (decisions "A label
// first — single-card popups"). Never marked as a shoot screen: it is not a page.
function NotFound({ what, onClose }: { what: "plugin" | "theme"; onClose(): void }) {
  return (
    <DetailPage
      title={what === "theme" ? "Theme details" : "Plugin details"}
      onClose={onClose}
      identity={<div className={`${CARD_LEVEL_1} p-4 text-sm text-fg-2`}>This {what} is not in the Marketplace list right now.</div>}
      sections={[]}
    />
  );
}

// ── Quick actions (top right of the top card) ───────────────────────────────

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={filled ? 0 : 1.8} strokeLinejoin="round" aria-hidden>
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.6" y1="13.5" x2="15.4" y2="17.5" />
      <line x1="15.4" y1="6.5" x2="8.6" y2="10.5" />
    </svg>
  );
}

/** Favourite + share — the card's quick actions, top right (guide "Cards": quick actions
 *  on a card sit at its top right). Shared buttons now, not a hand-made bordered square:
 *  a favourite is an on/off toggle, share a plain icon button. */
function QuickActions({ installed, favorited, onToggleFavorite, onShare, shareNeedsInstall }: {
  installed: boolean; favorited: boolean; onToggleFavorite(): void; onShare?(): void; shareNeedsInstall: boolean;
}) {
  const favTitle = !installed ? "Install to favorite" : favorited ? "Unfavorite" : "Favorite";
  const canShare = !!onShare && (installed || !shareNeedsInstall);
  return (
    <>
      {/* Filled accent star when on, like the cards' star; aria-pressed says it to a
          screen reader. */}
      <Button
        variant="ghost"
        size="icon"
        aria-label={favTitle}
        title={favTitle}
        aria-pressed={favorited}
        disabled={!installed}
        onClick={onToggleFavorite}
        className={favorited ? "text-accent" : ""}
      >
        <StarIcon filled={favorited} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={canShare ? "Share link · QR" : "Install to share"}
        title={canShare ? "Share link · QR" : "Install to share"}
        disabled={!canShare}
        onClick={onShare}
      >
        <ShareIcon />
      </Button>
    </>
  );
}

/** "Installing…" — the main button's busy state, full width like the button it replaces. */
function InstallingButton() {
  return (
    <Button size="lg" disabled className="cursor-wait">
      <span className="inline-block w-3 h-3 border-2 border-on-accent border-t-transparent rounded-full animate-spin" aria-hidden />
      Installing…
    </Button>
  );
}

/** A failed install, said inside the item's card with its own Retry (guide "Status and
 *  notices": a notice about one thing sits inside it, its buttons inside the notice at
 *  the right). WHY: the reason used to live only in the Install button's hover title, so
 *  touch screens never saw it. */
function InstallFailed({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <Callout tone="danger" title="Couldn't install" actions={<Button size="sm" onClick={onRetry}>Retry install</Button>}>
      {message}
    </Callout>
  );
}

/** A number chip: bold number, grey word — "412 installs" (guide "Text and numbers"). Same
 *  chip recipe as the trust badges beside it (MetaChip — round 2, MD-1 "install is tiny"). */
function CountChip({ n, word }: { n: number; word: string }) {
  return (
    <MetaChip>
      <span className="font-medium text-fg">{n.toLocaleString()}</span>
      {n === 1 ? word : `${word}s`}
    </MetaChip>
  );
}

/** "👍 93%" — or the raw count under MIN_VOTES_FOR_PCT, where a percentage would lie. Drawn
 *  inside MetaChip rather than reusing the card's ThumbsSummary, whose own 12px text made
 *  this chip taller than its neighbours in round 1. */
function ThumbsChip({ up, down }: { up?: number; down?: number }) {
  const s = thumbsSummary(up, down);
  if (!s) return null;
  const low = s.total < MIN_VOTES_FOR_PCT;
  return (
    <MetaChip title={low ? `${s.up} of ${s.total} found it helpful` : `${s.pct}% of ${s.total.toLocaleString()} people found it helpful`}>
      <span className="inline-flex text-fg-dim"><ThumbIcon /></span>
      {low ? s.up : `${s.pct}%`}
    </MetaChip>
  );
}

// ── Skill-like items ────────────────────────────────────────────────────────

function SkillDetail({
  entry, screen, onClose, installed, favorited, isInstalling, installError, updateAvailable,
  onInstall, onUninstall, onToggleFavorite, onShare, onNavigate, member,
}: {
  entry: SkillEntry;
  screen: string;
  onClose(): void;
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
  member(name: string): SkillEntry | null;
}) {
  // File viewer for items in "What's inside" — nested layer-3 popup that reads the
  // local install first, the remote raw URL as fallback.
  const [fileTarget, setFileTarget] = useState<FileViewerTarget | null>(null);
  const stats = useMarketplaceStats().plugins[entry.id];
  const catalog = entry.catalog;
  const typeLabel = catalog ? CATALOG_TYPE_LABEL[catalog.itemType].one : "Plugin";
  const kindWord = typeLabel.toLowerCase();
  const installable = isInstallableSource(entry);
  const bundled = isBundledPlugin(entry.id);

  // Checked AFTER `installed` on purpose (Task 21): an installed item is described by
  // the locally scanned entry, which has no sourceType, and must keep its Uninstall.
  let actions: React.ReactNode = null;
  if (isInstalling) {
    actions = <DetailActions><InstallingButton /></DetailActions>;
  } else if (installed) {
    actions = (
      <DetailActions>
        {/* Bundled plugins ship with YouCoded — Uninstall is disabled (the IPC handler
            also rejects them); the reason is written under the buttons below. */}
        <Button variant="secondary" size="lg" onClick={onUninstall} disabled={bundled} title={bundled ? BUNDLED_REASON : undefined}>
          Uninstall
        </Button>
        {/* Update is the action a user with an out-of-date item wants, so it is the
            filled one, on the right (guide "Buttons": main action filled, on the right). */}
        {updateAvailable && <UpdateButton id={entry.id} kind="skill" variant="button" primary block />}
      </DetailActions>
    );
  } else if (!installable) {
    // Task 21: rows the installer cannot take (Connections from the MCP registry,
    // single-file listings) never reach an Install button — it would only ever fail.
    actions = (
      <DetailActions>
        <Button
          variant="secondary"
          size="lg"
          onClick={() => entry.repoUrl && window.open(entry.repoUrl, '_blank', 'noopener')}
          disabled={!entry.repoUrl}
          title={entry.repoUrl ? undefined : 'This listing does not say where its source lives.'}
        >
          Open source
        </Button>
      </DetailActions>
    );
  } else if (!installError) {
    actions = <DetailActions><Button size="lg" onClick={onInstall}>Install</Button></DetailActions>;
  }

  const identity = (
    <DetailIdentity
      name={entry.displayName}
      status={installed ? <Pill tone="ok">Installed</Pill> : undefined}
      quickActions={
        // Favourite drives the command drawer's starred list, and the share sheet needs
        // local files — so both stay gated on installed, as before.
        <QuickActions installed={installed} favorited={favorited} onToggleFavorite={onToggleFavorite} onShare={onShare} shareNeedsInstall />
      }
      chips={
        <>
          {/* Overhaul: was it checked, who made it, where it came from — then the
              numbers (decisions U-1: all chips in one row right under the name). */}
          {catalog && <ScanBadge scan={catalog.scan} />}
          {catalog && <SourceBadge origin={catalog.origin} />}
          {entry.author && <AuthorBadge author={entry.author} />}
          {!!stats?.installs && <CountChip n={stats.installs} word="install" />}
          {stats && <ThumbsChip up={stats.thumbs_up} down={stats.thumbs_down} />}
        </>
      }
      description={entry.tagline}
      actions={actions}
    >
      {/* Overhaul: a member says which bundle it came from — a row that opens it. */}
      {catalog?.partOf && (
        <SettingRow
          variant="item"
          title={`Part of ${catalog.partOf.displayName}`}
          description={`Installs with ${catalog.partOf.displayName} — open its page`}
          onClick={onNavigate ? () => onNavigate({ kind: "skill", id: catalog.partOf!.id }) : undefined}
        />
      )}
      {/* Task 21: say plainly why there is no Install button, right where the user is
          looking for one. Name the thing rather than always saying "connection". */}
      {!installed && !installable && (
        <Callout tone="info">
          This {kindWord} isn't installable from here yet. What this can do lists how it runs
          (as a package or a remote service); add it from the source page.
        </Callout>
      )}
      {!installed && installable && !isInstalling && installError && <InstallFailed message={installError} onRetry={onInstall} />}
      {installed && bundled && <p className="text-xs text-fg-muted">{BUNDLED_REASON}</p>}
    </DetailIdentity>
  );

  const sections: DetailSection[] = [];
  // Overhaul (decision #3): what it does to your machine, in plain words, BEFORE the
  // description — read it, then decide. So it stays open in every layout.
  if (catalog) sections.push({ id: "can-do", label: "What this can do", node: <CapabilityList catalog={catalog} />, side: true });
  sections.push({
    id: "about",
    label: "About",
    node: (
      <div className="space-y-3">
        {entry.longDescription ? (
          // Body text is 14px in the main text colour family (guide "Text and numbers"); the
          // markdown used to inherit the chat's larger reading size.
          <div className="text-sm text-fg-2"><MarkdownContent content={entry.longDescription} /></div>
        ) : (
          <p className="text-sm text-fg-2">{entry.description}</p>
        )}
        <TopicChips entry={entry} />
      </div>
    ),
  });
  if (hasComponents(entry.components)) {
    sections.push({
      id: "inside",
      label: "What's inside",
      node: (
        <ComponentsList
          components={entry.components!}
          member={member}
          onOpen={(kind, name) => {
            // Overhaul (decision #1): a member with its own catalog row opens its own
            // page (with its own Install); otherwise the raw file.
            const m = member(name);
            if (m && onNavigate) { onNavigate({ kind: "skill", id: m.id }); return; }
            setFileTarget({ pluginId: entry.id, pluginName: entry.displayName, kind, name });
          }}
        />
      ),
    });
  }
  // Overhaul (decision #4): thumbs + comments replace star reviews. Two cards — the votes,
  // then the comments (Destin picked "two cards", marketplace-detail-2#M2-2).
  sections.push({ id: "feedback", label: "Feedback", node: <FeedbackSection pluginId={entry.id} installed={installed} part="votes" /> });
  sections.push({ id: "comments", label: "Comments", node: <FeedbackSection pluginId={entry.id} installed={installed} part="comments" /> });
  if (entry.repoUrl || catalog) {
    sections.push({ id: "source", label: "Source", side: true, node: <SourceRows entry={entry} /> });
  }

  return (
    <>
      <DetailPage
        title={`${typeLabel} details`}
        screen={screen}
        onClose={onClose}
        identity={identity}
        sections={sections}
      />
      {fileTarget && <FileViewerOverlay target={fileTarget} onClose={() => setFileTarget(null)} />}
    </>
  );
}

/** Topics, life areas and audience — neutral chips at the foot of the About card (they
 *  describe the item, so they live inside the card that describes it — guide "Card
 *  levels"). The same chip as the top card's row (MetaChip), so every chip is one size. */
function TopicChips({ entry }: { entry: SkillEntry }) {
  const tags = entry.tags || [];
  const lifeAreas = entry.lifeArea || [];
  if (!tags.length && !lifeAreas.length && !entry.audience) return null;
  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {tags.map((t) => <MetaChip key={`tag-${t}`}>#{t}</MetaChip>)}
      {lifeAreas.map((a) => <MetaChip key={`area-${a}`}>{a.charAt(0).toUpperCase() + a.slice(1)}</MetaChip>)}
      {entry.audience && <MetaChip>{entry.audience === "developer" ? "For developers" : "For everyone"}</MetaChip>}
    </div>
  );
}

type OpenableKind = "skill" | "command" | "agent";

function hasComponents(c: SkillComponents | null | undefined): boolean {
  // `null` = extraction failed — hide entirely (don't alarm the user). `undefined` =
  // pre-Phase-1 cached entry; same. Empty object = the plugin genuinely has nothing.
  if (!c) return false;
  return !!(c.skills.length || c.commands.length || c.agents.length || c.hooks.length
    || c.hasHooksManifest || c.mcpServers.length || c.hasMcpConfig);
}

/** "What's inside" — one group per kind, each a list of rows that open the member's own
 *  page (or its file). WHY rows, not a comma list of dotted-underlined names: underlined
 *  text is only a link inside a sentence, never a button (guide "Buttons"); a row that
 *  opens something is the shared setting row with its arrow (guide "Lists and menus"). */
function ComponentsList({ components, member, onOpen }: {
  components: SkillComponents;
  member(name: string): SkillEntry | null;
  onOpen(kind: OpenableKind, name: string): void;
}) {
  const groups: Array<{ label: string; kind: OpenableKind; items: string[] }> = ([
    { label: "Skills", kind: "skill" as const, items: components.skills },
    { label: "Commands", kind: "command" as const, items: components.commands },
    { label: "Specialists", kind: "agent" as const, items: components.agents },
  ]).filter((g) => g.items.length > 0);
  const plain: Array<[string, string]> = [];
  if (components.hooks.length) plain.push(["Hooks", components.hooks.join(", ")]);
  else if (components.hasHooksManifest) plain.push(["Hooks", "Set up by its hooks file"]);
  if (components.mcpServers.length) plain.push(["Connections", components.mcpServers.join(", ")]);
  else if (components.hasMcpConfig) plain.push(["Connections", "Set up by its connections file"]);

  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.label}>
          {/* A count beside a label: the word, then a smaller fainter number (guide
              "Text and numbers"). */}
          <div className="text-xs font-medium text-fg-2 mb-2">
            {g.label} <span className="text-3xs text-fg-muted font-normal ml-0.5">{g.items.length}</span>
          </div>
          <div className="space-y-2">
            {g.items.map((name) => {
              const m = member(name);
              return (
                <SettingRow
                  key={name}
                  variant="item"
                  title={m?.displayName ?? name}
                  description={m?.description}
                  onClick={() => onOpen(g.kind, name)}
                />
              );
            })}
          </div>
        </div>
      ))}
      {plain.map(([label, text]) => (
        <SettingRow key={label} variant="item" title={label} description={text} />
      ))}
    </div>
  );
}

/** Where it comes from, its licence and the exact version that was checked — the facts a
 *  mirrored listing owes its author and its user. Were a loose grey line under the page
 *  with a raw link; now setting rows inside the Source card (guide "Spacing" → nothing
 *  bare), the link an outlined Open button, and the pinned-version explanation written
 *  out instead of hidden in a hover tooltip touch screens never show. */
function SourceRows({ entry }: { entry: SkillEntry }) {
  const catalog = entry.catalog;
  return (
    <div className="space-y-2">
      {entry.repoUrl && (
        <SettingRow
          variant="item"
          title="Source code"
          description={entry.repoUrl.replace(/^https?:\/\//, "")}
          // A long address has no spaces to wrap at, so let it break anywhere rather than
          // run under the Open button (seen in the side column, round 2).
          descriptionClassName="text-fg-muted break-all"
          control={<Button variant="secondary" size="sm" onClick={() => window.open(entry.repoUrl, '_blank', 'noopener')}>Open</Button>}
        />
      )}
      {catalog && <SettingRow variant="item" title="Licence" value={catalog.license ?? "Not stated"} />}
      {catalog?.sourceCommit && (
        <SettingRow
          variant="item"
          title="Checked version"
          description="The files we checked are pinned to this version."
          value={catalog.sourceCommit}
        />
      )}
    </div>
  );
}

// ── Themes ──────────────────────────────────────────────────────────────────

function ThemeDetail({
  entry, screen, onClose, isInstalling, installError, updateAvailable, isActive, favorited,
  onInstall, onUninstall, onApply, onToggleFavorite, onShare,
}: {
  entry: ThemeRegistryEntryWithStatus;
  screen: string;
  onClose(): void;
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
  const themeStats = useMarketplaceStats().themes[entry.slug];
  const likes = themeStats?.likes ?? 0;
  const installed = !!entry.installed;
  // The live like count: seeded from the page stats, then told every change by the heart
  // (optimistic step included), so the "N likes" chip moves the instant you click
  // (marketplace-detail-3#M3-1). Re-seeded if the stats arrive late.
  const [likeCount, setLikeCount] = useState(likes);
  useEffect(() => { setLikeCount(likes); }, [likes]);

  // Confirmation wrapper — locally-built themes are permanent deletes (no marketplace copy to reinstall from)
  const handleUninstall = () => {
    const confirmCopy = entry.isLocal
      ? `Permanently delete "${entry.name}"? This theme was built locally — there's no marketplace copy, so the files will be removed forever and can't be recovered.`
      : `Uninstall "${entry.name}"? You can reinstall it later from the marketplace.`;
    if (!window.confirm(confirmCopy)) return;
    onUninstall();
  };

  let actions: React.ReactNode = null;
  if (isInstalling) {
    actions = <DetailActions><InstallingButton /></DetailActions>;
  } else if (!installed) {
    if (!installError) actions = <DetailActions><Button size="lg" onClick={onInstall}>Install</Button></DetailActions>;
  } else {
    // installTheme already overwrites an installed slug in place, so the update path
    // always worked — there was simply no button. Uninstall is outlined now, never
    // bare text (decisions F-2); the theme in use says so with a pill, not a dead
    // "Active" button (guide "Card levels": nothing that isn't a button looks like one).
    actions = (
      <DetailActions>
        <Button variant="secondary" size="lg" onClick={handleUninstall}>Uninstall</Button>
        {updateAvailable && <UpdateButton id={entry.slug} kind="theme" variant="button" primary={isActive} block />}
        {!isActive && <Button size="lg" onClick={onApply}>Apply theme</Button>}
      </DetailActions>
    );
  }

  // One chip row that scrolls sideways when it doesn't fit (marketplace-detail-4#M4-2);
  // the heart is icon-only and its live count is the "N likes" chip (M3-1).
  const chips = (
    <>
      {entry.author && <AuthorBadge author={entry.author} />}
      {!!themeStats?.installs && <CountChip n={themeStats.installs} word="download" />}
      {likeCount > 0 && <CountChip n={likeCount} word="like" />}
    </>
  );

  const identity = (
    <DetailIdentity
      name={entry.name}
      // WHY no "Installed" pill on a theme (Destin, marketplace-detail-4#M4-2: "remove th
      // installed chip"): its Apply theme / Uninstall buttons already say it is installed.
      // Themes only — plugin pages keep theirs (approved, marketplace-detail-1#MD-2;
      // decisions S-1 "tinted pill looks good for installed"). The theme in use keeps
      // "In use", which the buttons do not say.
      status={isActive ? <Pill tone="ok">In use</Pill> : undefined}
      quickActions={
        <>
          {/* Theme "like" = the public count on the Worker; a heart-only button, its count
              is the "N likes" fact (marketplace-detail-3#M3-1). */}
          <LikeButton themeId={entry.slug} initialCount={likes} onCountChange={setLikeCount} />
          {/* Local favourite (drives the Appearance panel), distinct from the public like. */}
          <QuickActions installed={installed} favorited={favorited} onToggleFavorite={onToggleFavorite} onShare={onShare} shareNeedsInstall={false} />
        </>
      }
      quickActionsOnTitle
      chips={chips}
      description={entry.description}
      actions={actions}
    >
      {!installed && !isInstalling && installError && <InstallFailed message={installError} onRetry={onInstall} />}
    </DetailIdentity>
  );

  // PNG preview (uploaded on publish) — the real rendered screen; the colour swatches are a
  // supplement for themes whose picture hasn't been regenerated.
  const picture = entry.preview
    ? <img src={entry.preview} alt={`${entry.name} preview`} loading="lazy" className="w-full rounded-md border border-edge-card" />
    : null;
  const swatches = entry.previewTokens ? (
    <div className="flex gap-2 flex-wrap" aria-label="Theme colours">
      {Object.entries(entry.previewTokens).map(([name, color]) => (
        <span key={name} title={name} className="inline-block w-8 h-8 rounded-md border border-edge-card" style={{ background: color as string }} />
      ))}
    </div>
  ) : null;

  // The picture large on the left; the top card and the colours on the right (Destin
  // picked "picture beside", marketplace-detail-2#M2-3/M2-4). The picture card has no
  // label: "dont need the text 'preview'" — it is a picture OF the item, like the top card.
  const sections: DetailSection[] = [];
  if (picture) sections.push({ id: "preview", label: "", node: picture });
  if (swatches) sections.push({ id: "colours", label: "Colours", side: true, node: swatches });

  return (
    <DetailPage
      title="Theme details"
      screen={screen}
      onClose={onClose}
      identity={identity}
      sections={sections}
      identitySide
    />
  );
}
