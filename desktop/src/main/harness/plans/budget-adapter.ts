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
import { createHash } from 'crypto';
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
  /** Revision 5 (decision 22): how long after a completed request this
   *  route's prompt cache is trusted to still hold that request's prompt.
   *  Absent = never trusted, so every request reserves its full bound. Set
   *  only on routes that cache prompts AND report how much they read back. */
  readonly cacheWindowMs?: number;
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
    ...(base.cacheWindowMs !== undefined ? { cacheWindowMs: base.cacheWindowMs } : {}),
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

function genericAdapter(providerType: ProfileProviderType, capsOutput: boolean, cacheWindowMs?: number): PlanBudgetAdapter {
  return {
    id: `generic:${providerType}`, providerType, capsOutput,
    ...(cacheWindowMs !== undefined ? { cacheWindowMs } : {}),
    inputBound: genericInputBound,
  };
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
    // Revision 5: these routes keep a prompt cache (Anthropic and OpenRouter
    // through our cache markers, OpenAI/ChatGPT/Gemini automatically, the
    // local engine in its KV cache) and report how much they read back.
    case 'anthropic':
    case 'openai':
    case 'google':
    case 'openrouter':
    case 'local-engine':
      return { ok: true, adapter: genericAdapter(providerType, true, PLAN_CACHE_WINDOW_MS) };
    // WHY no cache window: an arbitrary OpenAI-compatible server may neither
    // cache nor report it. Its whole input is counted anyway (no breakdown),
    // so a small reservation would only open an overshoot with no benefit.
    case 'openai-compatible':
      return { ok: true, adapter: genericAdapter(providerType, true) };
    case 'chatgpt':
      return { ok: true, adapter: genericAdapter(providerType, false, PLAN_CACHE_WINDOW_MS) };
    default: {
      const unknownType: never = providerType;
      return { ok: false, reason: `Plans can't run specialists on this provider (${String(unknownType)}).` };
    }
  }
}

// ---- revision 5: warm-cache reservations (design §7, decision 22) ----
//
// Destin: "we should not be re-counting cached tokens". A long specialist
// re-sends its whole conversation on every request; the provider reads most
// of it back from its prompt cache at a fraction of the cost. So the plan's
// limit counts only NEW work: uncached input + cache-written input + output.
// And when the previous request of the same specialist finished moments ago
// with the same prompt so far, the next request reserves only the part added
// since then (plus its reply), instead of the whole re-sent conversation.

/** The provider cache window a plan trusts, conservatively short of the
 *  shortest real one (Anthropic's default is 5 minutes; ours is 1 hour). */
export const PLAN_CACHE_WINDOW_MS = 4 * 60 * 1000;

/** What a completed request leaves behind (journalled on the attempt): when
 *  it finished, how many messages it sent, and the chain link naming them. */
export interface PlanPrefixMark {
  at: number;
  messages: number;
  hash: string;
}

/** The shape of the request about to be sent, for the warm-cache check. */
export interface PlanRequestPrefix {
  /** chain[i] names "system prompt + tool list + the first i messages"
   *  exactly as sent; chain.length = messages + 1. */
  chain: readonly string[];
  /** The adapter's bound over messages[from..] alone (the part added since a
   *  request that sent `from` messages), or undefined when it can't be measured. */
  newPartBound(fromMessage: number): number | undefined;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * The prefix chain of a request. WHY a hash chain over the exact wire copy: a
 * provider cache hits only when the bytes sent match, so "unchanged" is
 * decided by the bytes — any edit to the system prompt, the tool list or an
 * earlier message changes every later link, and the request is treated cold.
 */
export function planRequestPrefix(adapter: PlanBudgetAdapter, request: PlanWireRequest): PlanRequestPrefix {
  const chain = [sha256(JSON.stringify({ system: request.system, tools: request.tools }))];
  for (const message of request.messages) chain.push(sha256(`${chain[chain.length - 1]}\n${JSON.stringify(message)}`));
  return {
    chain,
    newPartBound(from) {
      if (!Number.isSafeInteger(from) || from < 0 || from > request.messages.length) return undefined;
      const bound = adapter.inputBound({ system: '', messages: request.messages.slice(from), tools: [] });
      return bound.ok ? bound.tokens : undefined;
    },
  };
}

/**
 * The input side a request reserves (design §7): only the new part when the
 * same specialist's previous request completed within the route's cache
 * window and the prompt so far is byte-identical; otherwise the full
 * certified bound. It can only LOWER the reservation, never raise it — and
 * the full bound is still what a reported input is checked against.
 */
export function reservationInputBound(input: {
  adapter: PlanBudgetAdapter;
  fullBound: number;
  prefix: PlanRequestPrefix | undefined;
  last: PlanPrefixMark | undefined;
  now: number;
}): number {
  const { adapter, fullBound, prefix, last, now } = input;
  const window = adapter.cacheWindowMs;
  if (window === undefined || !prefix || !last) return fullBound;
  // A clock that went backwards proves nothing about the window.
  if (now < last.at || now - last.at > window) return fullBound;
  if (!Number.isSafeInteger(last.messages) || last.messages < 0 || last.messages >= prefix.chain.length) return fullBound;
  if (prefix.chain[last.messages] !== last.hash) return fullBound;
  const part = prefix.newPartBound(last.messages);
  if (part === undefined || !Number.isSafeInteger(part) || part < 0) return fullBound;
  return Math.min(part, fullBound);
}

/**
 * What a reported request counts against the plan (design §7): everything
 * reported except the input the provider read back from its cache. Cache
 * WRITES stay counted — they are new input. A provider that reports no
 * breakdown has cacheReadTokens 0, so its whole input counts, as before.
 * WHY clamp to the input: a cache-read figure larger than the prompt (a
 * provider quirk) must not erase the reply from the count.
 */
export function countedTokens(report: {
  tokens: number;
  usage: { inputTokens: number; outputTokens?: number; cacheReadTokens: number; cacheCreationTokens?: number };
}): number {
  const cachedRead = Math.min(Math.max(0, report.usage.cacheReadTokens || 0), Math.max(0, report.usage.inputTokens));
  return Math.max(0, report.tokens - cachedRead);
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
   *  whose input can be at most `inputBoundTokens`. `prefix` (revision 5)
   *  lets a warm request reserve only its new part; without it the full
   *  bound is reserved. */
  reserve(input: { inputBoundTokens: number; prefix?: PlanRequestPrefix }): Promise<PlanRequestReservation>;
  /** Charge the request just made and release what it provably did not use. */
  settle(outcome: PlanRequestOutcome): Promise<PlanRequestSettlement>;
  /** Told when a turn stops for a budget reason, so the executor can pause. */
  onStop?(stop: PlanChildStop): void;
}
