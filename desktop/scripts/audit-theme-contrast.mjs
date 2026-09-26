#!/usr/bin/env node
// Theme contrast audit — all 4 built-in themes plus every community theme in
// the sibling wecoded-themes checkout.
//
// WHY THIS WAS REWRITTEN (2026-07-19)
// -----------------------------------
// This script used to carry its own hand-written list of 8 token pairs, all
// measured against `canvas`. It was the THIRD independent implementation of the
// same idea — alongside the theme-builder's contrast-rules.js and
// wecoded-themes/scripts/audit-contrast.mjs — each with different pairs and
// different thresholds.
//
// Three tables in three repos is how the app shipped with:
//   - `fg-muted` failing on raised surfaces in 9 of 11 themes
//   - `fg-faint` never once passing on a raised surface in any shipped theme,
//     while being used as real text in ~107 places
//   - meadow-mist painting text at a genuine 1.01 contrast (identical
//     luminance) while every audit reported 1.24, because they all measured the
//     flat `inset` token instead of the glass composite the app actually paints
//
// The rules now live in ONE place — the theme-builder skill in
// wecoded-marketplace — and this script consumes a vendored copy at
// scripts/vendor/contrast-rules.js. Do not edit that file by hand.
// tests/theme-builtin-sources.test.ts uses the same copy, so the audit and the
// test can no longer disagree about what "passing" means.
//
// Run from anywhere: node scripts/audit-theme-contrast.mjs

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const rules = require('./vendor/contrast-rules.js');

const builtinDir = resolve(scriptDir, '..', 'src', 'renderer', 'themes', 'builtin');

// --- Coverage floor -------------------------------------------------------
// WHY this exists: on 2026-07-22 a consolidation (PR #187) dropped `panel/canvas`
// and `on-destructive/destructive` from the rule table. Nothing failed — the audit
// printed "All 11 themes pass" while creme still shipped panel/canvas at 1.051 and
// every theme shipped a danger label at 4.21:1. Removing a check makes this script
// QUIETER, not louder, so two live bugs hid behind a green run and their repro
// commands silently stopped reproducing.
//
// The lesson recorded at the time: "a consolidation that removes checks needs a
// before/after count of rules evaluated, because a shrinking rule set is invisible
// in a green run." These constants are that count. A green run must now also prove
// the audit actually CHECKED something.
//
// Bump these deliberately when adding rules to contrast-rules.js. If a change
// LOWERS them, that is the review conversation this guard exists to force.
const EXPECTED_RULES = { HARD: 32, SURFACE: 6, SOFT: 4 }; // SOFT 4: + Minimalist control outline (2026-09-24)

const coverage = { HARD: new Set(), SURFACE: new Set(), SOFT: new Set() };
const skippedEverywhere = new Map(); // rule name -> how many themes skipped it
const evaluatedSomewhere = new Set(); // rule names that ran for at least one theme

function loadBuiltins() {
  return readdirSync(builtinDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const j = JSON.parse(readFileSync(join(builtinDir, f), 'utf8'));
      // Built-ins are opaque — no wallpaper, so the flat token IS what is painted.
      return { slug: j.slug, tokens: j.tokens, opts: {}, kind: 'builtin' };
    });
}

function loadCommunity() {
  // Workspace layout puts wecoded-themes as a sibling of youcoded/.
  const themesRoot = resolve(scriptDir, '..', '..', '..', 'wecoded-themes', 'themes');
  if (!existsSync(themesRoot)) {
    console.warn(`[skip] wecoded-themes not found at ${themesRoot} — community themes not audited`);
    return [];
  }
  const out = [];
  for (const slug of readdirSync(themesRoot).sort()) {
    const p = join(themesRoot, slug, 'manifest.json');
    if (!existsSync(p)) continue;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (!j.tokens) continue;
    const bg = j.background || {};
    const panelsOpacity = typeof bg['panels-opacity'] === 'number' ? bg['panels-opacity'] : 1;
    out.push({
      slug: j.slug || slug,
      tokens: j.tokens,
      // Wallpaper themes paint surfaces translucently, so measure the composite.
      // `average-color` is precomputed by the theme-builder — decoding the image
      // here would mean adding an image dependency to a zero-dep script.
      opts: { wallpaperAvg: bg['average-color'] || null, panelsOpacity },
      kind: 'community',
      needsGlass: panelsOpacity < 1 && !bg['average-color'],
    });
  }
  return out;
}

const themes = [...loadBuiltins(), ...loadCommunity()];
const failing = [];
const warnings = [];

for (const t of themes) {
  if (t.needsGlass) {
    warnings.push(
      `${t.slug}: translucent panels but no background.average-color — audited FLAT, ` +
        `which understates the real ratios. Re-run the theme-builder to populate it.`,
    );
  }

  const { results, hardFails, surfaceFails, softWarns, glassAware } = rules.evaluate(t.tokens, t.opts);
  const blocking = hardFails + surfaceFails;
  if (blocking > 0) failing.push(t.slug);

  // Coverage bookkeeping — see EXPECTED_RULES above. Rule-table size is a property
  // of the ruleset, not the theme (a rule with a missing token still appears with
  // status SKIP), so every theme must yield identical per-tier counts.
  for (const tier of ['HARD', 'SURFACE', 'SOFT']) {
    coverage[tier].add(results[tier].length);
    for (const r of results[tier]) {
      if (r.status === 'SKIP') skippedEverywhere.set(r.rule, (skippedEverywhere.get(r.rule) ?? 0) + 1);
      else evaluatedSomewhere.add(r.rule);
    }
  }

  const glassNote = glassAware
    ? ` [glass ${Math.round(t.opts.panelsOpacity * 100)}% over ${t.opts.wallpaperAvg}]`
    : '';
  console.log(`\n${blocking > 0 ? '❌' : '✓'} ${t.slug} (${t.kind})${glassNote}`);

  for (const tier of ['HARD', 'SURFACE', 'SOFT']) {
    for (const r of results[tier]) {
      if (r.status === 'PASS') continue;
      if (r.status === 'SKIP') {
        console.log(`    · ${tier.padEnd(7)} ${r.rule.padEnd(24)} skipped — ${r.reason}`);
        continue;
      }
      console.log(
        `${tier === 'SOFT' ? '  ⚠' : '  ✗'} ${tier.padEnd(7)} ${r.rule.padEnd(24)} ` +
          `${String(r.actual).padStart(6)} (min ${r.threshold}) — ${r.description}`,
      );
    }
  }
  if (blocking === 0 && softWarns === 0) console.log('    all checks pass');
}

console.log('\n────────────────────────────────────────');
for (const w of warnings) console.log(`⚠ ${w}`);

// --- Coverage check: did this run actually check anything? ---
const coverageErrors = [];
for (const tier of ['HARD', 'SURFACE', 'SOFT']) {
  const seen = [...coverage[tier]];
  if (seen.length > 1) {
    coverageErrors.push(`${tier}: themes disagree on rule count (${seen.join(', ')}) — the table must be theme-independent`);
  } else if (seen[0] !== EXPECTED_RULES[tier]) {
    const delta = seen[0] < EXPECTED_RULES[tier] ? 'FEWER' : 'more';
    coverageErrors.push(
      `${tier}: ${seen[0] ?? 0} rules evaluated, expected ${EXPECTED_RULES[tier]} — ` +
        `the ruleset has ${delta} rules than when this floor was set`,
    );
  }
}

// A rule skipped for EVERY theme is checking nothing. This is the second way the
// 2026-07-22 incident hid: destructive/on-destructive were skipped for all themes
// because most packs never declare those tokens, so "auditing only declared
// tokens skipped every theme" — green, and blind.
for (const [rule, count] of skippedEverywhere) {
  if (!evaluatedSomewhere.has(rule) && count === themes.length) {
    coverageErrors.push(`"${rule}" was SKIPPED for all ${themes.length} themes — it is checking nothing`);
  }
}

// Report what ACTUALLY ran, not what was expected — a coverage line that prints the
// expected count during a coverage failure would be the same class of lie this guard
// exists to catch.
const actual = Object.fromEntries(
  ['HARD', 'SURFACE', 'SOFT'].map((tier) => [tier, [...coverage[tier]][0] ?? 0]),
);
const actualTotal = Object.values(actual).reduce((a, b) => a + b, 0);
const skipNote = skippedEverywhere.size > 0 ? `, ${skippedEverywhere.size} rule(s) skipped somewhere` : '';
console.log(
  `coverage: ${actualTotal} rules × ${themes.length} themes = ${actualTotal * themes.length} checks ` +
    `(HARD ${actual.HARD} / SURFACE ${actual.SURFACE} / SOFT ${actual.SOFT})${skipNote}`,
);

if (coverageErrors.length > 0) {
  console.log('\n❌ COVERAGE FAILURE — this run did not check what it claims to check:');
  for (const e of coverageErrors) console.log(`  - ${e}`);
  console.log('\nA shrinking ruleset is invisible in a green run. Update EXPECTED_RULES');
  console.log('deliberately if the change is intended; otherwise a check was lost.');
  process.exit(1);
}

if (failing.length === 0) {
  console.log(`All ${themes.length} themes pass HARD and SURFACE checks.`);
  process.exit(0);
}
console.log(`${failing.length} of ${themes.length} themes fail a blocking check:`);
for (const slug of failing) console.log(`  - ${slug}`);
process.exit(1);
