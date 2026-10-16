// "What this can do" — the plain-words list of what an item does to your
// machine once installed, computed from its files, shown ABOVE the Install
// button on the detail page (design 2026-08-27, decision #3). The card shows
// only the risky glyphs (`CapabilityGlyphs`) so they can be spotted while
// scrolling; the full sentences live here.
import React from 'react';
import type { CatalogMeta, Capability } from '../../../shared/catalog-types';
import { RISKY_CAPABILITY_KINDS } from '../../../shared/catalog-types';
import { CapabilityIcon } from './type-icons';
import { Callout } from '../ui';

export const CAPABILITY_TITLE: Record<Capability['kind'], string> = {
  shell: 'Runs commands',
  network: 'Uses the internet',
  secret: 'Needs a key',
  files: 'Reads or writes files',
  auto: 'Runs on its own',
  adds: 'Adds things',
};

/** One line of words for cards — risky kinds only, deduplicated, e.g.
 *  "Runs commands · Uses the internet · Needs a key". Round 2 replaced the
 *  glyph row: the globe / key icons were not self-explanatory. */
export function capabilityLine(capabilities: Capability[]): string | null {
  const kinds = Array.from(new Set(capabilities.map((c) => c.kind))).filter((k) => RISKY_CAPABILITY_KINDS.includes(k));
  if (kinds.length === 0) return null;
  return kinds.map((k) => CAPABILITY_TITLE[k]).join(' · ');
}

/** Full list for the detail page — the CONTENTS of its "What this can do" card (the
 *  page draws the label and the card; DetailPage.tsx). Renders the "nothing risky" line
 *  when the catalog block exists but lists no capabilities, so the section never
 *  silently vanishes — an empty panel would read as "we didn't look". */
export function CapabilityList({ catalog }: { catalog: CatalogMeta }) {
  const caps = catalog.capabilities;
  const risky = caps.filter((c) => RISKY_CAPABILITY_KINDS.includes(c.kind));
  const rest = caps.filter((c) => !RISKY_CAPABILITY_KINDS.includes(c.kind));
  const findings = catalog.scan.status === 'caution' ? catalog.scan.findings ?? [] : [];
  return (
    <div className="flex flex-col gap-2 text-sm" data-capabilities>
      {caps.length === 0 && (
        <div className="flex items-center gap-2 text-fg-2">
          <span className="text-fg-dim inline-flex"><CapabilityIcon kind="adds" /></span>
          Adds instructions only — no commands, no internet, no files outside its own folder.
        </div>
      )}
      {[...risky, ...rest].map((c, i) => (
        <div key={i} className="flex items-start gap-2">
          <span className="text-fg-dim inline-flex mt-0.5 shrink-0"><CapabilityIcon kind={c.kind} /></span>
          <span className="text-fg-2">
            {c.label}
            {c.detail && <span className="text-fg-dim"> · {c.detail}</span>}
          </span>
        </div>
      ))}
      {/* WHY the warning notice box, not a ruled-off list with amber dots: the flagged
          findings are a warning about THIS item, so they are the one notice look, inside
          the card they are about (guide "Status and notices"; decisions W-1, P-4), and a
          line across the card is never used to separate (guide "Card levels"). */}
      {findings.length > 0 && (
        <Callout tone="warning" title="The automatic check flagged" className="mt-1">
          <ul className="list-disc pl-4 space-y-0.5">
            {findings.map((f, i) => <li key={i}>{f}</li>)}
          </ul>
        </Callout>
      )}
    </div>
  );
}
