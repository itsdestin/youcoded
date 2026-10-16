// @vitest-environment jsdom
// Pins the three scan-badge states and their hover explanations.
//
// WHY this test exists: Destin settled on 2026-08-30 that the grey "Not
// checked" shield STAYS (it is expected to sit on roughly half the catalog),
// which only works if the badge earns its space — its hover text has to tell
// the user what to DO about it, not just name a state. That sentence is the
// whole point of the badge, so it is pinned here rather than left to drift.

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { AuthorBadge, ScanBadge, scanExplainer, SCAN_LABEL, SourceBadge, sourceLabel, sourceExplainer } from '../src/renderer/components/marketplace/TrustBadges';
import type { CatalogMeta } from '../src/shared/catalog-types';
import { Chip } from '../src/renderer/components/ui';

afterEach(cleanup);

describe('ScanBadge', () => {
  it('renders one badge per status with its own label', () => {
    expect(SCAN_LABEL.checked).toBe('Likely safe');
    expect(SCAN_LABEL.caution).toBe('Caution');
    expect(SCAN_LABEL.unchecked).toBe('Not checked');
  });

  it('puts the explanation on hover, keyed to the status', () => {
    const { container } = render(<ScanBadge scan={{ status: 'unchecked' }} />);
    const badge = container.querySelector('[data-scan="unchecked"]')!;
    expect(badge.getAttribute('title')).toBe(scanExplainer({ status: 'unchecked' }));
    expect(screen.getByText('Not checked')).toBeInTheDocument();
  });

  it('counts the findings in the caution label', () => {
    render(<ScanBadge scan={{ status: 'caution', findings: ['a', 'b'] }} />);
    expect(screen.getByText('Caution 2')).toBeInTheDocument();
  });

  it('the unchecked explanation tells the user what to do about it', () => {
    const text = scanExplainer({ status: 'unchecked' });
    // Names the two things a user can actually check for themselves.
    expect(text).toMatch(/What this can do/);
    expect(text).toMatch(/source/i);
    // …and says it before the install, which is the only moment it helps.
    expect(text).toMatch(/install/i);
    // One sentence — a paragraph in a tooltip does not get read.
    expect(text.split('.').filter((s) => s.trim()).length).toBe(1);
  });

  it('never claims a check that did not happen', () => {
    expect(scanExplainer({ status: 'checked' })).toMatch(/read every file/i);
    expect(scanExplainer({ status: 'unchecked' })).not.toMatch(/found nothing/i);
  });
});

// ── Where it came from ──────────────────────────────────────────────────────
//
// WHY THIS EXISTS: until 2026-08-31 this badge said "Verified" and its hover text
// claimed "the publisher proved they own this name (their GitHub account or website
// matches)". No such check has ever existed in the ingest or the Worker — it was a
// trust claim the product could not back, on the most trust-loaded word in the UI,
// drawn as a shield with a tick right beside the real safety shield. It shipped
// because nothing pinned it. These tests are that pin: the badge may only ever name
// where a listing was mirrored from, and must never again imply a check of the
// publisher or of the code.
describe('SourceBadge — names the list, never a vetting', () => {
  const origin = (tier: 'youcoded' | 'verified' | 'community', mirroredFrom?: string) =>
    ({ tier, ...(mirroredFrom ? { mirroredFrom } : {}) }) as CatalogMeta['origin'];

  it('shows the real source name, not a trust tier', () => {
    expect(sourceLabel(origin('verified', 'anthropics/claude-plugins-official'))).toBe('Anthropic');
    expect(sourceLabel(origin('verified', 'github/awesome-copilot'))).toBe('GitHub');
    expect(sourceLabel(origin('community', 'Docker MCP Catalog'))).toBe('Docker');
    expect(sourceLabel(origin('youcoded'))).toBe('YouCoded');
  });

  it('never renders the words that made a promise nobody kept', () => {
    for (const o of [origin('verified', 'github/awesome-copilot'), origin('community', 'Docker MCP Catalog')]) {
      render(<SourceBadge origin={o} />);
    }
    expect(screen.queryByText('Verified')).toBeNull();
    expect(screen.queryByText('Community')).toBeNull();
  });

  it('the hover text claims nothing about the publisher or the code', () => {
    const text = sourceExplainer(origin('verified', 'anthropics/claude-plugins-official'));
    expect(text).toMatch(/Anthropic/);
    // The three claims it must never make again.
    expect(text).not.toMatch(/proved/i);
    expect(text).not.toMatch(/own this name/i);
    expect(text).not.toMatch(/verif/i);
    // …and it must say plainly what it is NOT.
    expect(text).toMatch(/not a check/i);
  });

  it('renders nothing when there is nothing true to say', () => {
    // A community row with no upstream list: silence beats an empty trust word.
    const { container } = render(<SourceBadge origin={origin('community')} />);
    expect(container.firstChild).toBeNull();
  });

  it('falls back to a readable name for an upstream we have not mapped', () => {
    expect(sourceLabel(origin('community', 'SomeOwner/some-new-list'))).toBe('some-new-list');
  });
});

// A detail page's chip row is ONE size (Destin, reviewing the detail pages: "the chips are
// different sizes for some reason (install is tiny)"). The row mixed three chip recipes —
// these badges, the shared Badge (same font size but a tighter line, so a shorter box) and
// a thumbs summary carrying its own larger text — and nothing compared them. Pinned here as
// the cause, not a pixel: every fact chip renders with the badges' own box.
describe('fact chips share the badge box', () => {
  it('renders the fact chip, the scan, source and author badges with one box', () => {
    const cls = (ui: React.ReactElement) => (render(ui).container.firstElementChild as HTMLElement).className;
    const meta = cls(<Chip>412 installs</Chip>);
    expect(cls(<ScanBadge scan={{ status: 'checked' }} />)).toBe(meta);
    expect(cls(<SourceBadge origin={{ tier: 'youcoded' }} />)).toBe(meta);
    // The author chip adds only its truncation limits on top of the same box.
    expect(cls(<AuthorBadge author="someone" />).startsWith(meta)).toBe(true);
  });
});
