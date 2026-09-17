// @vitest-environment jsdom
// desktop/tests/status-strip-authority.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { StatusStrip } from '../src/renderer/components/ui/StatusStrip';
import { inScopeFiles, readStripped } from './helpers/guard-scope';

// Guard for K5 (status strip) and K9 (danger zone).
//
// K5 and K4 are the pair most likely to collapse back into each other, because
// the difference is not visual — it is whether the block offers a way OUT of the
// state it describes. Callout has no action slot precisely so that a passive
// block cannot quietly grow a button and become a second status strip. These
// assertions pin the other half: a status strip HAS the slot, and the branches
// that used to be eleven hand-rolled shapes go through it.
//
// Plan B (2026-09-16) moved the source-text halves to workspace ast-grep rules
// (scripts/ast-grep/rules/): no-centred-status-paragraph and
// no-hardcoded-error-fallback hold every unlisted file at zero, and
// danger-zone-has-danger-callout / danger-zone-no-fixed-status-red pin K9's
// three danger zones. What stays here as text is only the exact per-file
// counts of the two debt lists below.

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
 *
 * Every file NOT listed is held at zero by the matching ast-grep rule, which
 * names these same files under its `ignores:`. Adding or removing an entry here
 * means editing that rule's list too.
 */

// Centred, colour-carrying status paragraphs on surfaces outside the settings
// menu family. Genuine K5 candidates — a status line with nowhere to put the
// action that resolves it — but on screens this tranche does not touch.
const CENTRED_STATUS_ELSEWHERE: Record<string, { count: number; why: string }> = {
  'FirstRunView.tsx': { count: 1, why: 'first-run setup screen, not a settings menu' },
  'ShareSheet.tsx': { count: 2, why: 'share flow' },
  // 2, not 1, since 2026-09-16: its green link-styled-as-a-button (the same <a> the
  // callout guard exempts) moved from text-emerald-500 to the status text-green-400,
  // which this pattern matches. Same element as before — it is a button, not a status line.
  'ThemeShareSheet.tsx': { count: 2, why: 'theme share flow; one is the green open-link button' },
  // 'BugReportPopup.tsx' was here with count 1 — the legacy review screen's amber
  // "High Claude usage" caption. That screen was deleted on 2026-09-10 when the
  // approved ticket screen replaced it for every user, so the exemption goes with
  // it. Removing the entry rather than lowering it to 0 is deliberate: a future
  // centred status line in this file should be caught, not pre-approved.
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
    //
    // WHY still a source read, and only for the listed files: every other file is
    // held at zero by the ast-grep rule no-centred-status-paragraph; an exact
    // per-file count ("ShareSheet has 2") is not something a rule can express.
    const drift: string[] = [];
    for (const file of inScopeFiles()) {
      const name = file.split(/[\\/]/).pop()!;
      const allowed = CENTRED_STATUS_ELSEWHERE[name]?.count;
      if (allowed === undefined) continue;
      const src = readStripped(file);
      let n = 0;
      for (const m of src.matchAll(/className="[^"]*text-center[^"]*"/g)) {
        if (/text-(green|amber|red)-\d{3}|text-destructive-fg/.test(m[0])) n++;
      }
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
    //
    // WHY still a source read, and only for the listed files: every other file is
    // held at zero by the ast-grep rule no-hardcoded-error-fallback; an exact
    // per-file count ("SyncSetupWizard has 6") is not something a rule can express.
    const drift: string[] = [];
    for (const file of inScopeFiles()) {
      const name = file.split(/[\\/]/).pop()!;
      const allowed = HARDCODED_ERROR_FALLBACK[name]?.count;
      if (allowed === undefined) continue;
      const src = readStripped(file);
      const n = [...src.matchAll(/\b\w*[eE]rror\s*\|\|\s*['"][^'"]+['"]/g)].length;
      if (n !== allowed) drift.push(`${name}: ${n} hardcoded error fallbacks, expected ${allowed}`);
    }
    expect(
      drift,
      'Show the real error, or say you do not have one and offer Report bug / Diagnose with the assistant '
        + '(<ErrorState mode="general">). A hardcoded fallback asserts a cause nobody verified. '
        + 'The counts above are the v1.3.1 audit backlog — they may shrink, never grow.',
    ).toEqual([]);
  });
});
