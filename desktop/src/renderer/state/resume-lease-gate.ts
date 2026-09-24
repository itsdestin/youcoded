import type { SessionCreateResult } from '../../shared/types';
import type { TakeoverDialogPhase } from '../components/takeover-dialog-copy';

/** Shared by the main window and buddy. The backend owns admission and cleanup;
 *  this helper only asks permission for handoff and retries a refused opening. */
export async function runLeaseTakeoverGate(opts: {
  claudeSessionId: string;
  askTakeover: (device: string, phase: TakeoverDialogPhase) => Promise<boolean>;
  onWarn: (message: string) => void;
  open: () => Promise<SessionCreateResult | null | undefined>;
  /** Explicit handoff uses the pending attempt owner, not the legacy lease-force path. */
  onHandoff?: (device: string) => Promise<void>;
}): Promise<Extract<SessionCreateResult, { id: string }> | null> {
  const { claudeSessionId, askTakeover, onWarn, open } = opts;
  const sync = window.claude.syncSpaces;
  // WHY share this path: a holder seen before opening and one discovered after a
  // refused retry need the same explicit handoff and separate force consent.
  const handoff = async (device: string): Promise<boolean> => {
    if (!await askTakeover(device, 'confirm')) return false;
    // WHY: the explicit transfer must wait for a nonce-bound receipt before a writer opens.
    if (opts.onHandoff) { await opts.onHandoff(device); return false; }
    const result = await sync?.leaseTakeover?.(claudeSessionId);
    if (result?.outcome === 'timeout' || result?.outcome === 'undeliverable') {
      const phase = result.outcome === 'undeliverable' ? 'undeliverable' : 'force';
      if (!await askTakeover(device, phase)) return false;
      const forced = await sync?.leaseForce?.(claudeSessionId);
      if (!forced?.ok) onWarn(`Couldn't confirm the handoff from ${device}.`);
    } else if (result?.outcome === 'error') {
      onWarn(`Couldn't confirm the handoff from ${device}.`);
    }
    return true;
  };

  // WHY query first: an existing holder gets the direct, explicit handoff flow.
  // A lost race is a different outcome, detected by the backend at creation.
  // WHY: only a failed QUERY permits ordinary offline resume. A failure
  // starting the explicit pending route must never fall through to create.
  const q = await sync?.leaseQuery?.(claudeSessionId).catch(() => undefined);
  if (q?.held && !q.self && !await handoff(q.device || 'another device')) return null;

  // Do not catch startup failures as lease failures. A refused Try again may
  // offer handoff, but each subsequent open still passes backend admission.
  let retryDenied = false;
  for (;;) {
    const result = await open();
    if (!result) throw new Error('No session returned by session:create');
    if (result.status !== 'lease-denied') return result;
    const device = result.device || 'another device';
    if (retryDenied) {
      if (!await handoff(device)) return null;
      retryDenied = false;
    } else {
      if (!await askTakeover(device, 'claim-denied')) return null;
      retryDenied = true;
    }
  }
}
