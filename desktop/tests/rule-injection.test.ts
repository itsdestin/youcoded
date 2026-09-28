// Injecting path-triggered content into a turn.
//
// TWO invariants this pins, both of which the rest of the branch depends on:
//
// 1. It arrives as a MESSAGE. The system prompt is byte-stable by construction
//    (prompt-assembly.ts's header comment is a standing instruction), and a
//    mid-session edit discards the KV cache prefix every local model reuses —
//    turning a cheap turn into a full re-prefill of the whole conversation.
//
// 2. Once per trigger per SESSION. A rule re-sent after every Read of a matching
//    file would dominate the conversation and blow the window it was sized against.
import { describe, it, expect } from 'vitest';
import { HarnessSession } from '../src/main/harness/harness-session';
import type { TranscriptEvent } from '../src/shared/types';
import type { PermissionDecision } from '../src/shared/permission-types';
import type { TriggerIndex, PathTrigger } from '../src/main/harness/injection/path-triggers';
import { textChunks, toolCallChunk, finishChunk, stream, scriptedModel } from './helpers/scripted-model';
import { makeOpts, fakeTool } from './helpers/harness-fakes';
import { CLOUD_DEFAULT } from '../src/main/harness/capability-profile';
import { buildTriggerIndex } from '../src/main/harness/injection/path-triggers';
import { rebuildHistoryWithOrigins } from '../src/main/harness/history-rebuild';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const ALLOW: PermissionDecision = { action: 'allow', denyListed: false };

/** A fake index that fires for every path — the point is what the DRIVER does
 *  with a hit, which path-triggers.test.ts already covers on its own. */
function always(...triggers: PathTrigger[]): TriggerIndex {
  return { match: () => triggers };
}
const never: TriggerIndex = { match: () => [] };

function run(triggers: TriggerIndex, scripts: any[][], profileOver: Partial<typeof CLOUD_DEFAULT> = {}) {
  const seen: any[] = [];
  const read = fakeTool('Read', { permissionSubject: (a: any) => a.file_path });
  const model = scriptedModel(scripts, seen);
  const session = new HarnessSession(
    makeOpts({ tools: [read], decide: async () => ALLOW, triggers, profile: { ...CLOUD_DEFAULT, ...profileOver } }),
    async () => model as any,
  );
  const events: TranscriptEvent[] = [];
  session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
  return { session, seen, events };
}

const TWO_STEP = [
  stream(...textChunks('a', 'reading'), toolCallChunk('c1', 'Read', { file_path: 'src/api/a.ts' }), finishChunk('tool-calls')),
  stream(...textChunks('b', 'done'), finishChunk('stop')),
];

describe('pre-write guidance boundary', () => {
  it.each(['Write', 'Edit'])('does not execute an already-issued %s before the model replans', async (name) => {
    const file = path.join(process.cwd(), 'src/api/a.ts');
    const tool = fakeTool(name, { permissionSubject: (a: any) => a.file_path });
    const seen: any[] = [];
    const model = scriptedModel([
      stream(toolCallChunk('old', name, { file_path: file }), finishChunk('tool-calls')),
      stream(...textChunks('new', 'reconsidered'), toolCallChunk('new', name, { file_path: file }), finishChunk('tool-calls')),
      stream(...textChunks('end', 'done'), finishChunk('stop')),
    ], seen);
    const events: TranscriptEvent[] = [];
    const session = new HarnessSession(makeOpts({ cwd: process.cwd(), tools: [tool], decide: async () => ALLOW,
      triggers: always({ id: 'rule:write', source: 'rules/write.md', body: 'CHANGE_WRITING_BEHAVIOR' }) }), async () => model as any);
    session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
    const original = (session as any).systemText;
    await session.send('write');
    expect((tool as any).calls).toHaveLength(1);
    expect(JSON.stringify(seen[1])).toContain('CHANGE_WRITING_BEHAVIOR');
    expect((session as any).systemText).toBe(original);
    expect(events.filter(e => e.type === 'tool-result')).toHaveLength(2);
    expect(JSON.stringify(events.filter(e => e.type === 'tool-result')[0])).toContain('Not run');
    expect((session as any).history.filter((m: any) => m.role === 'tool')).toHaveLength(2);
  });

  it('a retained bounded rule body avoids another pre-write replan on resume', async () => {
    const { fitRuleGroup } = await import('../src/main/harness/injection/fit-rule-group');
    const { markAppGenerated } = await import('../src/main/harness/compaction');
    const rule = { id: 'r', source: 'rules/r.md', body: 'LONG-RULE '.repeat(400) };
    const content = fitRuleGroup([rule], 200)[0];
    const write = fakeTool('Write', { permissionSubject: (a: any) => a.file_path });
    const seen: any[] = [];
    const model = scriptedModel([stream(toolCallChunk('w', 'Write', { file_path: path.join(process.cwd(), 'a.ts') }), finishChunk('tool-calls')),
      stream(...textChunks('end', 'ok'), finishChunk('stop'))], seen);
    const session = new HarnessSession(makeOpts({ cwd: process.cwd(), tools: [write], decide: async () => ALLOW,
      triggers: always(rule), profile: { ...CLOUD_DEFAULT, injectionBudgetTokens: 200 } }), async () => model as any);
    session.seedHistory([markAppGenerated({ role: 'user', content } as any)] as any);
    await session.send('go');
    expect((write as any).calls).toHaveLength(1);
    expect(seen).toHaveLength(2);
  });

  it('a Write without new rules follows the normal fast path', async () => {
    const write = fakeTool('Write', { permissionSubject: (a: any) => a.file_path });
    const seen: any[] = [];
    const model = scriptedModel([stream(toolCallChunk('w', 'Write', { file_path: path.join(process.cwd(), 'a.ts') }), finishChunk('tool-calls')),
      stream(...textChunks('end', 'ok'), finishChunk('stop'))], seen);
    const session = new HarnessSession(makeOpts({ cwd: process.cwd(), tools: [write], decide: async () => ALLOW,
      triggers: never }), async () => model as any);
    await session.send('go');
    expect((write as any).calls).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toContain('Not run');
  });

  it('a refused re-issued write remains refused: guidance is not approval', async () => {
    const file = path.join(process.cwd(), 'a.ts');
    const write = fakeTool('Write', { permissionSubject: (a: any) => a.file_path });
    let decisions = 0; const seen: any[] = [];
    const model = scriptedModel([stream(toolCallChunk('old', 'Write', { file_path: file }), finishChunk('tool-calls')),
      stream(toolCallChunk('new', 'Write', { file_path: file }), finishChunk('tool-calls')),
      stream(...textChunks('end', 'ok'), finishChunk('stop'))], seen);
    const session = new HarnessSession(makeOpts({ cwd: process.cwd(), tools: [write],
      triggers: always({ id: 'r', source: 'r.md', body: 'STOP_AND_CHECK' }),
      decide: async () => { decisions++; return { action: 'deny', denyListed: false }; } }), async () => model as any);
    await session.send('go');
    expect(JSON.stringify(seen[1])).toContain('STOP_AND_CHECK');
    expect((write as any).calls).toHaveLength(0);
    expect(decisions).toBe(1);
  });

  it('invalid Write arguments remain an argument error, not a replan', async () => {
    const write = fakeTool('Write', { permissionSubject: (a: any) => a.file_path });
    const seen: any[] = []; const events: TranscriptEvent[] = [];
    const model = scriptedModel([stream(toolCallChunk('bad', 'Write', { wrong_path: 'a.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('end', 'ok'), finishChunk('stop'))], seen);
    const session = new HarnessSession(makeOpts({ tools: [write], triggers: always({ id: 'r', source: 'r.md', body: 'SHOULD_NOT_REPLAN' }), decide: async () => ALLOW }), async () => model as any);
    session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
    await session.send('go');
    expect(JSON.stringify(seen)).not.toContain('SHOULD_NOT_REPLAN');
    expect(JSON.stringify(events.filter(e => e.type === 'tool-result'))).toContain('file_path');
    expect((write as any).calls).toHaveLength(0);
  });

  it('does not mark a fitted notice-only body as delivered guidance', async () => {
    const { fitRuleGroupDelivery } = await import('../src/main/harness/injection/fit-rule-group');
    const rule = { id: 'r', source: 'rules/r.md', body: 'ACTUAL_RULE '.repeat(400) };
    const shapes = Array.from({ length: 90 }, (_, i) => fitRuleGroupDelivery([rule], i + 1));
    const noticeOnly = shapes.filter(s => s.contents[0]?.includes('<project-rule source=')
      && /<project-rule source="[^"]*">\n\s*\[(?:\.\.\.truncated|Read rules\/r.md: rule shortened or omitted)/.test(s.contents[0]));
    expect(noticeOnly.length).toBeGreaterThan(0);
    expect(noticeOnly.every(s => s.omitted.includes(rule.id))).toBe(true);
  });

  it.each(['Write', 'Edit'])('shows rules that cannot fit once, shortened, then lets the reissued %s run', async (name) => {
    // A small model in a rule-heavy project must still be able to edit: it is
    // told which rules apply (and where to read them) once, then decides again.
    const tool = fakeTool(name, { permissionSubject: (a: any) => a.file_path });
    const seen: any[] = []; const events: TranscriptEvent[] = [];
    const file = path.join(process.cwd(), 'a.ts');
    const scripts = [stream(toolCallChunk('first', name, { file_path: file }), finishChunk('tool-calls')),
      stream(toolCallChunk('retry', name, { file_path: file }), finishChunk('tool-calls')),
      stream(...textChunks('end', 'done'), finishChunk('stop'))];
    const model = scriptedModel(scripts, seen);
    const rules = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, source: `rules/long-source-${i}.md`, body: `RULE_BODY_${i} ` + 'x'.repeat(1000) }));
    const session = new HarnessSession(makeOpts({ cwd: process.cwd(), tools: [tool], triggers: always(...rules), decide: async () => ALLOW,
      profile: { ...CLOUD_DEFAULT, injectionBudgetTokens: 20 } }), async () => model as any);
    session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
    await session.send('first');
    expect((tool as any).calls).toHaveLength(1);
    expect(seen).toHaveLength(3);
    const results = events.filter(e => e.type === 'tool-result');
    expect(results[0].data.toolResult).toMatch(/Not run: newly applicable project instructions/);
    expect(JSON.stringify(seen[1])).toMatch(/omitted|shortened|truncated/i);
    expect(events.find(e => e.type === 'turn-complete')!.data.stopReason).toBe('end_turn');
  });

  it('a rule stop inside a batch keeps the earlier Write and pauses the rest for one replan', async () => {
    const write = fakeTool('Write', { permissionSubject: (a: any) => a.file_path });
    const seen: any[] = []; const events: TranscriptEvent[] = [];
    const first = path.join(process.cwd(), 'first.ts');
    const blocked = path.join(process.cwd(), 'blocked.ts');
    const later = path.join(process.cwd(), 'later.ts');
    const scripts = [stream(
      toolCallChunk('first', 'Write', { file_path: first }),
      toolCallChunk('blocked', 'Write', { file_path: blocked }),
      toolCallChunk('later', 'Write', { file_path: later }), finishChunk('tool-calls')),
      stream(...textChunks('end', 'replanned'), finishChunk('stop'))];
    const model = scriptedModel(scripts, seen);
    const rules = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, source: `rules/long-source-${i}.md`, body: 'x'.repeat(1000) }));
    const session = new HarnessSession(makeOpts({ cwd: process.cwd(), tools: [write], decide: async () => ALLOW,
      triggers: { match: p => p === blocked ? rules : [] },
      profile: { ...CLOUD_DEFAULT, injectionBudgetTokens: 20 } }), async () => model as any);
    session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
    await session.send('go');
    expect((write as any).calls.map((c: any) => c.file_path)).toEqual([first]);
    const results = events.filter(e => e.type === 'tool-result');
    expect(results).toHaveLength(3);
    expect(results[0].data.toolResult).toContain('Write ran');
    expect(results[1].data.toolResult).toMatch(/Not run: newly applicable project instructions/);
    expect(results[2].data.toolResult).toMatch(/Not run/);
    expect((session as any).history.filter((m: any) => m.role === 'tool')).toHaveLength(1);
    expect(seen).toHaveLength(2);
  });

  it('a post-Read notice without any body does not unlock a following Write', async () => {
    const read = fakeTool('Read', { permissionSubject: (a: any) => a.file_path });
    const write = fakeTool('Write', { permissionSubject: (a: any) => a.file_path });
    const seen: any[] = []; const events: TranscriptEvent[] = [];
    const model = scriptedModel([
      stream(toolCallChunk('r', 'Read', { file_path: 'a.ts' }), finishChunk('tool-calls')),
      stream(toolCallChunk('w', 'Write', { file_path: 'a.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('end', 'done'), finishChunk('stop')),
    ], seen);
    const session = new HarnessSession(makeOpts({ tools: [read, write], decide: async () => ALLOW,
      triggers: always({ id: 'r', source: 'rules/r.md', body: 'IMPORTANT_BODY '.repeat(200) }),
      profile: { ...CLOUD_DEFAULT, injectionBudgetTokens: 10 } }), async () => model as any);
    session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
    await session.send('go');
    expect(JSON.stringify(seen[1])).toContain('truncated');
    // The Read's notice alone does not skip the pre-write stop: the Write is
    // paused once for a replan, and the scripted model then ends the turn.
    expect((write as any).calls).toHaveLength(0);
    expect(JSON.stringify(events.filter(e => e.type === 'tool-result'))).toMatch(/Not run: newly applicable project instructions/);
    expect(seen).toHaveLength(3);
  });

  it('fits multiple new rules as one source-labelled group and does not replan a partial twice', async () => {
    const write = fakeTool('Write', { permissionSubject: (a: any) => a.file_path });
    const seen: any[] = [];
    const model = scriptedModel([stream(toolCallChunk('old', 'Write', { file_path: 'a.ts' }), finishChunk('tool-calls')),
      stream(toolCallChunk('new', 'Write', { file_path: 'a.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('end', 'ok'), finishChunk('stop'))], seen);
    const rules = [{ id: 'r1', source: 'first.md', body: 'A'.repeat(2000) },
      { id: 'r2', source: 'second.md', body: 'B'.repeat(2000) }];
    const session = new HarnessSession(makeOpts({ tools: [write], triggers: always(...rules), decide: async () => ALLOW,
      profile: { ...CLOUD_DEFAULT, injectionBudgetTokens: 200 } }), async () => model as any);
    await session.send('go');
    const messages = ((session as any).history as any[]).filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('project-rule'));
    expect(messages.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(800);
    expect(JSON.stringify(messages)).toContain('first.md');
    expect(JSON.stringify(messages)).toContain('second.md');
    expect(JSON.stringify(messages)).toMatch(/truncated|shortened|omitted/);
    expect(seen).toHaveLength(3);
  });

  it('includes a ready human correction and guidance in the next request, not the old write', async () => {
    const write = fakeTool('Write', { permissionSubject: (a: any) => a.file_path });
    const seen: any[] = []; let ready = false; let delivered = false;
    const model = scriptedModel([stream(toolCallChunk('old', 'Write', { file_path: 'a.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('end', 'no write'), finishChunk('stop'))], seen);
    const session = new HarnessSession(makeOpts({ tools: [write], decide: async () => ALLOW,
      triggers: always({ id: 'r', source: 'r.md', body: 'HUMAN_AND_RULE' }),
      takeReadyBusyMessage: () => {
        if (!ready || delivered) return undefined;
        delivered = true;
        return { id: 'u', text: 'Change the target', attachments: [] };
      } }), async () => model as any);
    session.on('transcript-event', (e: TranscriptEvent) => {
      if (e.type === 'tool-result' && JSON.stringify(e).includes('Not run')) ready = true;
    });
    await session.send('go');
    expect((write as any).calls).toHaveLength(0);
    expect(JSON.stringify(seen[1])).toContain('HUMAN_AND_RULE');
    expect(JSON.stringify(seen[1])).toContain('Change the target');
  });

  it('an interrupt during deferral leaves the first write unexecuted and every call paired', async () => {
    const write = fakeTool('Write', { permissionSubject: (a: any) => a.file_path });
    const events: TranscriptEvent[] = []; const seen: any[] = [];
    const model = scriptedModel([stream(toolCallChunk('old', 'Write', { file_path: 'a.ts' }),
      toolCallChunk('sibling', 'Write', { file_path: 'b.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('unexpected', 'should not execute'), finishChunk('stop'))], seen);
    const session = new HarnessSession(makeOpts({ tools: [write], decide: async () => ALLOW,
      triggers: always({ id: 'r', source: 'r.md', body: 'RECONSIDER' }) }), async () => model as any);
    session.on('transcript-event', (e: TranscriptEvent) => {
      events.push(e);
      if (e.type === 'tool-result' && JSON.stringify(e).includes('Not run')) session.interrupt();
    });
    await session.send('go');
    expect((write as any).calls).toHaveLength(0);
    expect(events.filter(e => e.type === 'tool-result')).toHaveLength(2);
    expect(events.some(e => e.type === 'user-interrupt')).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('keeps an earlier Read result and pairs unstarted Write siblings before guidance', async () => {
    const read = fakeTool('Read', { permissionSubject: (a: any) => a.file_path });
    const write = fakeTool('Write', { permissionSubject: (a: any) => a.file_path });
    const seen: any[] = []; const events: TranscriptEvent[] = [];
    const model = scriptedModel([stream(toolCallChunk('r', 'Read', { file_path: 'other.ts' }),
      toolCallChunk('w', 'Write', { file_path: 'a.ts' }), toolCallChunk('s', 'Write', { file_path: 'b.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('end', 'no write'), finishChunk('stop'))], seen);
    const session = new HarnessSession(makeOpts({ tools: [read, write], decide: async () => ALLOW,
      triggers: { match: p => p === 'a.ts' ? [{ id: 'r', source: 'r.md', body: 'BEFORE_WRITE' }] : [] } }), async () => model as any);
    session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
    await session.send('go');
    expect((read as any).calls).toHaveLength(1);
    expect((write as any).calls).toHaveLength(0);
    expect(JSON.stringify(seen[1])).toContain('BEFORE_WRITE');
    const results = events.filter(e => e.type === 'tool-result');
    expect(results).toHaveLength(3);
    expect(JSON.stringify(results[0])).toContain('Read ran');
    expect(JSON.stringify(results.slice(1))).toContain('Not run');
    expect((session as any).history.filter((m: any) => m.role === 'tool')).toHaveLength(1);
    const rebuilt = rebuildHistoryWithOrigins(events);
    const live = (session as any).history as any[];
    expect(rebuilt.messages).toEqual(live.filter(m => !(m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('<project-rule'))));
    const accepted = session.acceptedHistory();
    expect(accepted.messages).toEqual(live);
    const resultsInHistory = accepted.eventUuids.filter(u => events.some(e => e.uuid === u && e.type === 'tool-result'));
    expect(resultsInHistory).toHaveLength(3);
  });
});

describe('path-triggered injection', () => {
  it('passes inherited owner-relative rules to a narrowed session on the next read', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yc-rules-owner-'));
    try {
      await fs.mkdir(path.join(root, '.git'));
      const owner = path.join(root, 'pkg');
      const cwd = path.join(owner, 'child');
      await fs.mkdir(path.join(root, '.claude', 'rules'), { recursive: true });
      await fs.mkdir(path.join(owner, '.claude', 'rules'), { recursive: true });
      await fs.mkdir(path.join(cwd, 'src'), { recursive: true });
      await fs.writeFile(path.join(root, '.claude', 'rules', 'root.md'), '---\npaths:\n  - "**/src/**"\n---\nROOT_RULE');
      await fs.writeFile(path.join(owner, '.claude', 'rules', 'child.md'), '---\npaths:\n  - "child/src/**"\n---\nOWNER_RULE');
      const file = path.join(cwd, 'src', 'a.ts');
      const scripts = [stream(toolCallChunk('c1', 'Read', { file_path: file }), finishChunk('tool-calls')),
        stream(...textChunks('answer', 'done'), finishChunk('stop'))];
      const seen: any[] = [];
      const model = scriptedModel(scripts, seen);
      const session = new HarnessSession(makeOpts({ cwd, tools: [fakeTool('Read', { permissionSubject: (a: any) => a.file_path })],
        decide: async () => ALLOW, triggers: await buildTriggerIndex(cwd) }), async () => model as any);
      await session.send('read');
      const prompt = JSON.stringify(seen[1]);
      expect(prompt.indexOf('ROOT_RULE')).toBeGreaterThanOrEqual(0);
      expect(prompt.indexOf('OWNER_RULE')).toBeGreaterThan(prompt.indexOf('ROOT_RULE'));
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10 });
    }
  });
  it('a matched trigger reaches the model as a MESSAGE', async () => {
    const { session, seen } = run(always({ id: 'r1', source: '.claude/rules/api.md', body: 'Always validate input.' }), TWO_STEP);
    await session.send('go');
    expect(JSON.stringify(seen)).toContain('Always validate input');
  });

  it('the system prompt is NOT touched — byte-stability is the whole constraint', async () => {
    const { session } = run(always({ id: 'r1', source: 'r', body: 'RULE' }), TWO_STEP);
    const before = (session as any).systemText;
    await session.send('go');
    expect((session as any).systemText).toBe(before);
  });

  it('names its source so the model knows where the text came from', async () => {
    const { session, seen } = run(always({ id: 'r1', source: '.claude/rules/api.md', body: 'RULE' }), TWO_STEP);
    await session.send('go');
    expect(JSON.stringify(seen)).toContain('.claude/rules/api.md');
  });

  it('the same trigger is injected only ONCE per session', async () => {
    const threeStep = [
      stream(toolCallChunk('c1', 'Read', { file_path: 'src/api/a.ts' }), finishChunk('tool-calls')),
      stream(toolCallChunk('c2', 'Read', { file_path: 'src/api/b.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'done'), finishChunk('stop')),
    ];
    const { session, seen } = run(always({ id: 'r1', source: 'r', body: 'RULE-TEXT-MARKER' }), threeStep);
    await session.send('go');
    // Count in the FINAL prompt, not across all of them: once appended to
    // history the message correctly appears in every later step's prompt, so
    // summing across steps measures step count, not injection count.
    const lastPrompt = JSON.stringify(seen[seen.length - 1]);
    expect(lastPrompt.split('RULE-TEXT-MARKER').length - 1).toBe(1);
  });

  it('reinjects a rule after clear, but not on another ordinary turn', async () => {
    const rule = { id: 'rule:one', source: '.claude/rules/one.md', body: 'RULE-AFTER-CLEAR' };
    const scripts = Array.from({ length: 6 }, (_, i) => i % 2 === 0
      ? stream(toolCallChunk(`c${i}`, 'Read', { file_path: 'a.ts' }), finishChunk('tool-calls'))
      : stream(...textChunks(`t${i}`, 'done'), finishChunk('stop')));
    const { session, seen } = run(always(rule), scripts);
    await session.send('first');
    await session.send('second');
    expect(JSON.stringify(seen[3]).split(rule.body)).toHaveLength(2);
    expect(session.clearHistory()).toEqual({ ok: true });
    await session.send('third');
    expect(JSON.stringify(seen[5]).split(rule.body)).toHaveLength(2);
    expect(JSON.stringify(seen[4])).not.toContain(rule.body);
  });

  it('stays injected-once across TURNS, not just steps', async () => {
    const perTurn = [
      stream(toolCallChunk('c1', 'Read', { file_path: 'a.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'done'), finishChunk('stop')),
      stream(toolCallChunk('c2', 'Read', { file_path: 'b.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('c', 'done'), finishChunk('stop')),
    ];
    const { session, seen } = run(always({ id: 'r1', source: 'r', body: 'RULE-TEXT-MARKER' }), perTurn);
    await session.send('one');
    await session.send('two');
    const lastPrompt = JSON.stringify(seen[seen.length - 1]);
    expect(lastPrompt.split('RULE-TEXT-MARKER').length - 1).toBe(1);
  });

  it.each([true, false])('seeded %s source-labelled rule controls repeat delivery', async (retained) => {
    const rule = { id: 'rule:/project/a.md', source: '.claude/rules/a.md', body: 'RESTORED-RULE' };
    const { session, seen } = run(always(rule), TWO_STEP);
    const text = `<project-rule source="${rule.source}">\n${rule.body}\n</project-rule>`;
    const { markAppGenerated } = await import('../src/main/harness/compaction');
    session.seedHistory([{ role: 'user', content: 'earlier' },
      ...(retained ? [markAppGenerated({ role: 'user', content: text } as any)] : [{ role: 'user', content: text }])] as any);
    await session.send('touch file');
    expect(JSON.stringify(seen.at(-1)).split(rule.body).length - 1).toBe(retained ? 1 : 2);
  });

  it.each(['retired', 'retained', 'failed'] as const)('manual summary %s rule keeps loaded state truthful', async (outcome) => {
    const rule = { id: 'rule:/project/r.md', source: 'rules/r.md', body: 'MANUAL-RULE-MARKER' };
    const { markAppGenerated } = await import('../src/main/harness/compaction');
    const ruleMessage = () => markAppGenerated({ role: 'user', content: `<project-rule source="${rule.source}">\n${rule.body}\n</project-rule>` } as any);
    const scripts = [stream(...textChunks('summary', outcome === 'failed' ? ' ' : `Summary mentions ${rule.body}`), finishChunk('stop')),
      stream(toolCallChunk('c1', 'Read', { file_path: 'a.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('reply', 'done'), finishChunk('stop'))];
    const { session, seen } = run(always(rule), scripts);
    session.seedHistory([{ role: 'user', content: 'old turn' }, ruleMessage(), { role: 'assistant', content: 'ack' },
      { role: 'user', content: 'recent turn' }, { role: 'assistant', content: 'ack' },
      ...(outcome === 'retained' ? [ruleMessage()] : []), { role: 'user', content: 'latest turn' }] as any);
    const result = await session.compactNow();
    expect(result.ok).toBe(outcome !== 'failed');
    await session.send('touch a.ts');
    const history = (session as any).history as any[];
    expect(history.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('<project-rule source='))).toHaveLength(1);
    expect(JSON.stringify(seen.at(-1))).toContain(rule.body);
  });

  it('does not mistake a stale same-source rule body for the currently loaded guidance', async () => {
    const rule = { id: 'rule:/project/a.md', source: 'rules/a.md', body: 'CURRENT-RULE' };
    const { session, seen } = run(always(rule), TWO_STEP);
    const { markAppGenerated } = await import('../src/main/harness/compaction');
    session.seedHistory([markAppGenerated({ role: 'user', content: '<project-rule source="rules/a.md">\nOLD-RULE\n</project-rule>' } as any)]);
    await session.send('touch file');
    expect(JSON.stringify(seen.at(-1))).toContain(rule.body);
  });

  it('successful automatic summary rearms a retired rule without treating its summary mention as the rule', async () => {
    const rule = { id: 'rule:/project/r.md', source: 'rules/r.md', body: 'AUTO-RULE-MARKER' };
    const { markAppGenerated } = await import('../src/main/harness/compaction');
    const model = scriptedModel([stream(...textChunks('sum', `Summary mentions ${rule.body}`), finishChunk('stop')),
      stream(toolCallChunk('c1', 'Read', { file_path: 'a.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('done', 'done'), finishChunk('stop'))]);
    const session = new HarnessSession(makeOpts({ contextLength: 8192, triggers: always(rule),
      tools: [fakeTool('Read', { permissionSubject: (a: any) => a.file_path })], decide: async () => ALLOW,
    }), async () => model as any);
    session.seedHistory([{ role: 'user', content: 'old task ' + 'x'.repeat(9000) },
      markAppGenerated({ role: 'user', content: `<project-rule source="${rule.source}">\n${rule.body}\n</project-rule>` } as any),
      { role: 'assistant', content: 'done' }, { role: 'user', content: 'newer task' }, { role: 'assistant', content: 'done' },
      { role: 'user', content: 'latest task' }] as any);
    (session as any).abort = new AbortController();
    try { expect(await (session as any).maybeCompact(model, {}, true)).toBe(true); }
    finally { (session as any).abort = null; }
    expect((session as any).retainedTriggerMessages.size).toBe(0);
    expect((session as any).history[0].content).toContain(rule.body);
    await session.send('touch a.ts');
    expect((session as any).history.filter((m: any) => typeof m.content === 'string' && m.content.startsWith('<project-rule source='))).toHaveLength(1);
  });

  it('a prune that drops the rule rearms its path on the next touch', async () => {
    const rule = { id: 'rule:/project/r.md', source: 'rules/r.md', body: 'DROPPED-RULE-MARKER' };
    const { markAppGenerated } = await import('../src/main/harness/compaction');
    const { session, seen } = run(always(rule), TWO_STEP);
    session.seedHistory([{ role: 'user', content: 'earlier' },
      markAppGenerated({ role: 'user', content: `<project-rule source="${rule.source}">\n${rule.body}\n</project-rule>` } as any)] as any);
    (session as any).commitPrune([(session as any).history[0]]);
    await session.send('touch');
    expect(JSON.stringify(seen.at(-1)).split(rule.body).length - 1).toBe(1);
  });

  it('a prune that retains the rule does not rearm it', async () => {
    const rule = { id: 'rule:/project/r.md', source: 'rules/r.md', body: 'PRUNE-RULE-MARKER' };
    const { markAppGenerated } = await import('../src/main/harness/compaction');
    const { session, seen } = run(always(rule), TWO_STEP);
    session.seedHistory([{ role: 'user', content: 'earlier' },
      markAppGenerated({ role: 'user', content: `<project-rule source="${rule.source}">\n${rule.body}\n</project-rule>` } as any)] as any);
    (session as any).commitPrune([...(session as any).history]);
    await session.send('touch');
    expect(JSON.stringify(seen.at(-1)).split(rule.body).length - 1).toBe(1);
  });

  it('no trigger, no injection — an ordinary turn is untouched', async () => {
    const { session, seen } = run(never, TWO_STEP);
    await session.send('go');
    expect(JSON.stringify(seen)).not.toContain('project-rule');
  });

  it('a session with NO trigger index behaves exactly as before', async () => {
    // Every existing caller passes none; this must not become required.
    const read = fakeTool('Read', { permissionSubject: (a: any) => a.file_path });
    const model = scriptedModel(TWO_STEP);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    await expect(session.send('go')).resolves.toBeUndefined();
  });

  it('long content is cut to the profile budget, and says so', async () => {
    const { session, seen } = run(
      always({ id: 'r1', source: 'r', body: 'x'.repeat(40_000) }),
      TWO_STEP,
      { injectionBudgetTokens: 200 },
    );
    await session.send('go');
    const body = JSON.stringify(seen);
    expect(body).toMatch(/truncated/i);
    expect(body).not.toContain('x'.repeat(20_000));
  });
});

// ---------------------------------------------------------------------------
// Non-path subjects. Found in the 2026-07-28 branch review: the driver's rule
// was "everything except Bash has a path subject", spelled inline. Skill's
// subject is a skill id, so the moment it was added it silently inherited
// file-tool treatment — canonicalized against cwd, run through the credential
// denylist, and matched against rule globs. Benign in practice today, wrong in
// principle, and exactly the kind of thing that stops being benign quietly.
// ---------------------------------------------------------------------------
// The positive case — a FILE tool DOES trigger rules — is covered by
// 'a matched trigger reaches the model as a MESSAGE' at the top of this file,
// which uses Read. That pairing is what keeps this exclusion narrow.
describe('non-path tool subjects are not treated as paths', () => {
  it('a Skill call does not trigger path-scoped rules', async () => {
    const seen: any[] = [];
    // A trigger index that fires for ANY input — if Skill's subject reached it,
    // the rule would be injected.
    const firesForAnything: TriggerIndex = { match: () => [{ id: 'r', source: 'r', body: 'RULE-MARKER' }] };
    const skill = fakeTool('Skill', {
      schema: (await import('zod')).z.object({ skill: (await import('zod')).z.string() }),
      permissionSubject: (a: any) => a.skill,
    });
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Skill', { skill: 'theme-builder' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'done'), finishChunk('stop')),
    ], seen);
    const session = new HarnessSession(
      makeOpts({ tools: [skill], decide: async () => ALLOW, triggers: firesForAnything, profile: CLOUD_DEFAULT }),
      async () => model as any,
    );
    await session.send('go');
    expect(JSON.stringify(seen)).not.toContain('RULE-MARKER');
  });

  it('a Bash call does not either', async () => {
    const seen: any[] = [];
    const firesForAnything: TriggerIndex = { match: () => [{ id: 'r', source: 'r', body: 'RULE-MARKER' }] };
    const bash = fakeTool('Bash', {
      schema: (await import('zod')).z.object({ command: (await import('zod')).z.string() }),
      permissionSubject: (a: any) => a.command,
    });
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Bash', { command: 'ls src/api' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'done'), finishChunk('stop')),
    ], seen);
    const session = new HarnessSession(
      makeOpts({ tools: [bash], decide: async () => ALLOW, triggers: firesForAnything, profile: CLOUD_DEFAULT }),
      async () => model as any,
    );
    await session.send('go');
    expect(JSON.stringify(seen)).not.toContain('RULE-MARKER');
  });
});
