// tooltip-adoption.test.ts — the three ways a `title=` swap goes wrong silently.
//
// This file used to also assert the three shape checks below — all converted
// to ast-grep rules `tooltip-wraps-forwarding-element`,
// `tooltip-title-is-not-data` and `tooltip-key-on-wrapper-not-child` (retired
// by Plan B, 2026-09-16). What's left is the ONE case ast-grep cannot
// express: a plain count of real <Tooltip> sites, kept per global.md's
// non-vacuity rule (a source-text guard matching nothing PASSES and reads as
// clean — this is the cheapest proof the walk still reaches real files).
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readSource } from './helpers/guard-scope';

const ROOT = join(__dirname, '..', 'src', 'renderer');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'workbench' ? [] : tsxFiles(p);
    return p.endsWith('.tsx') ? [p] : [];
  });
}

function tooltipSiteCount(): number {
  let count = 0;
  for (const file of tsxFiles(ROOT)) {
    // NOT comment-stripped — the retired test never stripped comments here
    // either (unlike section-label-authority.test.ts's guard).
    const src = readSource(file);
    count += [...src.matchAll(/<Tooltip\b[^>]*>/g)].length;
  }
  return count;
}

describe('the hint swap cannot break the control it describes', () => {
  it('this guard can see what it claims to cover', () => {
    // A source-text guard matching nothing PASSES and reads as clean.
    expect(tooltipSiteCount()).toBeGreaterThan(40);
  });
});
