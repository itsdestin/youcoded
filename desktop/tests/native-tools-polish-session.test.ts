// G-11 (2026-08-26 tools investigation): the Read re-read dedupe promises "the
// content you already have is current". That promise is only true while the
// earlier Read result is still in the model's view. Every site that discards or
// shrinks history — resume, /clear, automatic compaction (prune or summarize),
// manual /compact — must forget what was served, or the notice becomes a lie
// and the model can never get the content back without an unrelated mtime change.
import { describe, it, expect } from 'vitest';
import { makeSession, scriptModel } from './helpers/harness-fakes';

function seeded(session: any): any {
  // history: user A → assistant → a 20k-char Read result (old enough to be
  // outside the prune-protected window once a 7k-char user turn follows it).
  session.seedHistory([
    { role: 'user', content: 'USER-A: look at the file' },
    { role: 'assistant', content: 'reading' },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'Read', output: { type: 'text', value: 'x'.repeat(20_000) } }] },
    { role: 'user', content: 'USER-B ' + 'y'.repeat(7_000) },
    { role: 'assistant', content: 'ok' },
  ]);
  session.servedReads.set('/x/a.txt|1|2000', { mtimeMs: 1, fingerprint: '0:x', callIndex: 1, from: 1, to: 3 });
  expect(session.servedReads.size).toBe(1);
  // The Skill tool's repeat guard (2026-09-23) shares this lifetime contract:
  // "already loaded" is only true while the skill's body is still in view.
  session.servedSkills.add('superpowers:brainstorming');
  return session;
}

describe('servedReads and servedSkills are forgotten wherever history is discarded or shrunk', () => {
  it('seedHistory (resume) clears it', () => {
    const s = seeded(makeSession({ contextLength: 4096 }) as any);
    s.seedHistory([]);
    expect(s.servedReads.size).toBe(0);
    expect(s.servedSkills.size).toBe(0);
  });

  it('clearHistory (/clear) clears it', () => {
    const s = seeded(makeSession({ contextLength: 4096 }) as any);
    expect(s.clearHistory()).toEqual({ ok: true });
    expect(s.servedReads.size).toBe(0);
    expect(s.servedSkills.size).toBe(0);
  });

  it('automatic compaction clears it when a complete summary retires old history', async () => {
    const s = seeded(makeSession({ contextLength: 32_768, model: scriptModel([{ text: 'SUMMARY' }]) }) as any);
    // WHY: 30k reported input crosses the legacy trigger in a window that
    // still has room for the summary request and its output allowance.
    s.abort = new AbortController(); // normally owned by send() around maybeCompact
    try { await s.maybeCompact(scriptModel([{ text: 'SUMMARY' }]), 30_000, {}); }
    finally { s.abort = null; }
    expect(s.servedReads.size).toBe(0);
    expect(s.servedSkills.size).toBe(0);
  });

  it('automatic compaction leaves it alone when nothing needs compacting', async () => {
    const s = seeded(makeSession({ contextLength: 4096 }) as any);
    await s.maybeCompact(scriptModel([{ text: 'SUMMARY' }]), 10);
    expect(s.servedReads.size).toBe(1);
    expect(s.servedSkills.size).toBe(1);
  });

  it('manual compaction (compactNow) clears it', async () => {
    const s = seeded(makeSession({ contextLength: 32_768, model: scriptModel([{ text: 'SUMMARY' }]) }) as any);
    expect(await s.compactNow()).toEqual({ ok: true });
    expect(s.servedReads.size).toBe(0);
    expect(s.servedSkills.size).toBe(0);
  });
});
