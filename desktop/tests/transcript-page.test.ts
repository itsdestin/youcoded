import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
// The module object itself (not the frozen ESM namespace), so vi.spyOn can
// replace a method and catch a blocking call made from the page reader.
import fsModule from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { readTranscriptPage, PAGE_TURNS, PAGE_MAX_BYTES } from '../src/main/transcript-page';

// A minimal CC-shaped transcript: one user prompt line + one assistant end_turn
// line per turn, each with a unique uuid. Mirrors the rig fixture's
// transcriptLines (two JSONL lines per turn).
function turnLines(i: number): string {
  const user = JSON.stringify({
    type: 'user', uuid: `u-${i}`, promptId: `p-${i}`, isMeta: false,
    timestamp: new Date(1_700_000_000_000 + i).toISOString(),
    message: { role: 'user', content: `prompt ${i}` },
  });
  const asst = JSON.stringify({
    type: 'assistant', uuid: `a-${i}`,
    timestamp: new Date(1_700_000_000_001 + i).toISOString(),
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `reply ${i}` }] },
  });
  return user + '\n' + asst + '\n';
}

function writeTranscript(turns: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-test-'));
  const p = path.join(dir, 'session.jsonl');
  let body = '';
  for (let i = 0; i < turns; i++) body += turnLines(i);
  fs.writeFileSync(p, body);
  return p;
}

describe('readTranscriptPage — CC transcript', () => {
  let jsonlPath: string;
  afterEach(() => { try { fs.rmSync(path.dirname(jsonlPath), { recursive: true, force: true }); } catch { /* best effort */ } });

  it('a short file (< PAGE_TURNS) returns every turn and hasMore=false', async () => {
    jsonlPath = writeTranscript(5);
    const page = await readTranscriptPage({ jsonlPath, sessionId: 's1', endOffset: null });
    // 5 turns x 2 renderable events (user-message + assistant-text)
    expect(page.events.filter((e) => e.type === 'user-message')).toHaveLength(5);
    expect(page.events.filter((e) => e.type === 'assistant-text')).toHaveLength(5);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBeNull();
    // Order preserved oldest -> newest within the page.
    const firstUser = page.events.find((e) => e.type === 'user-message');
    expect(firstUser?.data.text).toBe('prompt 0');
  });

  it('a long file returns only the last PAGE_TURNS turns and hasMore=true', async () => {
    jsonlPath = writeTranscript(PAGE_TURNS + 20);
    const page = await readTranscriptPage({ jsonlPath, sessionId: 's1', endOffset: null });
    const users = page.events.filter((e) => e.type === 'user-message');
    expect(users).toHaveLength(PAGE_TURNS);
    // The newest turn is present; the oldest 20 are not.
    expect(users[0].data.text).toBe('prompt 20');
    expect(users[users.length - 1].data.text).toBe(`prompt ${PAGE_TURNS + 19}`);
    expect(page.hasMore).toBe(true);
    expect(page.cursor).not.toBeNull();
  });

  it('the cursor pages backward to the beginning, then stops', async () => {
    jsonlPath = writeTranscript(PAGE_TURNS + 20);
    const first = await readTranscriptPage({ jsonlPath, sessionId: 's1', endOffset: null });
    const second = await readTranscriptPage({ jsonlPath, sessionId: 's1', endOffset: first.cursor!.offset });
    const users2 = second.events.filter((e) => e.type === 'user-message');
    expect(users2).toHaveLength(20); // the remaining older turns
    expect(users2[0].data.text).toBe('prompt 0');
    expect(users2[users2.length - 1].data.text).toBe('prompt 19');
    expect(second.hasMore).toBe(false);
  });

  it('a page never splits a turn — its first event is the user prompt', async () => {
    jsonlPath = writeTranscript(PAGE_TURNS + 20);
    const page = await readTranscriptPage({ jsonlPath, sessionId: 's1', endOffset: null });
    expect(page.events[0].type).toBe('user-message');
  });

  it('PAGE_MAX_BYTES stops a heavy page early (fewer than PAGE_TURNS turns)', async () => {
    // Turns padded past 2 MB in far fewer than PAGE_TURNS turns.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-test-'));
    jsonlPath = path.join(dir, 'session.jsonl');
    const bigText = 'x'.repeat(300 * 1024); // 300 KB per assistant line
    let body = '';
    for (let i = 0; i < PAGE_TURNS; i++) {
      body += JSON.stringify({ type: 'user', uuid: `u-${i}`, promptId: `p-${i}`, isMeta: false, timestamp: new Date(1_700_000_000_000 + i).toISOString(), message: { role: 'user', content: `q${i}` } }) + '\n';
      body += JSON.stringify({ type: 'assistant', uuid: `a-${i}`, timestamp: new Date(1_700_000_000_001 + i).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: bigText }] } }) + '\n';
    }
    fs.writeFileSync(jsonlPath, body);
    expect(fs.statSync(jsonlPath).size).toBeGreaterThan(PAGE_MAX_BYTES);
    const page = await readTranscriptPage({ jsonlPath, sessionId: 's1', endOffset: null });
    const users = page.events.filter((e) => e.type === 'user-message');
    expect(users.length).toBeLessThan(PAGE_TURNS); // capped by bytes, not turns
    expect(users.length).toBeGreaterThan(0);
    expect(page.hasMore).toBe(true);
  });

  it('a missing file returns an empty page, not a throw', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-test-'));
    jsonlPath = path.join(dir, 'nope.jsonl');
    const page = await readTranscriptPage({ jsonlPath, sessionId: 's1', endOffset: null });
    expect(page.events).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBeNull();
  });

  it('includes subagent events only for Agent tool_uses inside the page', async () => {
    // Agent tool_use in turn 45 (inside the last PAGE_TURNS of 50) and in turn 3
    // (outside it). Both have agent-*.jsonl + .meta.json on disk; only the
    // in-page one may be replayed, because the index is primed from the page.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-test-'));
    jsonlPath = path.join(dir, 'session.jsonl');
    const subagentsDir = path.join(dir, 'cc-1', 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });

    const agentToolUse = (i: number, desc: string) => JSON.stringify({
      type: 'assistant', uuid: `ag-${i}`,
      timestamp: new Date(1_700_000_000_500 + i).toISOString(),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `tu-${i}`, name: 'Agent', input: { description: desc, subagent_type: 'Explore' } }] },
    }) + '\n';

    let body = '';
    for (let i = 0; i < PAGE_TURNS + 20; i++) {
      body += turnLines(i);
      if (i === 3) body += agentToolUse(i, 'old sweep');
      if (i === 45) body += agentToolUse(i, 'new sweep');
    }
    fs.writeFileSync(jsonlPath, body);

    for (const [agentId, desc, text] of [['a3', 'old sweep', 'OLD-SUBAGENT'], ['a45', 'new sweep', 'NEW-SUBAGENT']] as const) {
      fs.writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`), JSON.stringify({ description: desc, agentType: 'Explore' }));
      fs.writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`), JSON.stringify({
        type: 'assistant', uuid: `sub-${agentId}`, isSidechain: true,
        timestamp: new Date(1_700_000_000_900).toISOString(),
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
      }) + '\n');
    }

    const page = await readTranscriptPage({ jsonlPath, sessionId: 's1', endOffset: null, subagentsDir });
    const texts = page.events.map((e) => e.data.text ?? '');
    expect(texts).toContain('NEW-SUBAGENT');
    expect(texts).not.toContain('OLD-SUBAGENT');
    // And the replayed subagent event is stamped with its parent Agent tool_use.
    const sub = page.events.find((e) => e.data.text === 'NEW-SUBAGENT');
    expect(sub?.data.parentAgentToolUseId).toBe('tu-45');
  });

  it('a cursor whose offset is past the current file size yields an empty final page', async () => {
    jsonlPath = writeTranscript(PAGE_TURNS + 20);
    const first = await readTranscriptPage({ jsonlPath, sessionId: 's1', endOffset: null });
    // Simulate a /compact: the file is REWRITTEN shorter, but still holds whole
    // turns — so without the guard the reader happily serves content from a
    // conversation state the cursor was never minted against.
    fs.truncateSync(jsonlPath, first.cursor!.offset - 200);
    const stale = await readTranscriptPage({ jsonlPath, sessionId: 's1', endOffset: first.cursor!.offset });
    expect(stale.events).toEqual([]);
    expect(stale.hasMore).toBe(false);
    expect(stale.cursor).toBeNull();
  });

  it('tool_result carrier lines are not mistaken for turn boundaries', async () => {
    // A tool_result is written as a `user` line WITH a promptId; snapping a page
    // there would split a turn away from its tool call.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-test-'));
    jsonlPath = path.join(dir, 'session.jsonl');
    let body = '';
    for (let i = 0; i < PAGE_TURNS + 5; i++) {
      body += JSON.stringify({ type: 'user', uuid: `u-${i}`, promptId: `p-${i}`, isMeta: false, timestamp: new Date(1_700_000_000_000 + i).toISOString(), message: { role: 'user', content: `prompt ${i}` } }) + '\n';
      body += JSON.stringify({ type: 'assistant', uuid: `t-${i}`, timestamp: new Date(1_700_000_000_001 + i).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: `tu-${i}`, name: 'Read', input: { file_path: '/x' } }] } }) + '\n';
      body += JSON.stringify({ type: 'user', uuid: `r-${i}`, promptId: `p-${i}`, isMeta: false, timestamp: new Date(1_700_000_000_002 + i).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${i}`, content: 'ok' }] } }) + '\n';
      body += JSON.stringify({ type: 'assistant', uuid: `a-${i}`, timestamp: new Date(1_700_000_000_003 + i).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `reply ${i}` }] } }) + '\n';
    }
    fs.writeFileSync(jsonlPath, body);
    const page = await readTranscriptPage({ jsonlPath, sessionId: 's1', endOffset: null });
    // Exactly PAGE_TURNS prompts, and every one keeps its tool-use + tool-result.
    expect(page.events.filter((e) => e.type === 'user-message')).toHaveLength(PAGE_TURNS);
    expect(page.events.filter((e) => e.type === 'tool-use')).toHaveLength(PAGE_TURNS);
    expect(page.events.filter((e) => e.type === 'tool-result')).toHaveLength(PAGE_TURNS);
    expect(page.events[0].type).toBe('user-message');
  });

  // ---- Blocking-call batch B1 (2026-09-24): the page read is truly async ----

  it('reads a page without a single blocking fs call (it was async in name only)', async () => {
    jsonlPath = writeTranscript(PAGE_TURNS + 20);
    const sync = ['openSync', 'readSync', 'fstatSync', 'closeSync', 'readFileSync', 'existsSync', 'readdirSync']
      .map((name) => vi.spyOn(fsModule, name as any));
    // transcript-page imports `* as fs` — a snapshot of the builtin's exports.
    // Push the spies into it, or the check below would pass vacuously.
    syncBuiltinESMExports();
    try {
      const page = await readTranscriptPage({ jsonlPath, sessionId: 's1', endOffset: null, subagentsDir: path.join(path.dirname(jsonlPath), 'subagents') });
      expect(page.events.filter((e) => e.type === 'user-message')).toHaveLength(PAGE_TURNS);
      for (const spy of sync) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of sync) spy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('a large file (> 5 x PAGE_MAX_BYTES) pages back to byte 0: every turn exactly once, in order, never split', async () => {
    // Mixed turn sizes so page edges land on both the turn cap and the byte cap,
    // and multi-byte text so a range edge can fall inside a UTF-8 character.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-test-'));
    jsonlPath = path.join(dir, 'session.jsonl');
    const TURNS = 400;
    const chunks: string[] = [];
    for (let i = 0; i < TURNS; i++) {
      const pad = i % 7 === 0 ? 'é✓'.repeat(60 * 1024) : `reply ${i}`;
      chunks.push(JSON.stringify({ type: 'user', uuid: `u-${i}`, promptId: `p-${i}`, isMeta: false, timestamp: new Date(1_700_000_000_000 + i).toISOString(), message: { role: 'user', content: `prompt ${i}` } }) + '\n');
      chunks.push(JSON.stringify({ type: 'assistant', uuid: `a-${i}`, timestamp: new Date(1_700_000_000_001 + i).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: pad }] } }) + '\n');
    }
    fs.writeFileSync(jsonlPath, chunks.join(''));
    expect(fs.statSync(jsonlPath).size).toBeGreaterThan(5 * PAGE_MAX_BYTES);

    const pages: { prompts: string[]; replies: number; first: string }[] = [];
    let endOffset: number | null = null;
    for (let guard = 0; guard < 200; guard++) {
      const page = await readTranscriptPage({ jsonlPath, sessionId: 's1', endOffset });
      pages.unshift({
        prompts: page.events.filter((e) => e.type === 'user-message').map((e) => e.data.text as string),
        replies: page.events.filter((e) => e.type === 'assistant-text').length,
        first: page.events[0]?.type,
      });
      if (!page.hasMore) break;
      endOffset = page.cursor!.offset;
    }
    expect(pages.length).toBeGreaterThan(5);
    const all = pages.flatMap((p) => p.prompts);
    expect(all).toEqual(Array.from({ length: TURNS }, (_, i) => `prompt ${i}`));
    for (const p of pages) {
      expect(p.first).toBe('user-message');          // never starts mid-turn
      expect(p.replies).toBe(p.prompts.length);      // every turn whole
      expect(p.prompts.length).toBeLessThanOrEqual(PAGE_TURNS);
    }
    // The multi-byte replies survive intact (no U+FFFD from a torn character).
    const last = await readTranscriptPage({ jsonlPath, sessionId: 's1', endOffset: null });
    expect(last.events.some((e) => String(e.data.text ?? '').includes('\uFFFD'))).toBe(false);
  });

  // Moved from transcript-watcher.test.ts when TranscriptWatcher.getHistory
  // (the whole-transcript replay) was removed as dead — the page reader is now
  // the only replay, so it owns this rule.
  it('skips a repeated assistant-text for the same uuid (first write wins, mirrors live dedup)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-test-'));
    jsonlPath = path.join(dir, 'session.jsonl');
    const assistantLine = (text: string) => JSON.stringify({
      type: 'assistant', uuid: 'uuid-replay-dup',
      message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: null },
    });
    fs.writeFileSync(jsonlPath, assistantLine('grow') + '\n' + assistantLine('grow more') + '\n');
    const page = await readTranscriptPage({ jsonlPath, sessionId: 's1', endOffset: null });
    const texts = page.events.filter((e) => e.type === 'assistant-text');
    expect(texts).toHaveLength(1);
    expect(texts[0].data.text).toBe('grow');
  });
});
