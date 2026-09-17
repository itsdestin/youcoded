// Rebuild ModelMessages from persisted transcript events (spec §2.5). This is
// the RESUME path's history reconstruction — it turns the on-disk transcript
// (as SessionStore.readEvents returns it, i.e. streaming deltas already
// coalesced to one assistant-text/assistant-thinking event per partId) back
// into the ModelMessage[] the driver would have accumulated live.
//
// Grouping MUST mirror the driver's live pushes EXACTLY (harness-session.ts:
// send()/assistantMessage()/toolResultPart()) — the deep-equal test in
// tests/harness-history-rebuild.test.ts is the ARBITER of every grouping choice:
//   - consecutive assistant-text events (coalesced into ONE text part) + the
//     tool-use events that follow them form ONE assistant message
//     ({role:'assistant', content:[text?, ...calls]}),
//   - the tool-results that follow form ONE tool message,
//   - a user-message flushes everything before it.
// A tool-result arriving flushes the open assistant message (this is what keeps
// step 2's text from merging into step 1's assistant message); an assistant-text
// or tool-use arriving flushes any open tool-results.
//   - a tool-use whose id is already in the open message replaces that part (a
//     propose_plan shell followed by its completed call — see the case below).
//
// Deliberately NOT reconstructed: readRegistry (read-before-edit fingerprints), the
// todo list, and the tracked shell cwd — those are per-session RUNTIME state,
// never persisted, and seedHistory() clears them on resume (the reset-on-resume
// ruling, spec §2.5). A resumed session's Bash therefore starts at the root again.
// assistant-thinking / compact-summary / session-error never entered model
// history live either, so they're skipped here too.
import * as path from 'path';
import type { TranscriptEvent } from '../../shared/types';
import type { ModelMessage, TextPart, ToolCallPart, ToolResultPart } from 'ai';

// Synthesized result text for a tool-call that has no persisted result — a
// transcript truncated by a crash mid-execution (see backfillUnpairedToolCalls).
const CRASH_UNPAIRED_TEXT = 'Canceled: this call never completed (the app was closed mid-execution).';

/** Re-reads a persisted image path at rebuild time. Injected (not imported) so
 *  the module stays pure and tests need no filesystem. Production passes
 *  image-support.readImageFromDisk. #290 follow-up fix 2. */
export type RebuildImageReader = (absPath: string) => { mediaType: string; data: Buffer } | null;

export function rebuildHistory(events: TranscriptEvent[], readImage?: RebuildImageReader): ModelMessage[] {
  const out: ModelMessage[] = [];
  let assistantParts: Array<TextPart | ToolCallPart> = [];
  let toolResults: ToolResultPart[] = [];
  const flushAssistant = () => {
    if (assistantParts.length) { out.push({ role: 'assistant', content: assistantParts }); assistantParts = []; }
  };
  const flushResults = () => {
    if (toolResults.length) { out.push({ role: 'tool', content: toolResults }); toolResults = []; }
  };
  for (const e of events) {
    switch (e.type) {
      case 'user-message': {
        flushAssistant(); flushResults();
        const text = String(e.data?.text ?? '');
        // Mirror beginTurn's live push exactly: parts array ONLY when an image was
        // actually readable — a vanished file degrades to the plain string, the same
        // skip-with-the-path-still-in-text semantics send() had live (#290 follow-up
        // fix 2). No reader (pure/legacy call) means today's exact plain-string shape.
        const paths = Array.isArray(e.data?.attachments) ? (e.data.attachments as string[]) : [];
        const parts: Array<{ type: 'file'; mediaType: string; data: Buffer }> = [];
        if (readImage) for (const p of paths) { const img = readImage(p); if (img) parts.push({ type: 'file', mediaType: img.mediaType, data: img.data }); }
        out.push(parts.length
          ? ({ role: 'user', content: [{ type: 'text', text }, ...parts] } as any)
          : { role: 'user', content: text });
        break;
      }
      case 'assistant-text': {
        // A pending tool-result block closes before new assistant text opens.
        flushResults();
        // Coalesce CONSECUTIVE text parts. The driver concatenates all of a
        // step's streamed text into ONE text part (assistantMessage), but the
        // store persists one assistant-text event per partId — so a step that
        // streamed two text blocks arrives here as two events. Merging them back
        // into a single part restores the exact shape the driver pushed live
        // (the deep-equal contract). A tool-use/tool-result between two text
        // events breaks the "consecutive" run, matching the live grouping.
        const text = String(e.data?.text ?? '');
        const last = assistantParts[assistantParts.length - 1];
        if (last && last.type === 'text') last.text += text;
        else if (assistantParts.some((p) => p.type === 'tool-call')) {
          // WHY: the driver always pushes a step as [all of its text, then its
          // calls]. The only tool-use that can precede text inside one open
          // message is a propose_plan shell, which is emitted MID-stream (at
          // tool-input-start) so its "writing" card appears at once — text the
          // model streams after that point still belongs to the step's single
          // leading text part, not to a second part after the call.
          const first = assistantParts[0];
          if (first.type === 'text') first.text += text;
          else assistantParts.unshift({ type: 'text', text });
        } else assistantParts.push({ type: 'text', text });
        break;
      }
      case 'tool-use': {
        flushResults();
        const call: ToolCallPart = { type: 'tool-call', toolCallId: String(e.data?.toolUseId ?? ''), toolName: String(e.data?.toolName ?? ''), input: e.data?.toolInput ?? {} };
        // WHY a repeated id REPLACES the earlier part: a propose_plan shell is
        // persisted with empty input when the model starts writing, and the
        // same id is persisted again with the real arguments once the call
        // completes. Both lines are one call — the later one is the truth, and
        // it goes where the driver put the call: after every shell that never
        // completed, in completion order. (Text is always merged into the
        // leading part above, so removing a call never leaves two texts adjacent.)
        const earlier = assistantParts.findIndex((p) => p.type === 'tool-call' && p.toolCallId === call.toolCallId);
        if (earlier >= 0) assistantParts.splice(earlier, 1);
        assistantParts.push(call);
        break;
      }
      case 'tool-result': {
        // Close the assistant(tool-call) message this result answers — this
        // flush is what prevents the NEXT step's text from merging into it.
        flushAssistant();
        const base = String(e.data?.toolResult ?? '');
        const imagePaths = Array.isArray(e.data?.images) ? (e.data.images as string[]) : [];
        if (!imagePaths.length || !readImage) {
          toolResults.push({ type: 'tool-result', toolCallId: String(e.data?.toolUseId ?? ''), toolName: String(e.data?.toolName ?? ''), output: { type: 'text', value: base } });
          break;
        }
        // Tool-delivered images (e.g. Read on a picture) are re-read from disk
        // at rebuild time — events carry paths, not binary (Task 5). A vanished
        // or undeliverable file becomes a NAMED note in the text, never a
        // silent dangling reference: the model must not go on believing it
        // holds a picture that isn't there (the failure class this milestone
        // exists to eliminate). A changed file is re-read as-is: current
        // pixels beat none. Multiple images degrade independently, so a
        // partially-available result still delivers whatever IS readable.
        let text = base;
        const files: Array<{ type: 'file'; mediaType: string; data: { type: 'data'; data: Buffer }; filename: string }> = [];
        for (const p of imagePaths) {
          const img = readImage(p);
          // Fix 3 (2026-08-11 review): identical derivation to resolveToolImages
          // in harness-session.ts — the file's own basename, not the tool's
          // name. If these two ever disagree, a resumed session labels images
          // differently from a live one. Importing `path` here (pure string
          // manipulation) doesn't compromise this module's purity rule — that
          // rule is specifically about the IMAGE READER staying injected, not
          // about avoiding stdlib string utilities.
          if (img) files.push({ type: 'file', mediaType: img.mediaType, data: { type: 'data', data: img.data }, filename: path.basename(p) });
          else text += `\n[image no longer available: ${p}]`;
        }
        toolResults.push({
          type: 'tool-result', toolCallId: String(e.data?.toolUseId ?? ''), toolName: String(e.data?.toolName ?? ''),
          output: files.length ? ({ type: 'content', value: [{ type: 'text', text }, ...files] } as any) : { type: 'text', value: text },
        });
        break;
      }
      case 'turn-complete':
      case 'user-interrupt':
        flushAssistant(); flushResults();
        break;
      // /clear's CONTEXT BARRIER (M3 item 2). Everything before it is dropped
      // from the REBUILT model history — the on-disk events are untouched and
      // still replay into the visible timeline, which is the whole point of the
      // barrier design: the conversation stays readable, the model's memory does
      // not. Discarding the in-progress accumulators too (rather than flushing
      // them) is deliberate: a half-built assistant message from before the
      // barrier must not survive into the post-barrier history, and dropping an
      // unpaired tool-call here is safe because nothing after the barrier can
      // reference it.
      // A user-invoked skill enters model history as its INSTRUCTIONS, exactly as
      // it did live. Rendering is a separate concern (a compact card); without
      // this a resumed session would replay a turn whose opening move has no cause.
      case 'skill-invoked':
        if (e.data.body) {
          out.push({ role: 'user', content: e.data.args ? `${e.data.body}\n\n${e.data.args}` : e.data.body });
        }
        break;
      case 'context-clear':
        out.length = 0;
        assistantParts = [];
        toolResults = [];
        break;
      default:
        // assistant-thinking, compact-summary, session-error, and any unknown
        // future type never enter model history in Plan A.
        break;
    }
  }
  flushAssistant(); flushResults();
  return backfillUnpairedToolCalls(out);
}

/**
 * Guarantee the provider invariant: in the rebuilt history, every assistant
 * tool-call part is IMMEDIATELY followed by a tool message covering its
 * toolCallId. A persisted transcript can violate this two ways, both from a
 * process death mid-execution (a wide window while Bash/Edit runs):
 *   - TRUNCATED TAIL: the stream ends on an unpaired tool-use (result never
 *     persisted). Left alone, the final assistant message ends on a dangling
 *     tool-call and the first resumed send() 400s from real providers.
 *   - MID-STREAM ORPHAN: after a crash the session was resumed and MORE events
 *     appended, so an unpaired tool-use sits in the MIDDLE (assistant tool-call
 *     directly followed by a user-message) — the store is never healed.
 * fitToContext only trims LEADING orphans, so neither case is caught downstream;
 * a bricked session persists across sends. Synthesize an isError tool-result for
 * each unpaired call — faithful to the live interrupt/cancel back-fill.
 */
function backfillUnpairedToolCalls(messages: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    out.push(msg);
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const calls = (msg.content as Array<{ type: string }>).filter((p): p is ToolCallPart => p.type === 'tool-call');
    if (calls.length === 0) continue;

    const next = messages[i + 1];
    const nextIsTool = !!next && next.role === 'tool' && Array.isArray(next.content);
    const covered = new Set<string>();
    if (nextIsTool) {
      for (const p of next!.content as ToolResultPart[]) if (p.type === 'tool-result') covered.add(p.toolCallId);
    }
    const missing = calls.filter((c) => !covered.has(c.toolCallId));
    if (missing.length === 0) continue;

    const synthetic: ToolResultPart[] = missing.map((c) => ({
      type: 'tool-result', toolCallId: c.toolCallId, toolName: c.toolName,
      output: { type: 'text', value: CRASH_UNPAIRED_TEXT },
    }));
    if (nextIsTool) {
      // Partial coverage: merge synthetic results into the following tool
      // message and CONSUME the original (i++), so it isn't emitted twice.
      out.push({ role: 'tool', content: [...(next!.content as ToolResultPart[]), ...synthetic] });
      i++;
    } else {
      // No tool message follows (truncated tail, or the tool-call sits right
      // before a user-message) — insert a fresh tool message to pair it.
      out.push({ role: 'tool', content: synthetic });
    }
  }
  return out;
}
