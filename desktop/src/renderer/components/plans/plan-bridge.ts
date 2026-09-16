import { useEffect, useState } from 'react';
import type {
  PlanActionResult, PlanAutoApproveRead, PlanSettingsWriteResult, PlanUnsupported, PlanView,
} from '../../../shared/types';

/**
 * Specialists plans, Task 5a — the ONE place the renderer talks to
 * `window.claude.plans` (the card's five buttons, Settings' two calls).
 *
 * Every answer is normalized to the host's three forms before a component
 * sees it: ok, a real failure (its reason shown as-is), or `unsupported` (this
 * device or host can't run plans — the caller disables its controls and never
 * retries). WHY normalize here rather than trust the wire: the same call
 * crosses Electron IPC, the remote WebSocket and the Android bridge, and a
 * shape a component did not expect must read as a failure — never as a
 * success, and never as a crash.
 */

type PlansBridge = NonNullable<Window['claude']['plans']>;

/** A bridge without `plans` (a build before Task 6's channels, or a surface
 *  that never had them) cannot run plans: same treatment as `unsupported`. */
const NO_BRIDGE: PlanUnsupported = { ok: false, unsupported: true, error: "Plans aren't available here." };

/** General and non-committal on purpose (docs/error-message-standards.md): an
 *  answer we can't read has no known cause, so none is invented. */
const UNREADABLE = "Couldn't update the plan. Please try again.";
/** Task 5b: the card tells this general line (no known cause) from a host's
 *  own reason, because only the general one also offers Report bug. */
export const PLAN_UNREADABLE = UNREADABLE;
const UNREADABLE_SETTINGS = "Couldn't read the plan settings. Please try again.";

function bridge(): PlansBridge | undefined {
  return (window as { claude?: { plans?: PlansBridge } }).claude?.plans;
}

function refusal(raw: unknown, fallback: string): PlanActionResult & { ok: false } | null {
  const r = raw as { ok?: unknown; unsupported?: unknown; error?: unknown } | null | undefined;
  if (!r || typeof r !== 'object' || r.ok !== false) return null;
  const error = typeof r.error === 'string' && r.error.trim() ? r.error : fallback;
  return r.unsupported === true ? { ok: false, unsupported: true, error } : { ok: false, error };
}

function isPlanView(v: unknown): v is PlanView {
  const p = v as Partial<PlanView> | null | undefined;
  return !!p && typeof p === 'object' && typeof p.planId === 'string' && typeof p.toolUseId === 'string'
    && typeof p.status === 'string' && Array.isArray(p.steps);
}

function normalizePlanAction(raw: unknown): PlanActionResult {
  const refused = refusal(raw, UNREADABLE);
  if (refused) return refused;
  const r = raw as { ok?: unknown; plan?: unknown } | null | undefined;
  if (r && r.ok === true && isPlanView(r.plan)) return { ok: true, plan: r.plan };
  return { ok: false, error: UNREADABLE };
}

function normalizePlanRead(raw: unknown): PlanAutoApproveRead {
  const refused = refusal(raw, UNREADABLE_SETTINGS);
  if (refused) return refused;
  const r = raw as { ok?: unknown; underTokens?: unknown } | null | undefined;
  if (r && r.ok === true && typeof r.underTokens === 'number' && Number.isFinite(r.underTokens) && r.underTokens >= 0) {
    return { ok: true, underTokens: r.underTokens };
  }
  return { ok: false, error: UNREADABLE_SETTINGS };
}

function normalizePlanWrite(raw: unknown): PlanSettingsWriteResult {
  const refused = refusal(raw, "Couldn't save the plan settings. Please try again.");
  if (refused) return refused;
  const r = raw as { ok?: unknown } | null | undefined;
  return r && r.ok === true ? { ok: true } : { ok: false, error: "Couldn't save the plan settings. Please try again." };
}

/** Run one call; a missing bridge is `unsupported`, a thrown call is a failure
 *  carrying the transport's own message (the shims word theirs for people). */
async function call<T>(fn: (b: PlansBridge) => Promise<unknown>, normalize: (raw: unknown) => T, fallback: string): Promise<T | PlanActionResult> {
  const b = bridge();
  if (!b) return NO_BRIDGE;
  try {
    return normalize(await fn(b));
  } catch (e) {
    const message = e instanceof Error && e.message.trim() ? e.message : fallback;
    return { ok: false, error: message };
  }
}

export function planAction(fn: (b: PlansBridge) => Promise<unknown>): Promise<PlanActionResult> {
  return call(fn, normalizePlanAction, UNREADABLE) as Promise<PlanActionResult>;
}

export function readPlanAutoApprove(): Promise<PlanAutoApproveRead> {
  return call((b) => b.getAutoApprove(), normalizePlanRead, UNREADABLE_SETTINGS) as Promise<PlanAutoApproveRead>;
}

export function writePlanAutoApprove(underTokens: number): Promise<PlanSettingsWriteResult> {
  return call((b) => b.setAutoApprove(underTokens), normalizePlanWrite, "Couldn't save the plan settings. Please try again.") as Promise<PlanSettingsWriteResult>;
}

// ---- can this device run plans? --------------------------------------------

/**
 * Asked once per window (the settings read is the cheapest call every surface
 * answers): `unsupported` means every plan control stays disabled from the
 * first paint, rather than being clickable and refusing. A plain failure does
 * NOT disable anything — it says nothing about the device.
 */
let support: Promise<PlanUnsupported | null> | null = null;

function probe(): Promise<PlanUnsupported | null> {
  support ??= readPlanAutoApprove().then((r) => (r.ok === false && r.unsupported ? r : null));
  return support;
}

/** Tests only: forget the cached answer. */
export function resetPlanSupportForTests(): void {
  support = null;
}

/** null while unknown or supported; the host's refusal when plans can't run here. */
export function usePlanUnsupported(): PlanUnsupported | null {
  const [state, setState] = useState<PlanUnsupported | null>(null);
  useEffect(() => {
    let alive = true;
    void probe().then((r) => { if (alive) setState(r); });
    return () => { alive = false; };
  }, []);
  return state;
}
