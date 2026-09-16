// Specialists plans, Task 3 — the conservative complete-request budget adapter
// (backend design §4) and the contract a plan-child HarnessSession speaks to
// the plan's budget.
//
// What this file answers: "before this request is sent, what is the MOST it
// could possibly cost on the input side?" The answer has to be a guarantee,
// not an estimate — a plan's token ceiling is a hard stop the user approved, so
// a request whose real size could exceed its reservation must never be sent.
//
// How: count every byte of what will be sent (system prompt, every message,
// every tool schema), charge one token per UTF-8 byte, and add fixed framing
// allowances. One token per byte is the only ratio that is a proof rather
// than a guess: byte-level tokenizers (GPT, Claude, Llama 3, Qwen) and
// SentencePiece with byte fallback (Gemma) never produce more tokens than the
// text has bytes. Real text averages 3–4 bytes per token, so this
// deliberately over-reserves roughly 3–4× — and anything unused is released
// once the provider reports what it really charged.
import type { ModelMessage } from 'ai';
import type { ProfileProviderType } from '../capability-profile';

/** Certified generic ratio: at most one token per UTF-8 byte (see header). */
export const GENERIC_BYTES_PER_TOKEN = 1;
/** Once per request: chat-template wrapper plus the preamble providers add when
 *  tools are attached (Anthropic documents a few hundred tokens for it). */
export const REQUEST_FRAMING_TOKENS = 1024;
/** Per message: role markers and separators the template wraps around it. */
export const PER_MESSAGE_FRAMING_TOKENS = 32;
/** Per tool: the function wrapper a provider puts around each schema. */
export const PER_TOOL_FRAMING_TOKENS = 64;

/** One tool exactly as the request will describe it (JSON Schema input). */
export interface PlanWireTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** The complete request, in the shape it will be handed to the provider. */
export interface PlanWireRequest {
  system: string;
  messages: readonly ModelMessage[];
  tools: readonly PlanWireTool[];
}

export type InputBoundResult = { ok: true; tokens: number } | { ok: false; reason: string };

export interface PlanBudgetAdapter {
  /** Stable id — the unit that is disabled when observed usage breaks its bound. */
  readonly id: string;
  /** The provider route this adapter is certified for. The harness refuses to
   *  use it for a session bound to any other route (Task 3 review). */
  readonly providerType: ProfileProviderType;
  /** False for a route that rejects a reply-length cap (ChatGPT, decision 5):
   *  the request is still reserved and sent once, but its reply can overshoot,
   *  so the plan's limit is approximate. */
  readonly capsOutput: boolean;
  inputBound(request: PlanWireRequest): InputBoundResult;
}

// ---- unsupported content ----

const TEXT_TOOL_OUTPUTS = new Set(['text', 'json', 'error-text', 'error-json', 'execution-denied']);
const PART_TYPES_BY_ROLE: Record<string, ReadonlySet<string>> = {
  system: new Set(['text']),
  user: new Set(['text']),
  assistant: new Set(['text', 'tool-call']),
  tool: new Set(['tool-result']),
};

function refusal(what: string): InputBoundResult {
  return {
    ok: false,
    reason: `This specialist's next request contains ${what}, which a plan budget can't measure in advance, so it wasn't sent.`,
  };
}

/** True when raw bytes hide anywhere inside `value`. WHY a walk instead of
 *  trusting JSON.stringify: a Buffer serializes to a number array whose length
 *  says nothing about how the provider will encode (and bill) it. */
function containsBinary(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  if (depth > 64) return true; // absurd nesting is not something we can vouch for either
  if (Array.isArray(value)) return value.some((v) => containsBinary(v, depth + 1));
  return Object.values(value as Record<string, unknown>).some((v) => containsBinary(v, depth + 1));
}

/** A reason string when the message holds something without a certified bound. */
function unsupportedIn(message: ModelMessage): InputBoundResult | undefined {
  if (containsBinary(message)) return refusal('raw binary data');
  const content = (message as { content: unknown }).content;
  if (typeof content === 'string') return undefined;
  if (!Array.isArray(content)) return refusal('content in an unrecognized shape');
  const allowed = PART_TYPES_BY_ROLE[message.role];
  if (!allowed) return refusal(`a "${String(message.role)}" message`);
  for (const part of content as Array<{ type?: unknown; output?: { type?: unknown } }>) {
    const type = String(part?.type);
    if (type === 'image' || type === 'file') return refusal('an image or attached file');
    if (type === 'reasoning' || type === 'reasoning-file') return refusal('saved model reasoning');
    if (!allowed.has(type)) return refusal(`a "${type}" part`);
    if (type === 'tool-result' && !TEXT_TOOL_OUTPUTS.has(String(part.output?.type))) {
      return refusal('a tool result with images or other media');
    }
  }
  return undefined;
}

const utf8Bytes = (value: unknown): number =>
  Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value) ?? '', 'utf8');

/**
 * The certified generic bound. Counts the JSON form of every message and tool
 * (which is never shorter than the text inside it) plus fixed framing.
 */
export function genericInputBound(request: PlanWireRequest): InputBoundResult {
  for (const message of request.messages) {
    const bad = unsupportedIn(message);
    if (bad) return bad;
  }
  if (request.tools.some((t) => containsBinary(t))) return refusal('raw binary data in a tool description');
  const contentBytes = utf8Bytes(request.system)
    + request.messages.reduce((n, m) => n + utf8Bytes(m), 0)
    + request.tools.reduce((n, t) => n + utf8Bytes(t), 0);
  return {
    ok: true,
    tokens: Math.ceil(contentBytes / GENERIC_BYTES_PER_TOKEN)
      + REQUEST_FRAMING_TOKENS
      + request.messages.length * PER_MESSAGE_FRAMING_TOKENS
      + request.tools.length * PER_TOOL_FRAMING_TOKENS,
  };
}

/**
 * A provider-specific adapter built on the generic one. `tighten` may only
 * LOWER the bound: the result is min(generic, tighten), and anything the
 * generic adapter refuses stays refused (design §4 — tokenizers tighten,
 * never widen authorization).
 */
export function tightenedAdapter(
  base: PlanBudgetAdapter, id: string, tighten: (request: PlanWireRequest) => number,
): PlanBudgetAdapter {
  return {
    id,
    providerType: base.providerType,
    capsOutput: base.capsOutput,
    inputBound(request) {
      const generic = genericInputBound(request);
      if (!generic.ok) return generic;
      const tighter = tighten(request);
      return Number.isSafeInteger(tighter) && tighter >= 0 && tighter < generic.tokens
        ? { ok: true, tokens: tighter }
        : generic;
    },
  };
}

function genericAdapter(providerType: ProfileProviderType, capsOutput: boolean): PlanBudgetAdapter {
  return { id: `generic:${providerType}`, providerType, capsOutput, inputBound: genericInputBound };
}

/**
 * Decision 4: a specialist's fixed starting cost — its system prompt, tool
 * schemas and request framing — measured by the SAME adapter that bounds its
 * requests, so the plan's ceiling and the first request's reservation can
 * never disagree about it. Refuses exactly when the adapter would.
 */
export function setupBound(
  adapter: PlanBudgetAdapter,
  setup: { system: string; tools: readonly PlanWireTool[] },
): InputBoundResult {
  return adapter.inputBound({ system: setup.system, messages: [], tools: setup.tools });
}

export type AdapterLookup = { ok: true; adapter: PlanBudgetAdapter } | { ok: false; reason: string };

/**
 * Which adapter bounds each provider route. Every route but ChatGPT accepts
 * an output cap; an arbitrary compatible endpoint that rejects it fails that
 * one request, which is charged in full — it can never be sent twice or
 * overspend. ChatGPT's endpoint rejects `max_output_tokens` outright
 * (chatgpt-model.ts strips it), so by product decision 5 (2026-09-16) it gets
 * a SOFT adapter: same certified input bound, reservation before sending,
 * one transmission, but the reply may overshoot once before the plan pauses.
 */
export function budgetAdapterFor(providerType: ProfileProviderType): AdapterLookup {
  switch (providerType) {
    case 'anthropic':
    case 'openai':
    case 'google':
    case 'openrouter':
    case 'openai-compatible':
    case 'local-engine':
      return { ok: true, adapter: genericAdapter(providerType, true) };
    case 'chatgpt':
      return { ok: true, adapter: genericAdapter(providerType, false) };
    default: {
      const unknownType: never = providerType;
      return { ok: false, reason: `Plans can't run specialists on this provider (${String(unknownType)}).` };
    }
  }
}

// ---- conformance ----

export interface AdapterFixture {
  request: PlanWireRequest;
  /** What the real provider reported for exactly this request. */
  observedInputTokens: number;
}

/** An adapter conforms only if its bound covers every recorded observation. */
export function checkAdapterConformance(
  adapter: PlanBudgetAdapter,
  fixtures: readonly AdapterFixture[],
): { ok: true } | { ok: false; detail: string } {
  for (const [i, fixture] of fixtures.entries()) {
    const bound = adapter.inputBound(fixture.request);
    if (!bound.ok) return { ok: false, detail: `fixture ${i}: refused (${bound.reason})` };
    if (bound.tokens < fixture.observedInputTokens) {
      return { ok: false, detail: `fixture ${i}: bound ${bound.tokens} is below observed ${fixture.observedInputTokens}` };
    }
  }
  return { ok: true };
}

// ---- usage and the process-wide disable list ----

/**
 * What the provider says a request really cost, or undefined when it did not
 * say enough. WHY both halves are required: a missing count is not a zero,
 * and a request whose cost is unknown is charged its whole reservation.
 */
export function authoritativeTokens(
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined,
): number | undefined {
  const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.ceil(n) : undefined);
  const input = count(usage?.inputTokens);
  const output = count(usage?.outputTokens);
  if (input === undefined || output === undefined) return undefined;
  return Math.max(input + output, count(usage?.totalTokens) ?? 0);
}

// WHY in memory as well as in each plan's journal: design §4 says an adapter
// whose certified bound was broken is disabled "for plans", not for one plan.
// The journal keeps the durable per-plan record; this stops every other plan
// in this process from trusting the same broken bound until a restart.
const disabledAdapters = new Map<string, string>();

export function disableAdapterForPlans(adapterId: string, detail: string): void {
  if (!disabledAdapters.has(adapterId)) disabledAdapters.set(adapterId, detail);
}

export function adapterDisabledReason(adapterId: string): string | undefined {
  return disabledAdapters.get(adapterId);
}

export function resetDisabledAdaptersForTests(): void {
  disabledAdapters.clear();
}

// ---- the plan-child request contract (HarnessSession ⇄ plan budget) ----

export type PlanRequestReservation =
  | { ok: true; maxOutputTokens: number }
  /** exhausted: the request does not fit what is left — nothing was sent.
   *  refused: the plan may not send anything right now (fence lost, adapter
   *  disabled, attempt already has an unresolved request). */
  | { ok: false; kind: 'exhausted' | 'refused'; detail: string };

export type PlanRequestOutcome =
  | {
    kind: 'reported';
    tokens: number;
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
  }
  | { kind: 'unknown'; why: 'interrupted' | 'error' | 'silent' };

export type PlanRequestSettlement =
  | { kind: 'ok'; chargedTokens: number }
  /** A soft (uncapped) reply used up the attempt's allowance: charged as
   *  actually used; no further request may be sent (decision 5). */
  | { kind: 'limit-reached'; chargedTokens: number; detail: string }
  /** The certified bound, or the plan's dollar limit, was broken. */
  | { kind: 'over-bound'; chargedTokens: number; detail: string };

export interface PlanChildStop {
  kind: 'unsupported-input' | 'exhausted' | 'over-bound' | 'refused';
  detail: string;
}

/**
 * Everything a plan-child HarnessSession needs from its plan. The host
 * (Task 4) builds one per specialist attempt; its presence on
 * HarnessSessionOpts is what switches the session into plan-child mode.
 */
export interface PlanChildRequestGate {
  adapter: PlanBudgetAdapter;
  /** Durably reserve the attempt's whole remaining allowance for ONE request
   *  whose input can be at most `inputBoundTokens`. */
  reserve(input: { inputBoundTokens: number }): Promise<PlanRequestReservation>;
  /** Charge the request just made and release what it provably did not use. */
  settle(outcome: PlanRequestOutcome): Promise<PlanRequestSettlement>;
  /** Told when a turn stops for a budget reason, so the executor can pause. */
  onStop?(stop: PlanChildStop): void;
}
