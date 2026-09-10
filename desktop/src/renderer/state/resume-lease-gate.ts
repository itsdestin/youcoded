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
// Pinned by tests/resume-lease-gate.test.ts.

export interface LeaseGateOptions {
  /** The past conversation's id (the Claude/native session id, not a live one). */
  claudeSessionId: string;
  /** Ask the user. Resolves true to proceed, false for "Never mind". */
  askTakeover: (device: string, phase: TakeoverDialogPhase) => Promise<boolean>;
  /** Surface a non-blocking warning (a toast on main, an inline line in the buddy). */
  onWarn: (message: string) => void;
}

/**
 * @returns true to go ahead with the resume, false only when the USER declined.
 */
export async function runLeaseTakeoverGate({
  claudeSessionId, askTakeover, onWarn,
}: LeaseGateOptions): Promise<boolean> {
  try {
    const q = await window.claude.syncSpaces?.leaseQuery?.(claudeSessionId);
    if (!q?.held || q.self) return true;

    const device = q.device || 'another device';
    const confirmed = await askTakeover(device, 'confirm');
    if (!confirmed) return false; // "Never mind" — abort the resume

    const r = await window.claude.syncSpaces?.leaseTakeover?.(claudeSessionId);
    if (r?.outcome === 'timeout' || r?.outcome === 'undeliverable') {
      const forced = await askTakeover(device, r.outcome === 'undeliverable' ? 'undeliverable' : 'force');
      if (!forced) return false; // "Never mind" — abort
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
