// An automation's run on one of the app's own models: what the session is built with and what comes back.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { nativeEngine, toolNamesFor, wordAsk, type NativeEngineDeps } from '../src/main/automations/native-engine';
import type { EngineRun } from '../src/main/automations/automation-runner';
import type { StoredAutomation } from '../src/main/automations/automation-store';

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'native-engine-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });

const job = (over: Partial<StoredAutomation> = {}): StoredAutomation => ({
  id: 'one', name: 'One', instruction: 'do it', links: [], start: { kind: 'button', label: 'Run' }, model: 'GPT', subscription: false,
  runsOn: { runtime: 'native', providerId: 'openrouter', modelId: 'gpt-x' },
  tools: [{ id: 'send', kind: 'command', label: 'Mail', source: 'Your computer', mode: 'ask', exact: 'mail -s hi sam' }],
  whenAsk: 'wait', waitHours: 1, noAnswer: 'skip', late: 'run', overlap: 'skip-new',
  unlisted: { sites: 'never', commands: 'never' }, devices: [], notify: { needs: false, news: false, fails: false },
  enabled: true, ...over,
});

type Built = Parameters<NativeEngineDeps['createSession']>[0];

/** A session that plays a script: the test says what the "model" does when it is sent the first message. */
function fakeDeps(play: (built: Built, emit: (type: string, data: unknown) => void, sent: string) => Promise<void>) {
  const seen: { built?: Built; sent?: string; seeded?: unknown[]; interrupted: boolean; disposed: boolean } = { interrupted: false, disposed: false };
  const pageCalls: unknown[] = [];
  let pageToolsClosed = false;
  const deps: NativeEngineDeps = {
    pageDir: async (id) => (id === 'personal:money' ? path.join(root, 'Personal', 'Pages', 'money') : null),
    pageTools: async (roots) => ({
      tools: ['ListPages', 'ReadPageData', 'UpdatePageData'].map((name) => ({ name, inputSchema: {} })),
      call: async (tool, args) => { pageCalls.push([roots, tool, args]); return { text: 'data', isError: false }; },
      close: async () => { pageToolsClosed = true; },
    }),
    workDirFor: (id) => path.join(root, 'work', id),
    transcriptFor: (id, run) => path.join(root, 'runs', id, `${run}.jsonl`),
    createSession: async (built) => {
      seen.built = built;
      const bus = new EventEmitter();
      return {
        session: {
          seedHistory: (messages) => { seen.seeded = messages; },
          on: (ev, fn) => bus.on(ev, fn),
          interrupt: () => { seen.interrupted = true; },
          send: async (text) => { seen.sent = text; await play(built, (type, data) => bus.emit('transcript-event', { type, data }), text); },
        },
        dispose: async () => { seen.disposed = true; },
      };
    },
  };
  return { deps, seen, pageCalls, pageToolsClosed: () => pageToolsClosed };
}

const runOf = (j: StoredAutomation, over: Partial<EngineRun> = {}): EngineRun => ({
  runId: 'r1', job: j, instruction: j.instruction, current: () => j,
  ask: async () => ({ allow: true, note: '' }), spent: async () => true, ...over,
});

describe('native engine', () => {
  it('builds a session with the right model, rules and tools, and reads the ending', async () => {
    const { deps, seen } = fakeDeps(async (_b, emit) => {
      emit('assistant-text', { text: 'Working… ', partId: 'a' });
      emit('assistant-text', { text: 'All sent.\nSummary: Sent one email.\nTell them: yes', partId: 'b' });
    });
    const result = await nativeEngine(deps)(runOf(job())).done;
    expect(result).toEqual({ summary: 'Sent one email.', news: true });
    expect(seen.built).toMatchObject({ runId: 'r1', binding: { providerId: 'openrouter', modelId: 'gpt-x' }, workDir: path.join(root, 'work', 'one') });
    expect(seen.built!.systemPrompt).toContain('Run this command exactly as written: mail -s hi sam — the person is asked first');
    expect(seen.built!.toolNames).toContain('Bash');
    expect(seen.built!.toolNames).not.toContain('WebFetch');
    expect(seen.sent).toBe('do it');
    expect(seen.disposed).toBe(true);
    // The whole conversation is kept, one line per event.
    expect(readFileSync(path.join(root, 'runs', 'one', 'r1.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it("checks each step against the automation's own list and names the permission a question falls under", async () => {
    const asked: unknown[] = [];
    const { deps } = fakeDeps(async (built) => {
      expect((await built.decide('Bash', 'rm -rf ~')).action).toBe('deny');
      expect((await built.decide('Bash', 'mail -s hi sam')).action).toBe('ask');
      const answer = await built.askUser({ sessionId: 'r1', toolName: 'Bash', toolInput: { command: 'mail -s hi sam' }, denyListed: false });
      expect(answer).toEqual({ behavior: 'deny', message: 'Save a draft instead' });
    });
    await nativeEngine(deps)(runOf(job(), { ask: async (q) => { asked.push(q); return { allow: false, note: 'Save a draft instead' }; } })).done;
    expect(asked).toEqual([{ action: 'Run a command', detail: 'mail -s hi sam', toolId: 'send' }]);
  });

  it('reports what each step used', async () => {
    const spent: [number, number][] = [];
    const { deps } = fakeDeps(async (built) => { await built.onStepUsage({ tokens: 1200, costUsd: 0.02 }); await built.onStepUsage({ tokens: 300, costUsd: null }); });
    await nativeEngine(deps)(runOf(job(), { spent: async (d, t) => { spent.push([d, t]); return true; } })).done;
    expect(spent).toEqual([[0.02, 1200], [0, 300]]);
  });

  it('a model error ends the run with that reason', async () => {
    const { deps, seen } = fakeDeps(async (_b, emit) => { emit('session-error', { text: 'The model did not answer.' }); });
    await expect(nativeEngine(deps)(runOf(job())).done).rejects.toThrow('The model did not answer.');
    expect(seen.disposed).toBe(true);
  });

  it('an automation with no model chosen cannot run and says so', async () => {
    const { deps } = fakeDeps(async () => {});
    await expect(nativeEngine(deps)(runOf(job({ runsOn: undefined }))).done).rejects.toThrow('No model is chosen');
  });

  it('gives a run only the tools its permissions could ever use', () => {
    expect(toolNamesFor(job({ tools: [], unlisted: { sites: 'never', commands: 'never' } }))).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite']);
    expect(toolNamesFor(job({ tools: [], unlisted: { sites: 'ask', commands: 'never' } }))).toContain('WebFetch');
    expect(toolNamesFor(job({ tools: [], unlisted: { sites: 'never', commands: 'ask' } }))).toContain('Bash');
  });

  it('words a question for the person', () => {
    expect(wordAsk({ sessionId: 's', toolName: 'Write', toolInput: { file_path: '/a/b.txt' }, denyListed: false })).toEqual({ action: 'Write a file', detail: '/a/b.txt' });
    expect(wordAsk({ sessionId: 's', toolName: 'WebFetch', toolInput: { url: 'https://a.com/x' }, denyListed: false })).toEqual({ action: 'Visit a website', detail: 'https://a.com/x' });
  });

  /** A saved conversation: the instruction, one finished step, and one step the app closed in the middle of. */
  function saveCutOffRun() {
    const dir = path.join(root, 'runs', 'one');
    mkdirSync(dir, { recursive: true });
    const ev = (type: string, data: unknown, i: number) => JSON.stringify({ type, sessionId: 'r1', uuid: `u${i}`, timestamp: i, data });
    writeFileSync(path.join(dir, 'r1.jsonl'), [
      ev('user-message', { text: 'do it' }, 1),
      ev('tool-use', { toolUseId: 't1', toolName: 'Read', toolInput: { file_path: '/a/list.txt' } }, 2),
      ev('tool-result', { toolUseId: 't1', toolName: 'Read', toolResult: 'eggs', isError: false }, 3),
      ev('tool-use', { toolUseId: 't2', toolName: 'Bash', toolInput: { command: 'mail -s hi sam' } }, 4),
      '{"type":"tool-res', // the line being written when the app closed
    ].join('\n'));
  }

  it('a picked-up run continues from its saved conversation and asks before redoing the half-done step', async () => {
    saveCutOffRun();
    const asked: unknown[] = [];
    const { deps, seen } = fakeDeps(async (_b, emit) => { emit('assistant-text', { text: 'Summary: Finished the rest.', partId: 'z' }); });
    const result = await nativeEngine(deps)(runOf(job(), { resume: true, ask: async (q) => { asked.push(q); return { allow: false, note: '' }; } })).done;
    expect(result).toEqual({ summary: 'Finished the rest.', news: false });
    expect(asked).toEqual([{ action: 'Run a step again that may have already run', detail: 'Run a command: mail -s hi sam' }]);
    // The finished step is in what it remembers; the half-done one is not.
    expect(JSON.stringify(seen.seeded)).toContain('eggs');
    expect(JSON.stringify(seen.seeded)).not.toContain('mail -s hi sam');
    expect(seen.sent).toContain('Do not repeat steps that already finished.');
    expect(seen.sent).toContain('(Run a command: mail -s hi sam) may or may not have finished. Do not run it again');
  });

  it('a picked-up run with nothing saved starts over and says so', async () => {
    const { deps, seen } = fakeDeps(async (_b, emit) => { emit('assistant-text', { text: 'Summary: Did it all.', partId: 'z' }); });
    const result = await nativeEngine(deps)(runOf(job(), { resume: true })).done;
    expect(result).toEqual({ summary: 'Did it all.', news: false, startedOver: true });
    expect(seen.seeded).toBeUndefined();
    expect(seen.sent).toBe('do it');
    expect(existsSync(path.join(root, 'runs', 'one', 'r1.jsonl'))).toBe(true);
  });

  it('gives a run the page tools for its linked pages only, and refuses any other page', async () => {
    const linked = job({
      links: [{ kind: 'page', id: 'personal:money', name: 'Money' }, { kind: 'page', id: 'personal:gone', name: 'Gone' }],
      tools: [{ id: 'r', kind: 'page-read', label: 'Read', source: 'This page', mode: 'allow' }],
    });
    const f = fakeDeps(async (built) => {
      const server = built.mcpServers![0];
      // ListPages would name the person's other pages: it is not offered.
      expect(server.tools.map((t) => t.name)).toEqual(['ReadPageData', 'UpdatePageData']);
      expect(await server.call('ReadPageData', { page: 'money' }, new AbortController().signal)).toEqual({ text: 'data', isError: false });
      expect((await server.call('ReadPageData', { page: 'budget' }, new AbortController().signal)).isError).toBe(true);
      // Reading is allowed by its permission; changing is not.
      expect((await built.decide('mcp__youcoded-pages__ReadPageData', undefined)).action).toBe('allow');
      expect((await built.decide('mcp__youcoded-pages__UpdatePageData', undefined)).action).toBe('deny');
      expect(built.systemPrompt).toContain('- Money: page "money"');
      expect(built.systemPrompt).not.toContain('Gone');
    });
    await nativeEngine(f.deps)(runOf(linked)).done;
    expect(f.pageCalls).toEqual([[[path.join(root, 'Personal', 'Pages')], 'ReadPageData', { page: 'money' }]]);
    expect(f.pageToolsClosed()).toBe(true);
  });

  it('an automation with no page permission gets no page tools at all', async () => {
    const f = fakeDeps(async (built) => { expect(built.mcpServers).toBeUndefined(); });
    await nativeEngine(f.deps)(runOf(job({ links: [{ kind: 'page', id: 'personal:money', name: 'Money' }] }))).done;
  });
});
