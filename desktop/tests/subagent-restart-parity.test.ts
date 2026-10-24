import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SubagentIndex } from '../src/main/subagent-index';
import { SubagentWatcher } from '../src/main/subagent-watcher';
import { readTranscriptPage } from '../src/main/transcript-page';
import { looseData, type TranscriptEvent } from '../src/shared/types';

// WHY this file (2026-10-22 freeze hunt, item 1): start() no longer replays helper transcripts that already
// exist (commits 861371dab, bf5e9c27a). The claim to prove is that after a restart/resume the chat shows the
// same helper cards and progress as before. `replayExisting: true` is the old (master) behaviour, so each case
// runs both modes against the PRODUCTION-shaped setup: the live index is EMPTY at start, because the parent
// transcript tailer starts at its end and so never re-records pre-restart Agent tool_uses (transcript-watcher
// startWatching). Without a bound parent a replayed line is only buffered, never emitted.

const SETTLE_MS = 5_000;
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function userLine(i: number) {
  return JSON.stringify({ type: 'user', uuid: `u-${i}`, promptId: `p-${i}`, isMeta: false,
    timestamp: new Date(1_700_000_000_000 + i).toISOString(), message: { role: 'user', content: `prompt ${i}` } });
}
function agentCallLine(i: number, toolUseId: string, description: string) {
  return JSON.stringify({ type: 'assistant', uuid: `a-${i}`, timestamp: new Date(1_700_000_000_001 + i).toISOString(),
    message: { role: 'assistant', stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: toolUseId, name: 'Agent', input: { description, subagent_type: 'Explore' } }] } });
}
function helperLine(uuid: string, toolUseId: string, p: string) {
  return JSON.stringify({ type: 'assistant', uuid, isSidechain: true,
    message: { role: 'assistant', stop_reason: null, content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: p } }] } });
}

describe('helper cards after a restart: skipping the start-up replay changes nothing the user sees', () => {
  let tmp: string;
  let watcher: SubagentWatcher | null = null;
  afterEach(() => { watcher?.stop(); watcher = null; if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  function setup(opts: { turns: number; agentTurn: number }) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-restart-'));
    const jsonlPath = path.join(tmp, 'session.jsonl');
    const subagentsDir = path.join(tmp, 'session', 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    let body = '';
    for (let i = 0; i < opts.turns; i++) {
      body += userLine(i) + '\n';
      if (i === opts.agentTurn) body += agentCallLine(i, 'toolu_PARENT', 'Find bug') + '\n';
    }
    fs.writeFileSync(jsonlPath, body);
    fs.writeFileSync(path.join(subagentsDir, 'agent-h1.meta.json'),
      JSON.stringify({ description: 'Find bug', agentType: 'Explore', toolUseId: 'toolu_PARENT' }));
    const helperPath = path.join(subagentsDir, 'agent-h1.jsonl');
    fs.writeFileSync(helperPath, helperLine('h-1', 'toolu_H1', '/one') + '\n' + helperLine('h-2', 'toolu_H2', '/two') + '\n');
    return { jsonlPath, subagentsDir, helperPath };
  }

  async function resume(subagentsDir: string, replayExisting: boolean) {
    const emitted: TranscriptEvent[] = [];
    watcher = new SubagentWatcher({ sessionId: 's', subagentsDir, index: new SubagentIndex(), emit: (e) => emitted.push(e), replayExisting });
    watcher.start();
    await vi.waitFor(() => expect(watcher!.trackedCount()).toBe(1), { timeout: SETTLE_MS });
    await wait(300); // let any replayed read finish — a negative assertion needs a settle wait
    return emitted;
  }

  it.each([true, false])('(a) a helper that finished before the restart: parent on the first page -> card and progress come from history either way (replayExisting=%s)', async (replayExisting) => {
    const { jsonlPath, subagentsDir } = setup({ turns: 5, agentTurn: 3 });
    const live = await resume(subagentsDir, replayExisting);
    expect(live).toHaveLength(0); // master emitted nothing live either: no bound parent in the live index
    const page = await readTranscriptPage({ jsonlPath, sessionId: 's', endOffset: null, subagentsDir });
    const helperEvents = page.events.filter((e) => looseData(e).parentAgentToolUseId === 'toolu_PARENT');
    expect(helperEvents.map((e) => looseData(e).toolUseId)).toEqual(['toolu_H1', 'toolu_H2']);
  });

  it.each([true, false])('(c) a helper older than the first page: not on the first page, delivered when the user scrolls up (replayExisting=%s)', async (replayExisting) => {
    const { jsonlPath, subagentsDir } = setup({ turns: 80, agentTurn: 2 });
    const live = await resume(subagentsDir, replayExisting);
    expect(live).toHaveLength(0);
    const first = await readTranscriptPage({ jsonlPath, sessionId: 's', endOffset: null, subagentsDir });
    expect(first.hasMore).toBe(true);
    expect(first.events.some((e) => looseData(e).parentAgentToolUseId === 'toolu_PARENT')).toBe(false); // same on master: getHistory skips unbindable parents
    let page = first; let found: string[] = [];
    while (page.hasMore && page.cursor && !found.length) {
      page = await readTranscriptPage({ jsonlPath, sessionId: 's', endOffset: page.cursor.offset, subagentsDir });
      found = page.events.filter((e) => looseData(e).parentAgentToolUseId === 'toolu_PARENT').map((e) => String(looseData(e).toolUseId));
    }
    expect(found).toEqual(['toolu_H1', 'toolu_H2']);
  });

  it.each([true, false])('(b) a helper still running across the restart: a line written after the restart behaves identically in both modes (replayExisting=%s)', async (replayExisting) => {
    const { subagentsDir, helperPath } = setup({ turns: 5, agentTurn: 3 });
    const live = await resume(subagentsDir, replayExisting);
    fs.appendFileSync(helperPath, helperLine('h-3', 'toolu_H3', '/three') + '\n');
    await wait(1500);
    // Pre-existing behaviour, identical before and after the change: the live index never learns the
    // pre-restart parent, so the new line is held back (not emitted) in BOTH modes. Pinned so a later
    // change to that is a deliberate one.
    expect(live.map((e) => looseData(e).toolUseId)).toEqual([]);
  });

  it('(b) when the parent IS known live, the new lines stream, and pre-existing lines are not re-sent', async () => {
    const { subagentsDir, helperPath } = setup({ turns: 5, agentTurn: 3 });
    const emitted: TranscriptEvent[] = [];
    const index = new SubagentIndex();
    watcher = new SubagentWatcher({ sessionId: 's', subagentsDir, index, emit: (e) => emitted.push(e) });
    watcher.start();
    await vi.waitFor(() => expect(watcher!.trackedCount()).toBe(1), { timeout: SETTLE_MS });
    index.recordParentAgentToolUse('toolu_PARENT', 'Find bug', 'Explore');
    index.bindSubagent('h1', { description: 'Find bug', agentType: 'Explore', toolUseId: 'toolu_PARENT' });
    fs.appendFileSync(helperPath, helperLine('h-3', 'toolu_H3', '/three') + '\n');
    await vi.waitFor(() => expect(emitted.map((e) => looseData(e).toolUseId)).toEqual(['toolu_H3']), { timeout: 15_000 });
  });
});
