// @vitest-environment jsdom
// desktop/tests/status-strip-authority.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { StatusStrip } from '../src/renderer/components/ui/StatusStrip';
import { inScopeFiles, readStripped } from './helpers/guard-scope';

// Guard for K5 (status strip) and K9 (danger zone).
//
// K5 is a subsystem's RUNNING state ("Checking…", "Not set up yet") plus the
// one action that moves it on. Since 2026-09-25 a PROBLEM notice with buttons
// is a <Callout actions> instead (decisions.md P-2: every warning/error is the
// one tinted box, its buttons inside it) — the old split "a callout has no
// action slot, so a notice with a button must be a strip" is superseded. These
// assertions pin that a status strip HAS its slot, and that the branches that
// used to be eleven hand-rolled shapes go through it.
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
  it('a state at rest gets a dot; a state in motion gets a spinner', () => {
    render(<StatusStrip tone="ok">message</StatusStrip>);
    expect(strip().querySelector('.rounded-full')).not.toBeNull();
    cleanup();
    render(<StatusStrip tone="busy">message</StatusStrip>);
    expect(strip().querySelector('.rounded-full'), 'busy replaces the dot').toBeNull();
  });

  it('carries the one action that resolves the state', () => {
    // A running state's one way forward. (A problem notice's buttons go in
    // <Callout actions> instead — decisions.md P-2.)
    render(<StatusStrip tone="idle" action={<button>Set up</button>}>message</StatusStrip>);
    expect(screen.getByRole('button', { name: 'Set up' })).toBeInTheDocument();
  });

  it('detail is a second line under the message', () => {
    render(<StatusStrip tone="busy" detail="later line">message</StatusStrip>);
    expect(screen.getByText('message').compareDocumentPosition(screen.getByText('later line')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// ── Adoption ────────────────────────────────────────────────────────────────


/**
 * Debt this tranche did NOT pay, counted per file so it cannot grow silently.
 *
 * The list below is a real finding, and none of them is K5's or K9's job.
 * Writing them as COUNTS rather than skipping the check turns each backlog into
 * a live number: the guard fails the moment someone adds one more.
 *
 * Every file NOT listed is held at zero by the matching ast-grep rule, which
 * names these same files under its `ignores:`. Adding or removing an entry here
 * means editing that rule's list too — youcoded-dev's check.sh fails if the two
 * lists differ.
 */

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
  // 6 -> 4 (small-fixes-2): the sign-in step's two "Sign-in failed" fallbacks now say only what is certain.
  'SyncSetupWizard.tsx': { count: 4, why: 'four install / repo-create branches' },
};

describe('status adoption', () => {
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
    const seen = new Set<string>();
    for (const file of inScopeFiles()) {
      const name = file.split(/[\\/]/).pop()!;
      const allowed = HARDCODED_ERROR_FALLBACK[name]?.count;
      if (allowed === undefined) continue;
      seen.add(name);
      const src = readStripped(file);
      const n = [...src.matchAll(/\b\w*[eE]rror\s*\|\|\s*['"][^'"]+['"]/g)].length;
      if (n !== allowed) drift.push(`${name}: ${n} hardcoded error fallbacks, expected ${allowed}`);
    }
    // WHY (review of u9): same as above — a listed file no longer in scope is a stale exemption.
    for (const name of Object.keys(HARDCODED_ERROR_FALLBACK)) {
      if (!seen.has(name)) drift.push(`${name} is exempted but no longer in scope — drop it`);
    }
    expect(
      drift,
      'Show the real error, or say you do not have one and offer Report bug / Diagnose with the assistant '
        + '(<ErrorState mode="general">). A hardcoded fallback asserts a cause nobody verified. '
        + 'The counts above are the v1.3.1 audit backlog — they may shrink, never grow.',
    ).toEqual([]);
  });
});
