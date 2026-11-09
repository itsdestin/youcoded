import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContinuationCollector } from './lab-continuation.mjs';
// Workspace-only offline lab: the collector ships alone, scoring stays in the evaluator.
import { analyzeContinuationEpisodes } from '../../../scripts/harness-lab/continuation-metrics.mjs';
const scored = collector => {
  const result = collector.finish();
  return { ...result, primary: analyzeContinuationEpisodes([result.episode]).episodes[0] };
};

function fixture() {
  let time = 0;
  const collector = createContinuationCollector({ sessionId: 'parent', now: () => time,
    thresholdMs: 100, verifyWrite: input => input?.file_path === 'continued.txt' && input.content === 'FOLLOWUP-OK\n' ? 'fixture:verified' : null });
  const transcript = (type, data = {}, sessionId = 'parent') => collector.transcript({ sessionId, type, data, uuid: `${type}-${time}` });
  const child = (sessionId = 'parent', childId = 'child') => collector.specialist({ kind: 'run', sessionId,
    run: { background: true, childId, parentToolCallId: 'task', status: 'completed', endedAt: -999999 } });
  const deliver = (mode = 'turn') => {
    collector.deliveryAttempt({ childId: 'child' }, mode);
    transcript('user-message', { injected: 'specialist-report', injectedMeta: { childId: 'child', parentToolCallId: 'task' } });
  };
  transcript('user-message'); transcript('tool-use', { toolName: 'Task', toolUseId: 'task', toolInput: { background: true } });
  return { collector, transcript, child, deliver, at(t) { time = t; } };
}

test('correlated callback receipts use one clock and require verified parent Write, not acknowledgment', () => {
  const f = fixture(); f.at(10); f.child(); f.at(20); f.deliver();
  f.at(30); const row = { id: 'request', sessionId: 'parent', role: 'main' }; f.collector.request(row);
  f.at(35); f.collector.request(row); // end callback is not another request start
  f.transcript('assistant-text', { text: 'Done!' });
  assert.equal(scored(f.collector).episode.evidence.firstUsefulProgressAt, null);
  f.at(40); f.transcript('tool-use', { toolName: 'Write', toolUseId: 'write', toolInput: { file_path: 'continued.txt', content: 'FOLLOWUP-OK\n' } });
  f.at(45); f.transcript('tool-result', { toolName: 'Write', toolUseId: 'write', isError: false });
  const result = scored(f.collector);
  assert.equal(result.primary.noNudgeContinuation, 'success');
  assert.equal(result.primary.completionToReportMs, 10);
  assert.equal(result.episode.evidence.parentRequestStartedAt - result.episode.evidence.reportDeliveredAt, 10);
  assert.equal(result.primary.readyToUsefulProgressMs, 35);
  assert.equal(result.episode.coverage.parentState, false);
  assert.equal(result.primary.actionableIdleMs, null);
  assert.equal(result.receipts.filter(r => r.kind === 'parent-model-request-started').length, 1);
  assert.equal(result.correlation.childId, 'child');
});

test('delivered acknowledgment then terminal stop fails automatically with no idle coverage or nudge', () => {
  const f = fixture(); f.at(10); f.child(); f.at(20); f.deliver();
  f.at(25); f.collector.request({ id: 'r', sessionId: 'parent', role: 'main' });
  f.transcript('assistant-text', { text: 'Acknowledged' }); f.at(30); f.transcript('turn-complete');
  assert.equal(f.collector.observing(), true);
  f.at(110); assert.equal(f.collector.observing(), false);
  const result = scored(f.collector);
  assert.equal(result.primary.noNudgeContinuation, 'fail');
  assert.equal(result.primary.classification, 'unknown'); // no invented idle attribution
  assert.equal(result.episode.inputs.length, 1);
  assert.equal(result.primary.needsNudge, 'unknown');
});

test('missing injection fails at delivery stage, short observation stays censored, and held delivery stays unknown', () => {
  const f = fixture(); f.at(10); f.child();
  f.at(20); f.collector.deliveryAttempt({ childId: 'child' }, 'turn', true);
  assert.equal(scored(f.collector).primary.censored, true);
  assert.equal(scored(f.collector).primary.noNudgeContinuation, 'unknown');
  f.at(110); const lost = scored(f.collector);
  assert.equal(lost.primary.noNudgeContinuation, 'fail'); assert.equal(lost.primary.classification, 'delivery-stall');
  const held = fixture(); held.at(10); held.child(); held.at(20); held.deliver('splice'); held.at(110);
  assert.equal(scored(held.collector).primary.noNudgeContinuation, 'unknown');
});

test('unrelated sessions, mismatched reports, failed tools and unverified writes cannot produce progress', () => {
  const f = fixture(); f.at(10); f.child('other');
  assert.equal(scored(f.collector).episode.evidence.childCompletedAt, null);
  f.child(); f.child('parent', 'other-child'); f.at(20);
  f.transcript('user-message', { injected: 'specialist-report', injectedMeta: { childId: 'other-child', parentToolCallId: 'task' } });
  assert.equal(scored(f.collector).episode.evidence.reportDeliveredAt, null);
  f.deliver(); f.at(30);
  f.collector.request({ id: 'child-request', sessionId: 'child', role: 'specialist' });
  f.transcript('tool-use', { toolName: 'Write', toolUseId: 'w', toolInput: { file_path: 'wrong', content: 'FOLLOWUP-OK\n' } });
  f.transcript('tool-result', { toolUseId: 'w', isError: false });
  f.transcript('tool-use', { toolName: 'Write', toolUseId: 'w2', toolInput: { file_path: 'continued.txt', content: 'FOLLOWUP-OK\n' } });
  f.transcript('tool-result', { toolUseId: 'w2', isError: true });
  f.transcript('tool-result', { toolUseId: 'w2', isError: false }, 'child');
  f.at(110); const result = scored(f.collector);
  assert.equal(result.primary.noNudgeContinuation, 'fail');
  assert.equal(result.episode.evidence.parentRequestStartedAt, null);
  assert.equal(result.episode.evidence.verifiedFollowupAt, null);
});

test('missing delivery mode remains unknown and closed evidence is not changed by teardown', () => {
  const f = fixture(); f.at(10); f.child(); f.at(20);
  f.transcript('user-message', { injected: 'specialist-report', injectedMeta: { childId: 'child', parentToolCallId: 'task' } });
  f.at(110); const snapshot = scored(f.collector), count = snapshot.receipts.length;
  assert.equal(snapshot.episode.coverage.reportDelivery, false);
  assert.equal(snapshot.primary.noNudgeContinuation, 'unknown');
  f.at(120); f.transcript('user-interrupt'); f.transcript('user-message');
  assert.equal(snapshot.receipts.length, count);
  assert.equal(snapshot.episode.inputs.length, 1);
});

test('safe-boundary history injection remains active rather than Stop-held', () => {
  const f = fixture(); f.at(10); f.child(); f.at(20); f.deliver('boundary');
  const result = scored(f.collector);
  assert.equal(result.episode.coverage.reportDelivery, true);
  assert.equal(result.episode.evidence.deliveryContext, 'active');
});

test('an extra root input or late verified output never counts as autonomous success', () => {
  for (const extra of [true, false]) {
    const f = fixture(); f.at(10); f.child(); f.at(20); f.deliver();
    if (extra) { f.at(30); f.transcript('user-message'); }
    f.at(extra ? 40 : 111);
    f.transcript('tool-use', { toolName: 'Write', toolUseId: 'w', toolInput: { file_path: 'continued.txt', content: 'FOLLOWUP-OK\n' } });
    f.transcript('tool-result', { toolUseId: 'w', isError: false });
    f.at(120); assert.equal(scored(f.collector).primary.noNudgeContinuation, 'fail');
  }
});
