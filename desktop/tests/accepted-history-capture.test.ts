import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { AcceptedHistoryCapture } from '../src/main/harness/accepted-history-capture';
import { openAIContinuationMessages } from '../src/main/harness/openai-continuation';

const event = (type: string, uuid: string, data: any) => ({ type, sessionId: 's', uuid, timestamp: 1, data } as any);

describe('AcceptedHistoryCapture', () => {
  it('maps SDK multipart order to attempt-scoped exact event refs and excludes abandoned retries', () => {
    const capture = new AcceptedHistoryCapture('s');
    capture.recordUser(event('user-message', 'u1', { text: 'inspect' }));
    const abandoned = capture.beginAttempt();
    capture.recordDelta(abandoned, event('assistant-text', 'bad-1', { partId: 'text-0', text: 'wrong' }));
    capture.abandonAttempt(abandoned);

    const accepted = capture.beginAttempt();
    capture.recordDelta(accepted, event('assistant-thinking', 'r1', { partId: 'reasoning-0', text: 'brief reason' }));
    capture.recordDelta(accepted, event('assistant-text', 'a1', { partId: 'text-0', text: 'checking ' }));
    capture.recordToolUse(accepted, event('tool-use', 'c1', { toolUseId: 'call-1', toolName: 'Read', toolInput: { file_path: 'a' } }));
    capture.recordToolResult(event('tool-result', 'o1', { toolUseId: 'call-1', toolName: 'Read', toolResult: 'result' }));
    const sdk = openAIContinuationMessages([{
      role: 'assistant', content: [
        { type: 'reasoning', text: 'brief reason', providerOptions: { openai: { itemId: 'rs-1', reasoningEncryptedContent: 'cipher' } } },
        { type: 'text', text: 'checking ', providerOptions: { openai: { itemId: 'msg-1', phase: 'commentary' } } },
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'Read', input: { file_path: 'a' }, providerOptions: { openai: { itemId: 'fc-1' } } },
      ],
    } as any], 7);
    expect(capture.acceptAttempt(accepted, sdk)).toBe(true);

    const proposal = capture.proposal({ binding: 'binding', assemblyDigest: 'assembly' });
    expect(proposal.acceptedEventUuids).toEqual(['u1', 'r1', 'a1', 'c1', 'o1']);
    expect(proposal.acceptedEventUuids).not.toContain('bad-1');
    expect(proposal.messages).toEqual([
      { role: 'user', content: 'inspect' },
      ...sdk,
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'Read', output: { type: 'text', value: 'result' } }] },
    ]);
  });

  it('records every history mutation and post-summary/prune descriptors, but request-only fit is inert', () => {
    const capture = new AcceptedHistoryCapture('s');
    capture.inject({ role: 'user', content: '<steer>later</steer>' });
    const beforeFit = capture.proposal({ binding: 'b', assemblyDigest: 'a' });
    capture.requestProjection([{ role: 'user', content: 'temporary fitted view' }]);
    expect(capture.proposal({ binding: 'b', assemblyDigest: 'a' })).toEqual(beforeFit);

    capture.replaceAfterPrune([{ role: 'user', content: 'kept' }], ['tool-result-1']);
    expect(capture.proposal({ binding: 'b', assemblyDigest: 'a' }).transformation).toEqual({
      kind: 'pruned', prunedToolResultUuids: ['tool-result-1'], retainedEventUuids: [],
    });
    capture.replaceAfterSummary(event('compact-summary', 'summary-1', { summary: 'short' }), [{ role: 'assistant', content: 'suffix' }] as ModelMessage[], ['suffix-1']);
    const summary = capture.proposal({ binding: 'b', assemblyDigest: 'a' });
    expect(summary.messages).toEqual([{ role: 'user', content: '[Earlier conversation summary]\nshort' }, { role: 'assistant', content: 'suffix' }]);
    expect(summary.transformation).toEqual({ kind: 'summary', summaryEventUuid: 'summary-1', retainedEventUuids: ['suffix-1'] });
    expect(summary.revision).toBeGreaterThan(beforeFit.revision);
  });
});
