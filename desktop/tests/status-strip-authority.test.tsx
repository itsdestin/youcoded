// @vitest-environment jsdom
// desktop/tests/status-strip-authority.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { StatusStrip } from '../src/renderer/components/ui/StatusStrip';
import { inScopeFiles, stripComments, RENDERER, assertScopeIsPopulated } from './helpers/guard-scope';

// Guard for K5 (status strip) and K9 (danger zone).
//
// K5 and K4 are the pair most likely to collapse back into each other, because
// the difference is not visual — it is whether the block offers a way OUT of the
// state it describes. Callout has no action slot precisely so that a passive
// block cannot quietly grow a button and become a second status strip. These
// assertions pin the other half: a status strip HAS the slot, and the branches
// that used to be eleven hand-rolled shapes go through it.

afterEach(cleanup);

function strip(): HTMLElement {
  return screen.getByText('message').closest('.bg-inset') as HTMLElement;
}

describe('StatusStrip', () => {
  it('is one geometry regardless of tone', () => {
    const seen = new Set<string>();
    for (const tone of ['ok', 'warn', 'idle', 'busy'] as const) {
      cleanup();
      render(<StatusStrip tone={tone}>message</StatusStrip>);
      seen.add(strip().className);
    }
    expect(seen.size, 'tone must not change the container').toBe(1);
  });

  it('a state at rest gets a dot; a state in motion gets a spinner', () => {
    render(<StatusStrip tone="ok">message</StatusStrip>);
    expect(strip().querySelector('.rounded-full')).not.toBeNull();
    cleanup();
    render(<StatusStrip tone="busy">message</StatusStrip>);
    expect(strip().querySelector('.rounded-full'), 'busy replaces the dot').toBeNull();
  });

  it('carries the one action that resolves the state', () => {
    // This is the slot K4's Callout deliberately does NOT have. If a design
    // needs it, the block is a status strip, not a callout.
    render(<StatusStrip tone="idle" action={<button>Set up</button>}>message</StatusStrip>);
    expect(screen.getByRole('button', { name: 'Set up' })).toBeInTheDocument();
  });

  it('detail is a quieter second line, not a second status', () => {
    render(<StatusStrip tone="busy" detail="This may take a few minutes">message</StatusStrip>);
    const detail = screen.getByText('This may take a few minutes');
    expect(detail.className).toContain('text-3xs');
    expect(screen.getByText('message').className).toContain('text-xs');
  });
});

// ── Adoption ────────────────────────────────────────────────────────────────


/**
 * Debt this tranche did NOT pay, counted per file so it cannot grow silently.
 *
 * All three lists below are real findings, and none of them is K5's or K9's job.
 * Writing them as COUNTS rather than skipping the check turns each backlog into
 * a live number: the guard fails the moment someone adds one more.
 */

// Centred, colour-carrying status paragraphs on surfaces outside the settings
// menu family. Genuine K5 candidates — a status line with nowhere to put the
// action that resolves it — but on screens this tranche does not touch.
const CENTRED_STATUS_ELSEWHERE: Record<string, { count: number; why: string }> = {
  'FirstRunView.tsx': { count: 1, why: 'first-run setup screen, not a settings menu' },
  'ShareSheet.tsx': { count: 2, why: 'share flow' },
  'ThemeShareSheet.tsx': { count: 1, why: 'theme share flow' },
  'BugReportPopup.tsx': { count: 1, why: 'bug-report flow' },
};

// `someError || 'A hardcoded guess'`. THIS IS THE v1.3.1 ERROR AUDIT, which is
// its own tracked workstream — see docs/error-message-standards.md. K5 fixed
// exactly one of these, the Tailscale setup failure, because that one was in
// the branch it was already rewriting. Fixing the other nine here would be
// swallowing a scheduled audit into an unrelated tranche, and each needs the
// same judgement the audit exists to make: is a real detail available at this
// layer, or is this genuinely a general error?
const HARDCODED_ERROR_FALLBACK: Record<string, { count: number; why: string }> = {
  'AccountSection.tsx': { count: 1, why: "'Could not export data'" },
  // SettingsPanel.tsx is off this list as of the remote-access batch. Its one entry was
  // recorded as "the local-models installer, not remote access" — it was in fact remote
  // access's own Tailscale install (`result?.error || 'Installation failed'`), so the
  // batch that rewrote that flow was the right place to fix it. It now reports the
  // installer's own reason, or the general error when the installer gave none.
  'SyncPanel.tsx': { count: 1, why: "'Could not remove this device.'" },
  'SyncSetupWizard.tsx': { count: 6, why: 'six sign-in / install / repo-create branches' },
};

describe('status adoption', () => {
  it('no status line in the settings family is a centred coloured paragraph', () => {
    // The shape Remote Access used for four of its eleven branches:
    // `text-center` on a <p> carrying a status colour. It reads as a banner in
    // a column of left-aligned rows, and it has nowhere to put the action that
    // resolves the state — which is why two branches ended up with a
    // full-width button stacked underneath instead.
    const drift: string[] = [];
    for (const file of inScopeFiles()) {
      const name = file.split(/[\\/]/).pop()!;
      const src = stripComments(readFileSync(file, 'utf8'));
      let n = 0;
      for (const m of src.matchAll(/className="[^"]*text-center[^"]*"/g)) {
        if (/text-(green|amber|red)-\d{3}|text-destructive-fg/.test(m[0])) n++;
      }
      const allowed = CENTRED_STATUS_ELSEWHERE[name]?.count ?? 0;
      if (n !== allowed) drift.push(`${name}: ${n} centred status lines, expected ${allowed}`);
    }
    expect(drift, 'A subsystem status line is a <StatusStrip>.').toEqual([]);
  });

  it('no user-facing error falls back to a hardcoded cause', () => {
    // docs/error-message-standards.md: never catch and replace the real error
    // with a guess. `{setupError || 'Setup failed'}` gave the user two words and
    // no next step whenever the installer failed without setting a reason.
    //
    // Matches the SHAPE — a `||` fallback to a quoted string on a variable whose
    // name ends in Error — rather than that one string, because the next one
    // will be spelled differently.
    const drift: string[] = [];
    for (const file of inScopeFiles()) {
      const name = file.split(/[\\/]/).pop()!;
      const src = stripComments(readFileSync(file, 'utf8'));
      const n = [...src.matchAll(/\b\w*[eE]rror\s*\|\|\s*['"][^'"]+['"]/g)].length;
      const allowed = HARDCODED_ERROR_FALLBACK[name]?.count ?? 0;
      if (n !== allowed) drift.push(`${name}: ${n} hardcoded error fallbacks, expected ${allowed}`);
    }
    expect(
      drift,
      'Show the real error, or say you do not have one and offer Report bug / Diagnose with Claude '
        + '(<ErrorState mode="general">). A hardcoded fallback asserts a cause nobody verified. '
        + 'The counts above are the v1.3.1 audit backlog — they may shrink, never grow.',
    ).toEqual([]);
  });
});

describe('danger zones', () => {
  it('this guard can see what it claims to cover', () => {
    // A source-text guard that matches nothing PASSES and reads as clean.
    // Three of this workstream's worst misses were exactly that.
    assertScopeIsPopulated(inScopeFiles());
  });

  const COMPONENTS = join(RENDERER, 'components');

  it('every danger zone states its consequence in a danger callout', () => {
    // K9's shape. The three zones already had good consequence sentences — that
    // is why the copy pass turned out to be structural — but they lived in
    // three different containers: a raw text-[#DD4444] span inside a row
    // description, a bare <p>, and a bordered bg-inset box.
    for (const file of ['SettingsPanel.tsx', 'AccountSection.tsx', 'LocalModelsSection.tsx']) {
      const src = stripComments(readFileSync(join(COMPONENTS, file), 'utf8'));
      expect(src, `${file} should state its consequence in a danger Callout`).toMatch(
        /<Callout[^>]*tone="danger"/,
      );
    }
  });

  it('no danger-zone consequence rides the fixed status red', () => {
    // `text-[#DD4444]` is the hardcoded status red. Change 17 moved the app's
    // destructive surfaces onto the `destructive` token so theme packs can
    // restyle them; the Skip Permissions consequence line was still on the raw
    // hex, so a pack could restyle the toggle beside it and not the sentence
    // explaining what it does.
    //
    // SCOPED TO THE THREE DANGER ZONES, deliberately. #DD4444 survives in ~20
    // places app-wide (StatusBar, SessionStrip, FolderSwitcher, TagPicker and
    // more) and converting all of them is change 17's unfinished business, not
    // K9's. A guard that failed on all twenty would have been switched off.
    const DANGER_ZONES = ['SettingsPanel.tsx', 'AccountSection.tsx', 'LocalModelsSection.tsx'];
    const offenders: string[] = [];
    for (const file of DANGER_ZONES) {
      const src = stripComments(readFileSync(join(COMPONENTS, file), 'utf8'));
      // Only the class form — a bare mention in prose is not a style.
      if (/\[#DD4444\]/.test(src)) offenders.push(file);
    }
    expect(offenders, 'Use the destructive token, not the fixed status red.').toEqual([]);
  });
});
