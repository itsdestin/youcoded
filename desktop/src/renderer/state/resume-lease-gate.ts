import type { TakeoverDialogPhase } from '../components/takeover-dialog-copy';

// The conversation-lease takeover gate, extracted from App.handleResumeSession
// (2026-09-10) so a second resume surface — the buddy floater's own list —
// cannot re-derive it slightly differently.
//
// WHY IT MUST BE SHARED. Three of its rules are invisible from the outside and
// each was a bug once:
//
//   1. NEVER hard-block. Any lease error proceeds with the resume (spec §3).
//      A gate that returned false on an exception would make a hub hiccup look
//      like a broken Resume button.
//   2. 'timeout' and 'undeliverable' get the SAME force path but DIFFERENT
//      words. Collapsing them re-introduces the dishonest "isn't responding"
//      framing that the 3-state redesign replaced: 'undeliverable' means the
//      other device was never asked at all, so it must not be blamed for
//      silence.
//   3. A force whose `ok` is false means the lease was never overwritten — the
//      other device may still be live. Proceed, but SAY SO. Silence here was
//      what masked the 2026-07-18 bug.
//
// Also: the `self` flag is computed in the main process from the per-install
// deviceId, NOT the hostname label. Gating on "held AND not self" is what stops
// a lease left over from this very install (an unclean shutdown) popping a
// confusing "active on <your own hostname>" dialog.
//
// Claim-before-open (2026-09-21, deck Q-1/Q-2): when the bridge offers
// leaseClaim, the gate's FIRST step is claiming the lease — before any session
// exists to write with — which closes the healthy-hub window where two devices
// could both pass a "free" query and both open the conversation (audit H1/H4).
// A denial becomes the Q-2 message + Try again; a claim that cannot run
// (offline/timeout/'error') proceeds exactly as today — the escape hatch.
//
// Pinned by tests/resume-lease-gate.test.ts.

export interface LeaseGateOptions {
  /** The past conversation's id (the Claude/native session id, not a live one). */
  claudeSessionId: string;
  /** Ask the user. Resolves true to proceed, false for "Never mind". */
  askTakeover: (device: string, phase: TakeoverDialogPhase) => Promise<boolean>;
  /** Surface a non-blocking warning (a toast on main, an inline line in the buddy). */
  onWarn: (message: string) => void;
  /**
   * Ask the "this conversation moved to your other device" question (deck Q-2).
   * Resolves true = Try again (re-run the claim), false = Leave it (abort).
   * Optional so a resume surface predating the member still typechecks; when
   * absent, a denial degrades to today's behaviour (proceed with a warning)
   * rather than a hard block — the never-block rule outranks the new UI.
   */
  askClaimDenied?: (device: string) => Promise<boolean>;
  /**
   * Claim the lease BEFORE any session exists (deck Q-1/Q-2, 2026-09-21).
   * Optional for the same backward-compat reason. Four-state ClaimResult —
   * 'denied' is the Q-2 moment; 'free-unconfirmed'/'error' proceed (escape
   * hatch — never block a resume on sync being unreachable).
   */
  claimLease?: (claudeSessionId: string) => Promise<{ outcome: 'acquired' | 'denied' | 'free-unconfirmed' | 'error'; device?: string }>;
  /**
   * The resume died after a hold was taken (user declined after the claim, or
   * the takeover was declined). Release the hold so a dead-end resume doesn't
   * sit on the lease for the 300 s TTL. Fire-and-forget by contract; the gate
   * calls it before every `return false` that happens AFTER a hold was taken.
   */
  onAbandon?: () => void;
}

/**
 * Claim the lease before any session exists (deck Q-1/Q-2). When the bridge has
 * no leaseClaim member (older remote builds, the workbench shim), the claim step
 * is skipped entirely and the open-then-acquire path below runs unchanged —
 * degraded behaviour, not broken behaviour.
 *
 * @returns the four-state ClaimResult the gate branches on, or null when the
 *          claim cannot run at all (no member / threw).
 */
async function runClaim(
  claudeSessionId: string,
  claimLease?: LeaseGateOptions['claimLease'],
): Promise<{ outcome: 'acquired' | 'denied' | 'free-unconfirmed' | 'error'; device?: string } | null> {
  if (typeof claimLease !== 'function') return null;
  try {
    return await claimLease(claudeSessionId);
  } catch {
    return null; // never-block: a thrown claim degrades to the old path
  }
}

/**
 * @returns true to go ahead with the resume, false only when the USER declined.
 *
 * The post-start acquires (native create + CC SessionStart) are UNCHANGED by
 * this feature: after a claim holds the lease they re-affirm it idempotently
 * (the DO re-stamps a fresh TTL on acquire-or-already-ours), and on the
 * degraded/override paths they still log the honest "running without its lease"
 * breadcrumb. The race is closed by the claim running FIRST, not by removing
 * the later acquire.
 */
export async function runLeaseTakeoverGate({
  claudeSessionId, askTakeover, onWarn, askClaimDenied, claimLease, onAbandon,
}: LeaseGateOptions): Promise<boolean> {
  // ---- Claim-before-open (deck Q-1/Q-2). Acquire BEFORE anything is created. ----
  const claim = await runClaim(claudeSessionId, claimLease);
  if (claim?.outcome === 'denied') {
    // Someone holds the conversation and the user hasn't been asked yet —
    // this is the Q-2 moment, BEFORE any session exists. Ask Try again / Leave it.
    if (typeof askClaimDenied === 'function') {
      const retry = await askClaimDenied(claim.device || 'another device');
      if (!retry) { onAbandon?.(); return false; } // "Leave it" — abort, nothing was created
      // Try again: re-claim once.
      const again = await runClaim(claudeSessionId, claimLease);
      if (again?.outcome === 'acquired') return true; // holder let go — clean
      if (again && again.outcome !== 'denied') {
        // free-unconfirmed / error → proceed (escape hatch; the lease client
        // holds optimistically on null, matching the claim's report).
        return true;
      }
      // again === 'denied' (or the re-claim threw): STILL held. Do NOT
      // warn-and-proceed — that would open a session without the lease beside
      // a live writer (the audit's H1 shape, with a blessing). Fall through to
      // the takeover gate below: the query will confirm held:true and the
      // user gets the REAL override path (confirm → hand-off → force), whose
      // outcome is ownership, not a warned dual-write. The fall-through keeps
      // the takeover flow reachable at all on a healthy hub — the claim denies
      // before the query would otherwise ever run.
    } else {
      // No askClaimDenied member: degrade to proceed-and-warn (never-block).
      onWarn(`This conversation is being used on ${claim.device || 'another device'} right now — opening it here may create two separate copies.`);
      return true;
    }
  }
  if (claim?.outcome === 'acquired') {
    // Lease is OURS before anything exists — the healthy-hub race window
    // (audit H1/H4) is closed for this resume. Nothing can fail between here
    // and the return, so no onAbandon branch is needed inside the gate.
    return true;
  }
  // 'free-unconfirmed', 'error', or no claim member → fall through to the
  // original query-then-takeover gate. The escape hatch (Q-1 rider): sync being
  // down never blocks the resume.

  try {
    const q = await window.claude.syncSpaces?.leaseQuery?.(claudeSessionId);
    if (!q?.held || q.self) return true;

    const device = q.device || 'another device';
    const confirmed = await askTakeover(device, 'confirm');
    if (!confirmed) { onAbandon?.(); return false; } // "Never mind" — abort the resume

    const r = await window.claude.syncSpaces?.leaseTakeover?.(claudeSessionId);
    if (r?.outcome === 'timeout' || r?.outcome === 'undeliverable') {
      const forced = await askTakeover(device, r.outcome === 'undeliverable' ? 'undeliverable' : 'force');
      if (!forced) { onAbandon?.(); return false; } // "Never mind" — abort
      const fr = await window.claude.syncSpaces?.leaseForce?.(claudeSessionId);
      if (fr && fr.ok === false) {
        onWarn(`Couldn't confirm the handoff from ${device} — it may still be editing this conversation, and recent turns may be missing.`);
      }
    } else if (r?.outcome === 'error') {
      onWarn(`Couldn't reach ${device} to hand off this conversation — it may still be editing, and recent turns may be missing.`);
    }
    // 'acquired' -> clean handoff, fall through and resume.
    return true;
  } catch {
    // Never-block: a lease query/takeover failure must not stop the resume.
    return true;
  }
}
