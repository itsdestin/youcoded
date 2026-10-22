// Which Claude model a resumed Claude Code conversation reopens on, and which
// live events are allowed to change that answer.
import { describe, it, expect } from 'vitest';
import { resolveResumeModel } from '../src/main/conversations/resume-model';
import { conversationModelOf } from '../src/shared/model-ids';
import { parseTranscriptLine } from '../src/main/transcript-watcher';
import { stampSubagent } from '../src/shared/transcript-event-types';

const sources = (o: { transcript?: string | null; stored?: string | null; fallback?: string }) => ({
  transcriptModelId: async () => o.transcript,
  storedModelId: async () => o.stored,
  defaultModel: () => o.fallback,
});

describe('resolveResumeModel', () => {
  it('reopens on the model the transcript last ran on, even when the record says otherwise', async () => {
    // The crash case: helpers were speaking last, and an older build had let
    // their Sonnet overwrite the record of an Opus conversation.
    expect(await resolveResumeModel(sources({ transcript: 'claude-opus-5-5', stored: 'claude-sonnet-5-5', fallback: 'sonnet' })))
      .toBe('opus[1m]');
  });

  it('uses the record when there is no local transcript (a conversation synced from another device)', async () => {
    expect(await resolveResumeModel(sources({ transcript: null, stored: 'claude-haiku-5-5', fallback: 'opus[1m]' }))).toBe('haiku');
  });

  it('skips a placeholder id and falls through to the next source', async () => {
    expect(await resolveResumeModel(sources({ transcript: '<synthetic>', stored: 'claude-opus-5', fallback: 'sonnet' }))).toBe('opus[1m]');
  });

  it('uses the saved default only when the conversation records no model', async () => {
    expect(await resolveResumeModel(sources({ fallback: 'opus[1m]' }))).toBe('opus[1m]');
  });

  it('leaves the choice to Claude Code when nothing answers, rather than guessing Sonnet', async () => {
    expect(await resolveResumeModel(sources({}))).toBeUndefined();
  });

  it('treats a source that throws as silent', async () => {
    expect(await resolveResumeModel({
      transcriptModelId: async () => { throw new Error('EBUSY'); },
      storedModelId: async () => 'claude-opus-5-5',
      defaultModel: () => { throw new Error('unreadable'); },
    })).toBe('opus[1m]');
  });
});

describe('conversationModelOf', () => {
  const assistantLine = (model: string) => JSON.stringify({
    type: 'assistant', uuid: 'u1', timestamp: '2026-10-22T00:42:06.000Z',
    message: { id: 'm1', role: 'assistant', model, content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' },
  });
  const textEvent = (model: string) => {
    const ev = parseTranscriptLine(assistantLine(model), 'desk-1').find((e) => e.type === 'assistant-text');
    if (!ev) throw new Error('fixture line produced no assistant-text event');
    return ev;
  };

  it("returns the main conversation's model", () => {
    expect(conversationModelOf(textEvent('claude-opus-5-5').data)).toBe('claude-opus-5-5');
  });

  it("ignores a helper agent's message, so a Sonnet helper cannot change an Opus conversation's model", () => {
    const helper = stampSubagent(textEvent('claude-sonnet-5-5') as any, 'toolu_parent', 'agent-1');
    expect(conversationModelOf(helper.data)).toBeNull();
  });

  it("ignores Claude Code's placeholder model", () => {
    expect(conversationModelOf(textEvent('<synthetic>').data)).toBeNull();
  });
});
