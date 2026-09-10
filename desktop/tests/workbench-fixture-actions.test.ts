import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadFixture } from '../src/renderer/dev/workbench/fixture-loader';
import { buildHydratePayload } from '../src/renderer/dev/workbench/seed-chat';
import { deserializeChatState } from '../src/renderer/state/chat-types';

const FIXTURE_ROOT = join(__dirname, '../src/renderer/dev/workbench/fixtures');

/** Every line kind loadFixture recognises. Anything else is SILENTLY SKIPPED by
 *  the loader, so a typo'd kind in a fixture would simply vanish from the
 *  timeline with no error — which is exactly the failure this guards. */
const KNOWN_KINDS = new Set([
  'text', 'user_message', 'turn_complete', 'assistant_text', 'tool_use', 'tool_result',
  'permission_request',
  // Specialists 1c: a child's stamped events, its routed ask, the run record
  // (a delivered steer rides on the run record's own `notes` — Task 10 — so
  // there is no separate line kind for it), and the folded background report.
  'subagent_text', 'subagent_thinking', 'subagent_tool_use', 'subagent_tool_result',
  'subagent_permission_request', 'specialist_run', 'specialist_report',
  // 'stalled' (Task 6): parks the turn via TRANSCRIPT_THINKING_HEARTBEAT so the
  // stalled card can be looked at in the workbench — no backend involved.
  'stalled',
  // 'session_error' (Sign in with ChatGPT, 2026-09-04): the provider failed the
  // turn — NATIVE_SESSION_ERROR through the real reducer, so the error banner
  // and its plan-limit variant are reviewable. Lines tagged optIn:"planLimit"
  // are skipped unless includePlanLimit is set (same shape as 'stalled').
  'session_error',
  // G-1 background Bash: the live run record a Bash card renders from
  // (fixture-loader.ts dispatches it as SHELL_RUN_CHANGED). Landed with the
  // card mockup in 69d066a3; this allowlist was missed, leaving the branch red.
  'shell_run',
  // 'session_context' (Step 3, 2026-08-17, broadened): seeds the session's
  // STARTING context (SESSION_CONTEXT → SessionContextBanner + SessionContextPopup).
  // No backend yet — MOCK_ONLY — but the line kind IS handled by the loader.
  'session_context',
]);

function fixtureFiles(dir: string): Array<{ name: string; raw: string }> {
  return readdirSync(join(FIXTURE_ROOT, dir))
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({
      name: f.replace('.jsonl', ''),
      raw: readFileSync(join(FIXTURE_ROOT, dir, f), 'utf8'),
    }));
}

const CONVO = [
  '{"type":"user_message","text":"fix the scroll stick"}',
  '{"type":"assistant_text","text":"Reading ChatView.tsx."}',
  '{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/a/ChatView.tsx"}}',
  '{"type":"tool_result","tool_use_id":"t1","content":"ok"}',
].join('\n');

describe('fixture replay', () => {
  it('emits an action per user_message and assistant_text line', () => {
    const r = loadFixture('convo', CONVO);
    expect(r.error).toBeUndefined();
    const types = r.actions.map((a) => a.type);
    expect(types).toContain('USER_PROMPT');
    expect(types).toContain('TRANSCRIPT_ASSISTANT_TEXT');
  });

  // Every action the loader dispatched must be returned, or replaying the list
  // into a live reducer produces a DIFFERENT timeline than the loader built —
  // which is the one thing this file exists to prevent.
  it('returns every action it dispatched, in order', () => {
    const r = loadFixture('convo', CONVO);
    expect(r.actions.map((a) => a.type)).toEqual([
      'USER_PROMPT',
      'TRANSCRIPT_ASSISTANT_TEXT',
      'TRANSCRIPT_TOOL_USE',
      'TRANSCRIPT_TOOL_RESULT',
    ]);
  });

  // The reducer requires these fields; a fixture that omits them would build a
  // timeline the live app could never produce.
  it('stamps the fields the real actions require', () => {
    const r = loadFixture('convo', CONVO);
    const prompt = r.actions.find((a) => a.type === 'USER_PROMPT') as any;
    // `content`, NOT `text` — chat-types.ts:319-326.
    expect(prompt.content).toBe('fix the scroll stick');
    expect(typeof prompt.timestamp).toBe('number');

    const text = r.actions.find((a) => a.type === 'TRANSCRIPT_ASSISTANT_TEXT') as any;
    expect(text.text).toBe('Reading ChatView.tsx.');
    expect(typeof text.timestamp).toBe('number');
    expect(typeof text.uuid).toBe('string');
  });

  it('still returns tool blocks for the existing tool fixtures', () => {
    const r = loadFixture('convo', CONVO);
    expect(r.blocks.filter((b) => b.kind === 'tool')).toHaveLength(1);
  });

  it('reports a parse error rather than throwing', () => {
    const bad = loadFixture('bad', '{not json}');
    expect(bad.error).toContain('parse error');
    expect(bad.actions).toEqual([]);
  });
});

// Spec §8: every shipped fixture must replay into a well-formed timeline.
describe('shipped fixtures replay', () => {
  const all = [...fixtureFiles('tools'), ...fixtureFiles('conversations')];

  it('finds the fixtures (a glob that matches nothing would pass vacuously)', () => {
    expect(fixtureFiles('tools').length).toBeGreaterThanOrEqual(24);
    expect(fixtureFiles('conversations').length).toBeGreaterThanOrEqual(2);
  });

  it.each(all)('$name parses with no error', ({ name, raw }) => {
    expect(loadFixture(name, raw).error).toBeUndefined();
  });

  it.each(all)('$name uses only line kinds the loader handles', ({ raw }) => {
    const unknown = raw.split('\n')
      .map((l) => l.trim()).filter(Boolean)
      .map((l) => JSON.parse(l).type)
      .filter((t) => !KNOWN_KINDS.has(t));
    expect(unknown).toEqual([]);
  });

  it.each(all)('$name produces a non-empty timeline', ({ name, raw }) => {
    const r = loadFixture(name, raw);
    expect(r.blocks.length + r.actions.length).toBeGreaterThan(0);
  });

  it.each(fixtureFiles('conversations'))(
    'conversation $name emits one action per dispatched line',
    ({ name, raw }) => {
      // A `subagent_permission_request` with `held: true` dispatches TWO
      // actions (the ask, then PERMISSION_HELD) — the one line kind that is
      // deliberately not 1:1.
      const dispatched = raw.split('\n')
        .map((l) => l.trim()).filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((p) => p.type !== 'text')
        .reduce((n, p) => n + (p.type === 'subagent_permission_request' && p.held === true ? 2 : 1), 0);
      // includeStalled here so the count means what it says: EVERY dispatchable
      // line really was dispatched. The parked-turn line is opt-in at the
      // workbench level (see the default-off case below), not un-dispatchable.
      expect(loadFixture(name, raw, undefined, { includeStalled: true, includePlanLimit: true }).actions)
        .toHaveLength(dispatched);
    },
  );

  // Fix (M9, whole-branch review 2026-08-16): native.jsonl's `{"type":"stalled"}`
  // line used to replay unconditionally, so the shared native session sat under
  // the red "Provider may have stalled" card in every single workbench
  // scenario. It is now opt-in (`?stalled=1`). Both halves are pinned: off by
  // default, and still reachable when asked for — a fix that made the card
  // permanently unreachable would be its own regression.
  const STALLED_FIXTURE = [
    '{"type":"user_message","text":"go"}',
    '{"type":"assistant_text","text":"Working on it."}',
    '{"type":"stalled"}',
  ].join('\n');

  it('skips the stalled line by DEFAULT — the workbench is not parked unless asked', () => {
    const r = loadFixture('stalled-fixture', STALLED_FIXTURE);
    expect(r.error).toBeUndefined();
    expect(r.actions.map((a) => a.type)).toEqual(['USER_PROMPT', 'TRANSCRIPT_ASSISTANT_TEXT']);
  });

  it('replays the stalled line when includeStalled is set', () => {
    const r = loadFixture('stalled-fixture', STALLED_FIXTURE, undefined, { includeStalled: true });
    expect(r.actions.map((a) => a.type)).toEqual([
      'USER_PROMPT', 'TRANSCRIPT_ASSISTANT_TEXT', 'TRANSCRIPT_THINKING_HEARTBEAT',
    ]);
  });
});

// The promo's reply fixtures (2026-09-03: briefing.jsonl, sheet.jsonl,
// flappy-task.jsonl, and the other files under fixtures/replies/) were the
// first fixtures nothing tested — the plan claimed the `all` list above
// covered every .jsonl under fixtures/replies/, but it only ever globbed
// 'tools' and 'conversations'. This block runs the same "parses" and "known
// kinds" checks the shipped fixtures get, kept separate from `all` above
// because replies files are turn-only scripts (no 1:1 dispatched-action
// count is defined for them the way it is for `conversations`).
describe('reply fixtures', () => {
  const replies = fixtureFiles('replies');

  it('finds the fixtures (a glob that matches nothing would pass vacuously)', () => {
    expect(replies.length).toBeGreaterThanOrEqual(10);
  });

  it.each(replies)('$name parses with no error', ({ name, raw }) => {
    expect(loadFixture(name, raw).error).toBeUndefined();
  });

  it.each(replies)('$name uses only line kinds the loader handles', ({ raw }) => {
    const unknown = raw.split('\n')
      .map((l) => l.trim()).filter(Boolean)
      .map((l) => JSON.parse(l).type)
      .filter((t) => !KNOWN_KINDS.has(t));
    expect(unknown).toEqual([]);
  });

  it.each(replies)('$name produces a non-empty timeline', ({ name, raw }) => {
    const r = loadFixture(name, raw);
    expect(r.blocks.length + r.actions.length).toBeGreaterThan(0);
  });
});

// The hydrate payload is what App.tsx:1465 actually receives, so a payload that
// deserializes into empty timelines means "the workbench shows no conversation"
// — with no error anywhere. Guard the round-trip, not just the actions.
describe('chat hydrate payload', () => {
  it('round-trips through the app serializers into populated timelines', () => {
    const restored = deserializeChatState(buildHydratePayload());

    // Every mapped conversation fixture must be present, keyed by the ids the
    // session list uses — a mismatch shows an empty chat view. site-1 added
    // when scenario=site's fixture (site.jsonl) was mapped in SESSION_FOR —
    // buildHydratePayload merges every mapped fixture unconditionally, not
    // just the active scenario's.
    expect([...restored.keys()].sort()).toEqual(['site-1', 'wb-1', 'wb-11', 'wb-2', 'wb-3']);

    for (const [sessionId, session] of restored) {
      expect(session.timeline.length, `${sessionId} timeline`).toBeGreaterThan(0);
    }
  });

  it('includes the user prompt and the tool calls, not just one of them', () => {
    const restored = deserializeChatState(buildHydratePayload());
    const cc = restored.get('wb-1')!;
    expect(cc.timeline.some((e: any) => e.kind === 'user')).toBe(true);
    expect(cc.toolCalls.size).toBeGreaterThan(0);
  });

  it('is stable across calls (cached payload is not mutated by a consumer)', () => {
    const first = buildHydratePayload();
    deserializeChatState(first);
    expect(buildHydratePayload()).toEqual(first);
  });
});
