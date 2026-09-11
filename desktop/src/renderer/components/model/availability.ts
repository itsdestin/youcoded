import { useCallback, useEffect, useState } from 'react';
import { CLAUDE_ALIASES } from '../../../shared/model-ids';
import { claudeUnavailableReason, type ClaudeAccountStatus } from '../../../shared/claude-account-types';
import type { ModelChoice } from './ModelPicker';

// WHY THIS FILE EXISTS (Destin, deck 2026-09-07, P-1 / P-3 / Q-E).
//
// Three surfaces have to agree on one question — "can this install actually run
// that model right now?":
//   · the model menu, which now LISTS what it cannot run, greyed, with a reason
//     rather than hiding it (Q-E a);
//   · Assistant settings' Default model row, which keeps naming your choice and
//     says it is being ignored rather than erasing it (P-1 a, P-2 note);
//   · the new-session forms, which start with nothing chosen rather than
//     substituting a model you did not pick (P-3 b).
//
// One pure answer, three readers. Two of them already hold the provider list and
// the catalog, so the judgement is a plain function over data the caller has,
// not a fourth fetch.

export interface ProviderRow {
  id: string;
  type: string;
  label: string;
  ready: boolean;
  /** Present on the real bridge reply; absent in older fixtures. */
  enabled?: boolean;
  hasKey?: boolean;
}

export interface CatalogRow { id: string; providerId: string; label: string }

export interface AvailabilityData {
  providers: ProviderRow[];
  catalog: CatalogRow[];
  /** Claude Code's LIVE sign-in, straight from `claude auth status`. Null until
   *  the answer arrives — which counts as available, the same way `unknown`
   *  does. Before 2026-09-09 this was a boolean derived from the SETUP WIZARD's
   *  saved notes, which on every launch after the first arrive with no auth
   *  fields at all: a signed-in install had every Claude model greyed out with
   *  "Sign in to use" while the pre-filled default ran perfectly. */
  claudeStatus: ClaudeAccountStatus | null;
}

/** Why this provider cannot serve a model right now — the words shown on the
 *  greyed row. Short enough to sit at the end of a model row. */
export function providerReason(p: ProviderRow): string {
  if (p.enabled === false) return 'Turned off';
  if (p.type === 'chatgpt') return 'Sign in to use';
  if (p.type === 'local-engine') return 'Set up local models';
  return 'Add an API key';
}

/** True only for the specific reason "Add an API key" — the one unavailable
 *  case with a fix that's a single click away (open Settings' Cloud providers
 *  page). Derives from `providerReason` instead of matching its return string,
 *  so the two can never drift apart. */
export function nativeChoiceNeedsApiKey(choice: ModelChoice | null | undefined, d: AvailabilityData): boolean {
  if (!choice || choice.runtime !== 'native') return false;
  const p = d.providers.find((x) => x.id === choice.providerId);
  return !!p && !p.ready && providerReason(p) === 'Add an API key';
}

/** A provider with no catalog of its own (Ollama, LM Studio, a custom endpoint):
 *  any model id the user types is legitimate, so a missing catalog row is not a
 *  missing model. */
function isFreeform(p: ProviderRow, catalog: CatalogRow[]): boolean {
  return p.type === 'openai-compatible' && !catalog.some((c) => c.providerId === p.id);
}

/**
 * The reason this choice cannot be used, or null when it can.
 *
 * Deliberately never repairs anything: it reports. Every caller shows the
 * reason instead of quietly moving the user to a model they did not choose,
 * which is the rule Destin set on 2026-09-07 ("nothing should be overridden").
 */
export function unavailableReason(choice: ModelChoice | null | undefined, d: AvailabilityData): string | null {
  if (!choice) return null;
  if (choice.runtime === 'claude') {
    if (!(CLAUDE_ALIASES as readonly string[]).includes(choice.alias)) return 'No longer available';
    // The reason travels WITH the state (shared/claude-account-types.ts), so a
    // missing binary cannot be reported as "Sign in to use" — signing in is not
    // the fix for that one.
    return claudeUnavailableReason(d.claudeStatus);
  }
  const p = d.providers.find((x) => x.id === choice.providerId);
  if (!p) return 'No longer set up';
  if (!p.ready) return providerReason(p);
  if (isFreeform(p, d.catalog)) return null;
  return d.catalog.some((c) => c.providerId === p.id && c.id === choice.modelId)
    ? null
    : 'No longer in the model list';
}

/**
 * Anything that is not one of the four known states is `unknown`.
 *
 * WHY: this value crosses an IPC bridge with FOUR implementations (Electron,
 * the remote WebSocket server, the Android WebView, the workbench mock). A
 * surface that has not implemented the channel answers `{ ok: false }` or
 * `undefined`, and `{ ok: false }` is not `'signed-in'` — so without this
 * normalisation an unimplemented surface would grey out every Claude model,
 * which is precisely the bug this channel was added to fix.
 */
function normalize(raw: unknown): ClaudeAccountStatus {
  const state = (raw as { state?: unknown } | null)?.state;
  if (state === 'signed-in') return raw as ClaudeAccountStatus;
  if (state === 'signed-out' || state === 'not-installed') return { state };
  return { state: 'unknown' };
}

/**
 * Claude Code's live sign-in, and a way to ask again.
 *
 * WHY the optimistic default: null (not asked yet) and `unknown` both count as
 * available everywhere downstream. Greying every Claude model because a status
 * call has not come back yet — or came back from a surface that cannot answer —
 * would be the app inventing a problem, which is Destin's standing rule
 * (2026-09-07). Only a definite `signed-out` / `not-installed` greys anything.
 */
export function useClaudeStatus(): { status: ClaudeAccountStatus | null; refresh: () => void } {
  const [status, setStatus] = useState<ClaudeAccountStatus | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    const api = (window as any).claude?.claudeCode;
    if (!api?.status) return;
    // `refresh: true` only on an explicit re-ask — the first read is happy with
    // main's 60s cache, so mounting three readers costs one subprocess, not three.
    Promise.resolve(api.status(nonce > 0 ? { refresh: true } : undefined))
      .then((raw: unknown) => { if (alive) setStatus(normalize(raw)); })
      .catch(() => { if (alive) setStatus({ state: 'unknown' }); });
    return () => { alive = false; };
  }, [nonce]);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { status, refresh };
}

/**
 * The provider list, the catalog and Claude's sign-in state, fetched once for a
 * surface that has none of its own (Assistant settings' Default model row).
 *
 * `loaded` matters: before the answer arrives NOTHING may be called
 * unavailable, or the panel would accuse a perfectly good default of being
 * broken for the first frames after it opens.
 */
export function useAvailabilityData(reloadKey?: unknown): AvailabilityData & { loaded: boolean } {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const { status: claudeStatus } = useClaudeStatus();
  useEffect(() => {
    let cancelled = false;
    const api = (window as any).claude?.providers;
    if (!api?.list || !api?.catalog) { setLoaded(true); return; }
    Promise.all([
      api.list().catch(() => []),
      api.catalog().catch(() => []),
    ]).then(([list, cat]: [any, any]) => {
      if (cancelled) return;
      setProviders(Array.isArray(list) ? list : []);
      setCatalog(Array.isArray(cat) ? cat : []);
      setLoaded(true);
    }).catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [reloadKey]);
  return { providers, catalog, claudeStatus, loaded };
}
