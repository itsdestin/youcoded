// Pure context planning and group-safe tail selection. Legacy prune transforms
// remain for accepted-history snapshot decoding; routine decisions summarize.
import type { ModelMessage } from 'ai';
import { messageTokens, messagesTokens } from './message-size';
import { COMPACTION_PROMPT } from './prompts/compaction';
import { isHistoryOnlyUserMessage } from './history-only';

export interface ContextBudgetInput {
  contextLength: number | null;
  providerInputLimit?: number | null;
  fixedCost: number;
  summaryOverhead: number;
  maxTokens: number;
  knownSummaryOutputMax?: number | null;
  reasoningAllowance?: number;
  estimatedInput?: number;
}

export interface ContextBudgetPlan {
  status: 'fits' | 'compact' | 'cannot-fit';
  contextLength: number;
  estimatedWindow: boolean;
  fixedCost: number;
  replyReserve: number;
  summaryAllowance: number;
  margin: number;
  trigger: number;
  tail: number;
  replyCap: number;
  maxTokens: number;
}

/**
 * Plan the independent request, summary and retained-tail budgets from §2.1.
 * WHY this is separate from the compatibility wrapper below: Task 1 pins the
 * new arithmetic without changing older callers' object shape ahead of loop
 * integration, while later tasks can adopt the richer plan incrementally.
 */
export function planContextBudget(input: ContextBudgetInput): ContextBudgetPlan {
  // WHY: unknown model windows use a 32k assumption, but a known provider
  // input cap can still be smaller. Never plan above that cap.
  const assumedWindow = input.contextLength ?? 32_768;
  const effective = Math.min(assumedWindow, input.providerInputLimit ?? assumedWindow);
  const R = Math.min(16_000, Math.floor(effective / 4));
  const M = Math.max(Math.min(1_024, Math.floor(effective / 32)), Math.floor(effective / 100));
  const knownSummary = input.knownSummaryOutputMax == null ? 13_107 : Math.min(13_107, input.knownSummaryOutputMax);
  const S = Math.min(knownSummary, Math.floor((effective - input.fixedCost) / 4));
  const trigger = effective - Math.max(R, S) - M - input.summaryOverhead;
  const tail = Math.min(20_000, Math.floor((trigger - input.fixedCost) / 4));
  const inputBudget = effective - (input.estimatedInput ?? 0) - M;
  const replyCap = Math.max(0, Math.min(input.maxTokens, inputBudget));
  const cannotFit = effective <= 0 || input.fixedCost <= 0 || S <= 0 || M <= 0 || trigger <= 0 || tail <= 0 || replyCap <= 0;
  return {
    status: cannotFit ? 'cannot-fit' : (input.estimatedInput ?? 0) >= trigger ? 'compact' : 'fits',
    contextLength: effective, estimatedWindow: input.contextLength == null, fixedCost: input.fixedCost,
    replyReserve: R, summaryAllowance: S, margin: M, trigger, tail, replyCap, maxTokens: input.maxTokens,
  };
}

/** Check the finished candidate, not the proposed summary output allowance. */
export function validateCompactionCandidate(
  plan: ContextBudgetPlan, original: ModelMessage[], candidate: ModelMessage[],
): 'fits' | 'cannot-fit' {
  const before = plan.fixedCost + messagesTokens(original);
  const after = plan.fixedCost + messagesTokens(candidate);
  // WHY: plan.replyCap/status describe the ORIGINAL request. A compacted
  // candidate can free enough room for a reply even when that cap was zero.
  // Still reject intrinsic budget failures (including an invalid output max).
  const candidateReplyCap = Math.min(plan.maxTokens, plan.contextLength - after - plan.margin);
  return plan.contextLength > 0 && plan.fixedCost > 0 && plan.fixedCost < plan.contextLength
    && plan.summaryAllowance > 0 && plan.margin > 0 && plan.trigger > 0 && plan.tail > 0
    && candidateReplyCap > 0 && after < before && after <= plan.trigger - plan.tail
    ? 'fits' : 'cannot-fit';
}

// Non-enumerable provenance does not change the wire message or accepted-history
// capture. Restorers must reattach it from transcript/manifest origin, never text.
const APP_GENERATED = Symbol('app-generated-user-message');
export function markAppGenerated<T extends ModelMessage>(message: T): T {
  Object.defineProperty(message, APP_GENERATED, { value: true });
  return message;
}
export function isAppGenerated(message: ModelMessage): boolean {
  return message.role === 'user' && Boolean((message as any)[APP_GENERATED]);
}
/** Fit the summarizer's copy only, never the accepted history or retained tail.
 * WHY: a single oversized retired tool output may arrive after the planned
 * trigger; shortening it in this one request preserves the user's instructions
 * and the call/result structure without rewriting what the user can read. */
export function fitSummaryToolOutputs(messages: ModelMessage[], maxTokens: number): ModelMessage[] | null {
  if (messagesTokens(messages) <= maxTokens) return messages;
  const candidates: { message: number; part: number; textPart?: number; value: string }[] = [];
  messages.forEach((m, message) => {
    if (m.role !== 'tool' || !Array.isArray(m.content)) return;
    m.content.forEach((part: any, index) => {
      if (part?.type !== 'tool-result') return;
      if (part.output?.type === 'text' && typeof part.output.value === 'string') {
        candidates.push({ message, part: index, value: part.output.value });
      } else if (part.output?.type === 'content' && Array.isArray(part.output.value)) {
        part.output.value.forEach((item: any, textPart: number) => {
          if (item?.type === 'text' && typeof item.text === 'string') {
            candidates.push({ message, part: index, textPart, value: item.text });
          }
        });
      }
    });
  });
  candidates.sort((a, b) => b.value.length - a.value.length);
  const copy = [...messages];
  for (const { message, part, textPart, value } of candidates) {
    if (messagesTokens(copy) <= maxTokens) break;
    const original = copy[message] as Extract<ModelMessage, { role: 'tool' }>;
    const replacement = (length: number): ModelMessage => {
      const content = [...original.content];
      const old = content[part] as any;
      const shortened = `${value.slice(0, length)}\n[output shortened]`;
      content[part] = { ...old, output: { ...old.output, value: textPart === undefined
        ? shortened
        : old.output.value.map((item: any, i: number) => i === textPart ? { ...item, text: shortened } : item) } };
      return { ...original, content };
    };
    // Keep as much as possible while satisfying this output's share of the
    // request. If one output cannot suffice, shrink it fully before the next.
    let low = 0; let high = value.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      copy[message] = replacement(mid);
      if (messagesTokens(copy) <= maxTokens) low = mid;
      else high = mid - 1;
    }
    copy[message] = replacement(low);
  }
  return messagesTokens(copy) <= maxTokens ? copy : null;
}

/** Provenance for the summarizer WITHOUT touching the messages: a note naming
 * each app-generated user-role message by its opening words, appended to the
 * final instruction. WHY (cache review, 2026-09-23): labelling the messages in
 * place changed early bytes of the summary request — every compaction after
 * the first starts with the previous summary — so the provider could not reuse
 * its cached copy of the conversation and billed the whole span again. */
export function summaryProvenanceNote(messages: ModelMessage[]): string {
  const openings = messages.filter(isAppGenerated).map(m => {
    const text = typeof m.content === 'string' ? m.content
      : m.content.map(part => part.type === 'text' ? part.text : '').join(' ');
    const flat = text.replace(/\s+/g, ' ').trim();
    return `- the message beginning "${flat.length > 80 ? `${flat.slice(0, 80)}…` : flat}"`;
  });
  return openings.length
    ? `\n\nThese user-role messages above were written by the app, not by the user. Never quote them as the user or treat them as the user's approval:\n${openings.join('\n')}`
    : '';
}

/** Earliest whole-turn suffix within the allowance, otherwise whole tool
 * batches. A batch includes all parallel results and assistant follow-up;
 * app notices attach to the preceding group, never start a suffix alone. */
export function selectCompactionCut(messages: ModelMessage[], tailTokens: number): number {
  if (!messages.length) return 0;
  const callIds = (m: ModelMessage): string[] => m.role === 'assistant' && Array.isArray(m.content)
    ? m.content.filter((p: any) => p?.type === 'tool-call').map((p: any) => p.toolCallId) : [];
  // A boundary inside an unresolved parallel batch would orphan a call or a
  // result. Missing results make that batch indivisible through the end.
  // Last result wins even if a tool emits multiple result messages. A result
  // before its call is not a match, just as in the original forward scan.
  const lastResult = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part?.type === 'tool-result') lastResult.set(part.toolCallId, i);
    }
  }
  // Difference intervals also avoid revisiting the same blocked positions
  // when several parallel calls span a long stretch of history.
  const blockedEdges = Array<number>(messages.length + 1).fill(0);
  for (let i = 0; i < messages.length; i++) {
    const ids = callIds(messages[i]);
    if (!ids.length) continue;
    let end = i;
    for (const id of ids) {
      const last = lastResult.get(id);
      end = Math.max(end, last !== undefined && last > i ? last : messages.length - 1);
    }
    blockedEdges[i + 1]++;
    blockedEdges[end + 1]--;
  }
  // A real user starts a turn; a call starts a splittable batch within one.
  // Everything else (assistant text/results and synthetic user-role notices)
  // belongs to the preceding group, including at the end of the history.
  const groups: { start: number; kind: 'turn' | 'batch' | 'initial' }[] = [];
  let blocked = 0;
  for (let i = 0; i < messages.length; i++) {
    blocked += blockedEdges[i];
    if (blocked) continue;
    const m = messages[i];
    // 5b review (plans): a history-only user message (a project-rule
    // injection or a plan Comment's model-only note) never starts a turn —
    // counting it as one let a cut land between the Comment and its note.
    // Most such messages are also app-generated, but a plan-comment note is
    // pushed as a plain user message (beginTurn's historyNote), so this
    // check must run independently of isAppGenerated, not instead of it.
    if (m.role === 'user' && !isAppGenerated(m) && !isHistoryOnlyUserMessage(m)) groups.push({ start: i, kind: 'turn' });
    else if (callIds(m).length) groups.push({ start: i, kind: 'batch' });
    else if (i === 0) groups.push({ start: i, kind: 'initial' });
  }
  const suffix = Array<number>(messages.length + 1).fill(0);
  for (let i = messages.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + messageTokens(messages[i]);
  if (suffix[0] <= tailTokens) return 0;
  const fits = groups.filter(g => g.start > 0 && suffix[g.start] <= tailTokens);
  const turn = fits.find(g => g.kind === 'turn');
  if (turn) return turn.start;
  if (fits.length) return fits[0].start;
  // Oversized newest complete group stays intact; validation decides fit.
  return groups.at(-1)?.start ?? 0;
}

export interface CompactionConfig {
  contextLength: number; triggerTokens: number; protectedTokens: number; minPruneSavings: number; pruneToChars: number;
}

/** The ONE budget every window-sized number derives from (cache follow-ups
 *  item 2, 2026-09-10): the reply reserve, the request trimmer's budget and the
 *  compaction trigger.
 *
 *  WHY one function: these used to be computed in two places with two
 *  different reserves — the trimmer used the manifest's flat 16,000 output
 *  reserve while compaction triggered at a flat 0.75 × window. On a 32k local
 *  window that trimmed the outgoing request from 15,744 tokens while
 *  compaction waited for 24,576, so every step in between was re-trimmed from
 *  a moving front edge and llama.cpp re-read the whole conversation each step;
 *  under ~17k of window the trim budget went negative and the request
 *  collapsed to the newest message alone.
 *
 *  - replyReserve: min(maxTokens, window / 4). A quarter of the window is the
 *    most any reply may take before fitting history (Unsloth Studio's rule);
 *    the manifest's value still caps it on big windows. Left at the manifest
 *    value when the window is UNKNOWN, so a cloud model whose window the
 *    catalog could not name keeps its full output allowance.
 *  - trimBudget: window − reserve − 1,024 margin. The emergency floor.
 *  - triggerTokens: min(0.75 × window, 0.9 × trimBudget). Compaction must win
 *    the race with the trimmer on every window; the 0.75 cap keeps cloud
 *    behaviour exactly what it was on windows where it already did.
 *  An unknown window is assumed 32k for the budget math, as it always was. */
export function contextBudget(o: { contextLength: number | null; maxTokens: number }): { replyReserve: number; trimBudget: number; triggerTokens: number } {
  const ctx = o.contextLength ?? 32_768;
  const replyReserve = o.contextLength == null ? o.maxTokens : Math.min(o.maxTokens, Math.floor(ctx / 4));
  const trimBudget = ctx - replyReserve - 1024;
  const triggerTokens = Math.min(Math.floor(ctx * 0.75), Math.floor(trimBudget * 0.9));
  return { replyReserve, trimBudget, triggerTokens };
}
const PRUNE_TRAILER = (n: number) => `\n\n[pruned — ${n} chars of tool output elided to fit context; re-run the tool if you need it again]`;

// WHY: the durable continuation manifest REFERENCES transcript text instead of
// copying it, so it has to recompute a pruned tool result byte-for-byte from the
// untouched event text. These two helpers are the single definition of that
// transform — pruneToolOutputs below calls them, and accepted-history-store.ts
// calls them to recognise and rebuild a pruned part. If prune ever diverged from
// the recomputation, a resumed session would silently disagree with the live one.
export function prunedToolResultText(value: string, keepChars: number): string {
  return value.slice(0, keepChars) + PRUNE_TRAILER(value.length - keepChars);
}
export function imageCollapsedToolResultText(text: string, toolName: string | undefined): string {
  const note = `[image pruned — re-run ${toolName ?? 'the tool'} if you need to see it again]`;
  return text ? `${text}\n${note}` : note;
}

export function estimateTokens(messages: ModelMessage[]): number {
  return messagesTokens(messages);   // binary-aware (#290 follow-up fix 1)
}
// Returns the first index of the protected recent window: [cutoff, end] is kept
// verbatim, [0, cutoff) is eligible for pruning. We walk from the newest message
// backward, summing tokens, and stop once the budget is exceeded.
// WHY `return i` (not i+1): the message that pushes us over the budget must itself
// stay protected. Otherwise a single huge recent tool result (e.g. a 40k-char Read
// that alone blows past protectedTokens on the very first step) would fall OUTSIDE
// the window and get pruned — defeating the whole point of protecting recent context.
function protectedFrom(messages: ModelMessage[], protectedTokens: number): number {
  let acc = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += messageTokens(messages[i]);   // binary-aware — see message-size.ts
    if (acc > protectedTokens) return i;
  }
  return 0;
}
// Fix 1 (2026-08-11 review): this comment used to claim prune "only shrinks
// tool-result TEXT" — that stopped being true when the content-output branch
// below started collapsing image-bearing outputs (discarding the file part).
// Shrinks oversized tool-result text, and collapses image-bearing tool-result
// output down to text-only (dropping the file part) — but never drops a
// message, so no tool-call loses its paired result (pairing invariant).
export function pruneToolOutputs(messages: ModelMessage[], cfg: CompactionConfig): ModelMessage[] {
  const cutoff = protectedFrom(messages, cfg.protectedTokens);
  return messages.map((m, i) => {
    if (i >= cutoff || (m as any).role !== 'tool' || !Array.isArray((m as any).content)) return m;
    // WHY the identity contract (cache Stage 4): a message NONE of whose parts
    // were touched is returned as the SAME object, not a rebuilt copy. The
    // harness decides whether a compaction really changed history by diffing
    // this array per message (harness-session.ts, maybeCompact/compactNow), and
    // an unconditional `{ ...m, content }` made that diff fire on a genuine
    // no-op — bumping the accepted-history revision and invalidating a
    // published checkpoint for a history that never moved. Pinned by
    // tests/compaction.test.ts ("returns an UNCHANGED tool message by identity").
    let changed = false;
    const content = (m as any).content.map((part: any) => {
      const pruned = prunePart(part, cfg);
      if (pruned !== part) changed = true;
      return pruned;
    });
    return changed ? { ...(m as any), content } : m;
  });
}
// One tool-result part's prune, returning the part ITSELF when nothing applies —
// which is what lets pruneToolOutputs above keep whole untouched messages by
// identity. Split out only so that "unchanged" is a single, obvious signal.
function prunePart(part: any, cfg: CompactionConfig): any {
  if (part?.type !== 'tool-result') return part;
  const output = part.output;
  // AI SDK v7 'content' output (tool-delivered images: text + file parts).
  // Outside the protected window this collapses to its text plus a named
  // note — same rule as the string branch below. Without this branch,
  // stage-1 prune could only ever shrink STRING outputs, so an image sat
  // in the window unreclaimed until a full summarize silently destroyed
  // it (the exact silent-loss class this milestone exists to eliminate).
  if (output?.type === 'content' && Array.isArray(output.value)) {
    const text = output.value.filter((v: any) => v?.type === 'text').map((v: any) => v.text).join('\n');
    // Fix 2 (2026-08-11 review): only claim "[image pruned]" when a file
    // part is actually present. Both known producers of 'content' output
    // always attach a file, so this is unreachable today — but a fileless
    // 'content' output collapsing to an "[image pruned]" note would be
    // model-facing text about an image that never existed, AND would (via
    // countImageOutputs, kept in sync with this check below) trip the
    // shownImages cache-clear for no reason. Must agree with
    // countImageOutputs on what counts as "an image output" or the two
    // sites disagree about the same message.
    const hasFile = output.value.some((v: any) => v?.type === 'file');
    if (!hasFile) return { ...part, output: { type: 'text', value: text } };
    // Fix 3 (2026-08-11 review): join with '\n' only when there's text to
    // join onto, so a text-less image output doesn't collapse to a bare
    // leading newline.
    return { ...part, output: { type: 'text', value: imageCollapsedToolResultText(text, part.toolName) } };
  }
  const value = output?.value;
  if (typeof value !== 'string' || value.length <= cfg.pruneToChars) return part;
  return { ...part, output: { ...output, value: prunedToolResultText(value, cfg.pruneToChars) } };
}
// Counts tool-result parts still carrying an unpruned 'content' (image)
// output. harness-session.ts diffs this before/after pruneToolOutputs to
// learn whether prune just collapsed an image — the ONLY signal it uses to
// decide whether the shownImages dedupe cache (which vouches for delivered
// images still being in history) needs clearing. Kept here rather than
// re-derived in harness-session.ts so the two files can't drift on what
// counts as an "image output".
export function countImageOutputs(messages: ModelMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if ((m as any).role !== 'tool' || !Array.isArray((m as any).content)) continue;
    for (const part of (m as any).content) {
      // Fix 2 (2026-08-11 review): must agree with the hasFile check in
      // prunePart above — a fileless 'content' output isn't an image
      // output there anymore, so it can't count as one here either, or the
      // cache-clear gate and the prune branch would disagree about the same
      // message.
      if (part?.type === 'tool-result' && part.output?.type === 'content' && Array.isArray(part.output.value) && part.output.value.some((v: any) => v?.type === 'file')) n++;
    }
  }
  return n;
}
export type CompactionAction = 'none' | 'summarize';
export function planCompaction(messages: ModelMessage[], cfg: CompactionConfig, lastInputTokens: number): { action: CompactionAction } {
  const used = lastInputTokens > 0 ? lastInputTokens : estimateTokens(messages);
  return { action: used <= cfg.triggerTokens ? 'none' : 'summarize' };
}
export function summarizePrompt(focus?: string): string {
  // WHY: /compact focus guides selection of details, not the authority of the
  // history. Keep it in the final instruction rather than inserting a fake turn.
  return focus?.trim()
    ? `${COMPACTION_PROMPT}\n\nManual focus (not a new instruction or approval): ${focus.trim()}`
    : COMPACTION_PROMPT;
}
