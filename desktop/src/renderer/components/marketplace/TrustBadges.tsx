// The two facts a listing carries (design 2026-08-27, decision #2):
//   ScanBadge   — WAS IT CHECKED: Likely safe · Caution · Not checked
//   SourceBadge — WHERE IT CAME FROM: the list we mirrored it out of
// Kept as two separate marks on purpose: merging them into one score hides
// the reason. Both are G-14 tag/badge shape — `sm` radius, icon + neutral
// text — never coloured text.
//
// Round 2 (Destin, 2026-08-28): the check mark is a grey SHIELD with a tick
// reading "Likely safe" (was a green dot reading "Checked"), and it comes
// first — safety is the question people are asking. The amber shield is the
// one documented hardcoded colour on this screen (STATUS_TONE vocabulary).
import React from 'react';
import type { CatalogMeta, OriginTier, ScanStatus } from '../../../shared/catalog-types';
import { OriginIcon } from './type-icons';
import { Chip, CHIP } from '../ui';

// WHY THIS REPLACED THE "Verified / Community" TIER (2026-08-31).
//
// The old badge said "Verified" and its tooltip claimed "the publisher proved they own
// this name (their GitHub account or website matches)". No such check exists anywhere in
// the ingest or the Worker — it was never written. What the tier actually recorded is
// which upstream list a row was copied out of: Anthropic's official plugin list, the
// github/awesome-copilot repo, or an image Docker themselves built.
//
// Three things made that worse than merely vague. It sat on 89% of the catalog (3,681 of
// 4,156 rows), so it drew the eye without dividing anything. It contradicted the badge
// beside it — 1,268 rows read "Verified" and "Not checked" at the same time. And it drew
// a SHIELD WITH A TICK, all but identical to the safety shield, so the strongest trust
// mark on the screen was making a promise nobody had checked.
//
// Naming the list instead is shorter, true, and strictly more informative: "Anthropic"
// tells you who curated it, and the safety shield beside it stays the only claim about
// whether anyone looked at the code.
const SOURCE_LABEL: Record<string, string> = {
  'anthropics/claude-plugins-official': 'Anthropic',
  'github/awesome-copilot': 'GitHub',
  'Docker MCP Catalog': 'Docker',
  'PatrickJS/awesome-cursorrules': 'awesome-cursorrules',
};

/** The list this listing was mirrored out of, as a person would say it. `null` when we
 *  published it ourselves — the YouCoded case is named, not sourced. */
export function sourceLabel(origin: CatalogMeta['origin']): string | null {
  if (origin.tier === 'youcoded') return 'YouCoded';
  const from = origin.mirroredFrom;
  if (!from) return null;
  // Fall back to the last path segment so an upstream we have not mapped still reads as
  // a name rather than an owner/repo slug.
  return SOURCE_LABEL[from] ?? from.split('/').pop() ?? from;
}

export function sourceExplainer(origin: CatalogMeta['origin']): string {
  if (origin.tier === 'youcoded') return 'Made and maintained by the YouCoded team.';
  const name = sourceLabel(origin);
  // Deliberately says only what is true: we copied this listing from that list. It makes
  // no claim about the publisher's identity and none about safety — the shield beside it
  // is the only thing that speaks to whether the code was looked at.
  return `Listed because ${name} carries it in their catalogue. That is where it came from — it is not a check of who published it, or of what the code does.`;
}

export const SCAN_LABEL: Record<ScanStatus, string> = {
  checked: 'Likely safe',
  caution: 'Caution',
  unchecked: 'Not checked',
};

export function scanExplainer(scan: CatalogMeta['scan']): string {
  const n = scan.findings?.length ?? 0;
  if (scan.status === 'checked') {
    return `An automatic check read every file in this version${scan.checkedAt ? ` on ${new Date(scan.checkedAt).toLocaleDateString()}` : ''} and found nothing suspicious. "Likely" because no check is perfect — see "What this can do" for what it actually does.`;
  }
  if (scan.status === 'caution') {
    return `The automatic check found ${n} thing${n === 1 ? '' : 's'} worth reading before you install — they are listed under "What this can do".`;
  }
  // Task 15 (Destin, 2026-08-30): the grey shield stays, so it has to earn its
  // space. "Not checked" on its own only describes our system; roughly half the
  // catalog will carry it, and a badge that names a state the user can do
  // nothing with is noise. This sentence hands the check back to them and names
  // the two things they can actually look at. Copy pending Destin's sign-off.
  return 'We haven\'t checked this one — read "What this can do" and look at the source before you install it.';
}

// The fact chip's own box (components/ui/Chip.tsx) — the badges below ARE chips, with an icon.
const BADGE = CHIP;

/** Shield glyph: tick (checked), exclamation (caution), or empty outline. */
export function ShieldIcon({ status, size = 12 }: { status: ScanStatus; size?: number }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...common} aria-hidden>
      <path d="M12 2l8 3v6c0 5-3.5 9.5-8 11-4.5-1.5-8-6-8-11V5z" />
      {status === 'checked' && <path d="M8.5 12l2.5 2.5 4.5-5" />}
      {status === 'caution' && <path d="M12 8v5M12 16.5v.5" />}
    </svg>
  );
}

const SHIELD_TONE: Record<ScanStatus, string> = {
  checked: 'text-fg-dim',
  caution: 'text-amber-400',
  unchecked: 'text-fg-muted',
};

export function ScanBadge({ scan, size = 'sm', responsiveLabel = false }: { scan: CatalogMeta['scan']; size?: 'sm' | 'md'; responsiveLabel?: boolean }) {
  const n = scan.findings?.length ?? 0;
  const label = scan.status === 'caution' && n > 0 ? `${SCAN_LABEL.caution} ${n}` : SCAN_LABEL[scan.status];
  return (
    // The shared fact chip (components/ui/Chip.tsx).
    <Chip className={size === 'md' ? 'text-xs px-2' : ''} title={scanExplainer(scan)} aria-label={label} data-scan={scan.status}>
      <span className={`inline-flex ${SHIELD_TONE[scan.status]}`}><ShieldIcon status={scan.status} size={size === 'md' ? 14 : 12} /></span>
      {/* `responsiveLabel`: below the sm breakpoint show only the shield (the
          text wrapped the badge row onto two lines inside a phone-width card).
          WHY zero-width, not `hidden` (2026-10-05): a hidden label left the chip with no line
          of text, so it was only the icon's height — 18px beside 22.5px chips (shoot's
          "parts agree" check). Squeezed to no width, the words still give the chip its line
          height; -ml-1 takes back the gap they would leave. */}
      <span className={responsiveLabel ? 'max-sm:w-0 max-sm:-ml-1 max-sm:overflow-hidden' : undefined}>{label}</span>
    </Chip>
  );
}

/** Round 2 (Destin): the author is a chip in the same row as the two trust
 *  badges, on every surface — not a line of grey text under the title. */
export function AuthorBadge({ author, size = 'sm' }: { author: string; size?: 'sm' | 'md' }) {
  return (
    // min-w-0 + overflow-hidden let the chip shrink and its name truncate
    // ("@des…") instead of the whole chip being clipped by the card edge.
    <span className={`${size === 'md' ? `${BADGE} text-xs px-2` : BADGE} max-w-[9rem] min-w-[3.75rem] overflow-hidden`} title={`Published by ${author}`} data-author>
      <span className="text-fg-dim inline-flex" aria-hidden>
        <svg width={size === 'md' ? 14 : 12} height={size === 'md' ? 14 : 12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21a8 8 0 0 1 16 0" />
        </svg>
      </span>
      <span className="truncate min-w-0">{author}</span>
    </span>
  );
}

/** Where the listing came from. Renders nothing when there is nothing true to say.
 *  No shield: the old one was visually a second safety mark. */
export function SourceBadge({ origin, size = 'sm' }: { origin: CatalogMeta['origin']; size?: 'sm' | 'md' }) {
  const label = sourceLabel(origin);
  if (!label) return null;
  return (
    <span className={size === 'md' ? `${BADGE} text-xs px-2` : BADGE} title={sourceExplainer(origin)} data-origin={origin.tier} data-source={label}>
      <span className="text-fg-dim inline-flex" aria-hidden><OriginIcon tier={origin.tier} size={size === 'md' ? 14 : 12} /></span>
      {label}
    </span>
  );
}
