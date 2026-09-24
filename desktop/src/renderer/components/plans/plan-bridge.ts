import { useEffect, useState } from 'react';
import type {
  PlanActionResult, PlanAutoApproveRead, PlanFailure, PlanSettingsWriteResult, PlanUnsupported, PlanView,
} from '../../../shared/types';
import { REMOTE_HOST_CHANGED_EVENT, REMOTE_NOT_SENT } from '../../remote-unsupported';

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
const UNSAVED_SETTINGS = "Couldn't save the plan settings. Please try again.";
/** Final review F11: the general settings lines, so Settings can offer
 *  Report bug beside Retry for them (no known cause). */
export const PLAN_SETTINGS_GENERAL: ReadonlySet<string> = new Set([UNREADABLE_SETTINGS, UNSAVED_SETTINGS]);

/** Final review F10: a refusal that names an internal channel id (an older
 *  desktop's "isn't available over remote access yet (plans:…)") means
 *  nothing to a person; the plain line says the same thing. */
const CHANNEL_ID = /\b[a-z][a-z-]*:[a-z][a-z-]*\b/;

function bridge(): PlansBridge | undefined {
  return (window as { claude?: { plans?: PlansBridge } }).claude?.plans;
}

// Task 14: this helper only ever produces the two REFUSAL forms — the notice is
// read before it (normalizePlanAction), so the settings calls, whose answers
// have no notice form, keep type-checking against it.
function refusal(raw: unknown, fallback: string): PlanFailure | PlanUnsupported | null {
  const r = raw as { ok?: unknown; unsupported?: unknown; error?: unknown; detail?: unknown } | null | undefined;
  if (!r || typeof r !== 'object' || r.ok !== false) return null;
  const error = typeof r.error === 'string' && r.error.trim() ? r.error : fallback;
  if (r.unsupported === true) {
    return { ok: false, unsupported: true, error: CHANNEL_ID.test(error) ? NO_BRIDGE.error : error };
  }
  // Final review F11: the host's own detail (a system error) rides along for
  // the bug report only; the card shows `error`.
  return typeof r.detail === 'string' && r.detail.trim() ? { ok: false, error, detail: r.detail } : { ok: false, error };
}

function isPlanView(v: unknown): v is PlanView {
  const p = v as Partial<PlanView> | null | undefined;
  return !!p && typeof p === 'object' && typeof p.planId === 'string' && typeof p.toolUseId === 'string'
    && typeof p.status === 'string' && Array.isArray(p.steps);
}

function normalizePlanAction(raw: unknown): PlanActionResult {
  // Task 14 (decision 27): a NOTICE, not a failure — the plan's specialists
  // changed and the press asks once before running at the new limit. Read
  // before the refusal forms so the card can show it as a strip, not an error.
  const n = (raw as { ok?: unknown; notice?: unknown } | null | undefined);
  if (n && typeof n === 'object' && n.ok === false && typeof n.notice === 'string' && n.notice.trim()) {
    return { ok: false, notice: n.notice };
  }
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
  const refused = refusal(raw, UNSAVED_SETTINGS);
  if (refused) return refused;
  const r = raw as { ok?: unknown } | null | undefined;
  return r && r.ok === true ? { ok: true } : { ok: false, error: UNSAVED_SETTINGS };
}

/**
 * Run one call; a missing bridge is `unsupported`.
 * Final review F1/F10/F11: a THROWN call has no known cause for the person —
 * a timeout ("Request plans:add-budget timed out") may even have succeeded —
 * so it answers the general line (which offers Report bug and Retry) and keeps
 * the transport's text for the bug report. The one thrown error with a known
 * cause is the shim's "nothing was sent" (F5), shown as it is.
 */
async function call<T>(fn: (b: PlansBridge) => Promise<unknown>, normalize: (raw: unknown) => T, fallback: string): Promise<T | PlanActionResult> {
  const b = bridge();
  if (!b) return NO_BRIDGE;
  try {
    return normalize(await fn(b));
  } catch (e) {
    const message = e instanceof Error ? e.message.trim() : '';
    if (message === REMOTE_NOT_SENT) return { ok: false, error: REMOTE_NOT_SENT };
    return message ? { ok: false, error: fallback, detail: message } : { ok: false, error: fallback };
  }
}

export function planAction(fn: (b: PlansBridge) => Promise<unknown>): Promise<PlanActionResult> {
  return call(fn, normalizePlanAction, UNREADABLE) as Promise<PlanActionResult>;
}

/** Decision 35 (Plan settings) — the plan's total spending cap; `null` turns
 *  it off. Mock-only until the backend rework lands (mock-only.ts); routed
 *  through `planAction` like every other button so a missing bridge or a
 *  refusal reads exactly the same way. */
export function setPlanLimit(sessionId: string, planId: string, limit: { usd: number } | { tokens: number } | null): Promise<PlanActionResult> {
  return planAction((b) => b.setLimit(sessionId, planId, limit));
}

/** Decision 35 — a step's model, for a step that has not started. `null`
 *  resets it to the specialist type's default. */
export function setStepModel(sessionId: string, planId: string, stepId: string, model: { providerId: string; modelId: string } | null): Promise<PlanActionResult> {
  return planAction((b) => b.setStepModel(sessionId, planId, stepId, model));
}

export function readPlanAutoApprove(): Promise<PlanAutoApproveRead> {
  return call((b) => b.getAutoApprove(), normalizePlanRead, UNREADABLE_SETTINGS) as Promise<PlanAutoApproveRead>;
}

export function writePlanAutoApprove(underTokens: number): Promise<PlanSettingsWriteResult> {
  return call((b) => b.setAutoApprove(underTokens), normalizePlanWrite, UNSAVED_SETTINGS) as Promise<PlanSettingsWriteResult>;
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

// Final review F9: the cached answer belongs to the host that gave it. When
// the remote shim switches hosts without a reload (a phone that first answered
// "unsupported" for itself, then connected to a computer that can run plans),
// the answer is forgotten and every card on screen asks again.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener(REMOTE_HOST_CHANGED_EVENT, () => { support = null; });
}

/** null while unknown or supported; the host's refusal when plans can't run here.
 *  `enabled: false` (a read-only preview) never asks. */
export function usePlanUnsupported(enabled = true): PlanUnsupported | null {
  const [state, setState] = useState<PlanUnsupported | null>(null);
  const [hostEpoch, setHostEpoch] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const onHostChanged = () => { support = null; setHostEpoch((n) => n + 1); };
    window.addEventListener(REMOTE_HOST_CHANGED_EVENT, onHostChanged);
    return () => window.removeEventListener(REMOTE_HOST_CHANGED_EVENT, onHostChanged);
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void probe().then((r) => { if (alive) setState(r); });
    return () => { alive = false; };
  }, [enabled, hostEpoch]);
  return state;
}
