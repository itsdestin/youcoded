// Freeze hunt 2026-10-24: fitSummaryToolOutputs re-sized the WHOLE history inside every step of its
// binary search, so trimming many tool outputs of a long conversation froze the main thread for seconds.
// Two pins: (1) the result is exactly what the old whole-history version returned, (2) the work no
// longer grows with (messages x outputs x search steps).
import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import { fitSummaryToolOutputs } from '../src/main/harness/compaction';
import { messagesTokens } from '../src/main/harness/message-size';

/** The pre-fix algorithm, verbatim, as the reference answer. */
function referenceFit(messages: ModelMessage[], maxTokens: number): ModelMessage[] | null {
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
          if (item?.type === 'text' && typeof item.text === 'string') candidates.push({ message, part: index, textPart, value: item.text });
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

function history(turns: number, outChars: (t: number) => number, mixedContent = false): ModelMessage[] {
  const msgs: any[] = [];
  for (let t = 0; t < turns; t++) {
    msgs.push({ role: 'user', content: `q ${t}` });
    msgs.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: `c${t}`, toolName: 'Read', input: {} }] });
    const text = 'r'.repeat(outChars(t));
    // Some results carry a text part inside a 'content' output, so both candidate shapes are exercised.
    msgs.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: `c${t}`, toolName: 'Read',
      output: mixedContent && t % 3 === 0 ? { type: 'content', value: [{ type: 'text', text }, { type: 'text', text: 'tail' }] } : { type: 'text', value: text } }] });
    msgs.push({ role: 'assistant', content: 'done' });
  }
  return msgs;
}

describe('fitSummaryToolOutputs', () => {
  it.each([
    [30, 0.9, false], [30, 0.5, true], [60, 0.3, true], [12, 0.01, false],
  ])('returns exactly what the whole-history version did (%i turns, budget %f of total, mixed=%s)', (turns, ratio, mixed) => {
    const h = history(turns, t => 400 + ((t * 7919) % 5000), mixed);
    const budget = Math.floor(messagesTokens(h) * ratio);
    expect(fitSummaryToolOutputs(h, budget)).toEqual(referenceFit(h, budget));
  });

  it('gives up (null) exactly when the reference does', () => {
    const h = history(20, () => 100);
    expect(fitSummaryToolOutputs(h, 5)).toBeNull();
    expect(referenceFit(h, 5)).toBeNull();
  });

  it('returns the same array untouched when it already fits', () => {
    const h = history(5, () => 100);
    expect(fitSummaryToolOutputs(h, 1e9)).toBe(h);
  });

  it('does not re-read every message for every step of the search', () => {
    // Count how often message content is read. The old version walked all messages per search step:
    // roughly messages x shortened-outputs x ~17 reads. The fix reads each message a bounded number of times.
    const h = history(400, () => 2000) as any[];
    let reads = 0;
    const counted = h.map(m => { const c = m.content; return Object.defineProperty({ ...m }, 'content', { get() { reads++; return c; }, enumerable: true }); });
    const budget = Math.floor(messagesTokens(h) * 0.5);
    expect(fitSummaryToolOutputs(counted, budget)).not.toBeNull();
    expect(reads).toBeLessThan(counted.length * 40);   // old code: well over 100x the message count here
  });
});
