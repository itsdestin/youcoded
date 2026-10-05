// The integration detail page (Google Workspace, Todoist, iMessage…). Moved out of
// MarketplaceScreen.tsx in the 2026-10-04 detail redesign: it was a second, hand-copied
// version of the plugin page that had drifted (its own 18px header, the words Esc and Close,
// a full-width line under the header, hand-typed button classes, a coloured status
// pill). It is now built from the same shell as every other detail page
// (DetailPage.tsx) — only what an integration DOES differs: Install / Connect /
// Uninstall, and the "finish setup" command after connecting.
import React, { useState } from "react";
import type { IntegrationEntry, IntegrationState } from "../../../shared/types";
import { platformListDisplay } from "../../../shared/platform-display";
import { Button, Callout, Chip, Pill, SettingRow } from "../ui";
import type { PillTone } from "../ui/Pill";
import { DetailActions, DetailIdentity, DetailPage, PAIRED_PRIMARY, type DetailSection } from "./DetailPage";

export type IntegrationCardItem = IntegrationEntry & { state: IntegrationState };

export type IntegrationStatus = { text: string; tone: 'ok' | 'warn' | 'err' | 'neutral' | 'locked' };

// WHY the shared tinted pill instead of STATUS_TONE_CLASS: those colour the WORDS
// (green-400 / amber-400 text), which fails on the pale themes; the guide's status pill
// keeps the colour in the tint and the words in the normal text colour (guide "Status
// and notices"; decisions S-1).
const PILL_TONE: Record<IntegrationStatus['tone'], PillTone> = {
  ok: 'ok', warn: 'warning', err: 'danger', neutral: 'neutral', locked: 'neutral',
};

export function IntegrationDetailOverlay({
  item, onClose, onInstall, onConnect, onUninstall,
  statusBadge, iconUrl, platformBlocked, platformBlockedName,
  setupHint, onDismissSetupHint, onOpenSetupSession,
}: {
  item: IntegrationCardItem;
  onClose(): void;
  onInstall(): void | Promise<void>;
  onConnect(): void | Promise<void>;
  onUninstall(): void | Promise<void>;
  statusBadge: IntegrationStatus;
  iconUrl?: string;
  platformBlocked: boolean;
  platformBlockedName: string | null;  // e.g. "macOS" when blocked, else null
  // Shown after install/connect when the integration has a postInstallCommand.
  // Replaces the old auto-type-into-new-session flow.
  setupHint: { displayName: string; command: string } | null;
  onDismissSetupHint(): void;
  onOpenSetupSession(): void;
}) {
  // Which buttons show. Precedence (unchanged): platform-blocked > planned >
  // deprecated > install-error > install-state — see the 2026-04-22 integration
  // polish spec §6. WHY no button at all for blocked / planned / deprecated: those
  // were DISABLED buttons reading "macOS only" / "Coming soon" / "Deprecated" — a
  // status dressed as a button (guide "Card levels": nothing that isn't a button
  // looks like one). The same words are the status pill on the top line.
  // Likewise the disabled "Settings (Coming soon…)" button is gone: it did nothing.
  const s = item.state;
  const blocked = platformBlocked && !!platformBlockedName;
  const unavailable = blocked || item.status !== 'available';
  let actions: React.ReactNode = null;
  if (!unavailable) {
    if (!s.installed) {
      actions = <DetailActions><Button size="lg" className={PAIRED_PRIMARY} onClick={() => { void onInstall(); }}>{s.error ? 'Retry install' : 'Install'}</Button></DetailActions>;
    } else if (!s.connected) {
      actions = (
        <DetailActions>
          <Button variant="secondary" size="lg" onClick={() => { void onUninstall(); }}>Uninstall</Button>
          <Button size="lg" className={PAIRED_PRIMARY} onClick={() => { void onConnect(); }}>Connect</Button>
        </DetailActions>
      );
    } else {
      actions = <DetailActions><Button variant="secondary" size="lg" onClick={() => { void onUninstall(); }}>Uninstall</Button></DetailActions>;
    }
  }

  // The big tile stays (marketplace-detail-3#M3-2), on one centre line with the name,
  // description and buttons (marketplace-detail-4#M4-1 "row"). The integration's own icon
  // image wins over the letter when it has one.
  const icon = (
    <div
      className="w-10 h-10 rounded-lg shrink-0 overflow-hidden bg-inset flex items-center justify-center text-on-accent text-lg font-semibold"
      style={iconUrl ? undefined : { background: item.accentColor || 'var(--accent)' }}
      aria-hidden
    >
      {iconUrl ? <img src={iconUrl} alt="" className="w-full h-full object-contain" /> : item.displayName.slice(0, 1)}
    </div>
  );

  const identity = (
    <DetailIdentity
      icon={icon}
      name={item.displayName}
      iconLayout="row"
      status={<Pill tone={PILL_TONE[statusBadge.tone]}>{statusBadge.text}</Pill>}
      description={item.tagline}
      actions={actions}
    >
      {/* The error is a notice inside the item's card, words in the normal text colour
          (guide "Status and notices"), not a red line clipped to 40 characters. */}
      {s.error && <Callout tone="danger" title="Something went wrong">{s.error}</Callout>}
      {setupHint && (
        <SetupHint command={setupHint.command} onDismiss={onDismissSetupHint} onOpenSetupSession={onOpenSetupSession} />
      )}
    </DetailIdentity>
  );

  const sections: DetailSection[] = [];
  const tags = item.tags || [];
  const areas = item.lifeArea || [];
  if (item.longDescription || tags.length || areas.length) {
    sections.push({
      id: 'about',
      label: 'About',
      node: (
        <div className="space-y-3">
          {item.longDescription && <p className="text-sm text-fg-2 whitespace-pre-wrap">{item.longDescription}</p>}
          {(tags.length > 0 || areas.length > 0) && (
            <div className="flex flex-wrap gap-1.5 items-center">
              {tags.map((t) => <Chip key={`tag-${t}`}>#{t}</Chip>)}
              {areas.map((a) => <Chip key={`area-${a}`}>{a.charAt(0).toUpperCase() + a.slice(1)}</Chip>)}
            </div>
          )}
        </div>
      ),
    });
  }
  const setup = setupFacts(item);
  if (setup.length) {
    sections.push({
      id: 'setup',
      label: 'Setup',
      side: true,
      node: (
        // Setting rows, not a bulleted list: each is one fact with its own title
        // (guide "Settings" → rows use the shared setting row).
        <div className="space-y-2">
          {setup.map((f) => <SettingRow key={f.title} variant="item" title={f.title} description={f.detail} />)}
        </div>
      ),
    });
  }

  return (
    <DetailPage
      title="Integration details"
      screen="marketplace/integration-detail"
      onClose={onClose}
      identity={identity}
      sections={sections}
    />
  );
}

/** What setting it up involves — derived from setup.type / requiresOAuth /
 *  postInstallCommand / platforms. No new registry fields. */
function setupFacts(entry: IntegrationCardItem): Array<{ title: string; detail?: string }> {
  const out: Array<{ title: string; detail?: string }> = [];
  if (entry.setup.type === 'api-key' && entry.setup.keyName) out.push({ title: 'Needs an API key', detail: entry.setup.keyName });
  if (entry.setup.requiresOAuth) out.push({ title: `Signs in with ${entry.setup.oauthProvider || 'your account'}` });
  if (entry.platforms && entry.platforms.length > 0) out.push({ title: `Works on ${platformListDisplay(entry.platforms)}` });
  if (entry.setup.postInstallCommand) out.push({ title: 'Finishes setup in a chat', detail: `Runs ${entry.setup.postInstallCommand}` });
  return out;
}

// Post-install / post-connect notice: the slash command the user must run to finish
// setup, with Copy and a shortcut that creates an empty "Set up <X>" session (the user
// still runs the command there — auto-typing raced the CLI's boot). WHY the info notice
// with its buttons inside, at the right (guide "Status and notices"; decisions P-2):
// it is a message about this one item, and its old accent box with a bare "Dismiss"
// word was a look of its own.
function SetupHint({ command, onDismiss, onOpenSetupSession }: {
  command: string;
  onDismiss(): void;
  onOpenSetupSession(): void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    // navigator.clipboard exists in Electron renderer; fall through silently if the
    // API is missing so the user can still read + retype the command.
    try {
      if (navigator?.clipboard?.writeText) {
        void navigator.clipboard.writeText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }
    } catch { /* ignore — user can still read the command */ }
  };
  return (
    <Callout
      tone="info"
      title="Installed — one step left"
      actionsPlacement="below"
      actions={
        <>
          <Button variant="secondary" size="sm" onClick={onDismiss}>Dismiss</Button>
          <Button variant="secondary" size="sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
          <Button size="sm" onClick={onOpenSetupSession}>Open new setup session</Button>
        </>
      }
    >
      To finish setup, run <code className="px-1 py-0.5 rounded bg-inset text-fg font-mono">{command}</code> in any chat.
    </Callout>
  );
}
