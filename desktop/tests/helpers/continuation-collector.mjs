// Lab-only lifecycle receipts. No production state, model text or wall-clock timestamps.
export const CONTINUATION_THRESHOLD_MS = 1000;

/** All callbacks share the supplied monotonic clock; no sampled idle intervals are invented. */
export function createContinuationCollector({ sessionId, now, verifyWrite, thresholdMs = CONTINUATION_THRESHOLD_MS }) {
  const start = now(), receipts = [], inputs = [], tools = new Map(), modes = new Map(), requests = new Set();
  let childId = null, parentToolCallId = null, completedAt = null, deliveredAt = null;
  let requestAt = null, progressAt = null, progressReference = null, receiptUuid = null, terminal = null;
  let deliveryModeCovered = true;
  const stamp = (kind, detail = {}) => {
    const at = now(); receipts.push({ kind, at, sessionId, ...detail }); return at;
  };
  const root = e => e.sessionId === sessionId && !e.data?.agentId && !e.data?.parentAgentToolUseId;
  return {
    specialist(e) {
      if (e.sessionId !== sessionId || e.kind !== 'run' || !e.run.background) return;
      if (parentToolCallId && e.run.parentToolCallId !== parentToolCallId) return;
      if (childId && e.run.childId !== childId) return;
      childId = e.run.childId;
      parentToolCallId ??= e.run.parentToolCallId;
      if (e.run.status === 'completed' && completedAt === null)
        completedAt = stamp('child-terminal-observed', { childId, parentToolCallId });
    },
    deliveryAttempt(meta, mode, dropped = false) {
      if (!meta?.childId || meta.childId !== childId) return;
      modes.set(meta.childId, mode);
      stamp(dropped ? 'lab-dropped-report' : 'delivery-attempt', { childId, mode });
    },
    request(row) {
      if (requests.has(row.id)) return; // observeModel calls again when the same attempt ends.
      requests.add(row.id);
      if (row.sessionId !== sessionId || row.role !== 'main' || deliveredAt === null) return;
      const at = stamp('parent-model-request-started', { childId, requestId: row.id });
      requestAt ??= at;
    },
    transcript(e) {
      if (!root(e)) return;
      const d = e.data ?? {};
      if (e.type === 'user-message') {
        if (!d.injected) inputs.push({ at: stamp('root-input', { uuid: e.uuid }), kind: inputs.length ? 'scripted' : 'initial' });
        else if (d.injected === 'specialist-report' && childId && d.injectedMeta?.childId === childId
            && d.injectedMeta?.parentToolCallId === parentToolCallId && deliveredAt === null) {
          receiptUuid = e.uuid;
          const mode = modes.get(childId);
          const at = stamp('report-injected', { childId, parentToolCallId, uuid: e.uuid, mode: mode ?? 'unknown' });
          if (mode === 'turn' || mode === 'boundary' || mode === 'splice') deliveredAt = at;
          else deliveryModeCovered = false; // never turn an unobserved delivery mode into active/held evidence
        }
      }
      if (e.type === 'tool-use') {
        tools.set(d.toolUseId, { ...d, afterDelivery: deliveredAt !== null });
        if (d.toolName === 'Task' && d.toolInput?.background) parentToolCallId ??= d.toolUseId;
      }
      if (e.type === 'tool-result' && deliveredAt !== null && progressAt === null && d.isError === false) {
        const use = tools.get(d.toolUseId);
        if (use?.toolName === 'Write' && use.afterDelivery) {
          const reference = verifyWrite(use.toolInput);
          if (reference) {
            progressReference = reference;
            progressAt = stamp('fixture-verified-write', { childId, toolUseId: d.toolUseId, uuid: e.uuid, reference });
          }
        }
      }
      if (['turn-complete', 'session-error', 'user-interrupt'].includes(e.type)) {
        const at = stamp('parent-terminal', { uuid: e.uuid, type: e.type });
        if (deliveredAt !== null) terminal = { at, state: 'stopped', reference: `transcript:${e.uuid}` };
      }
    },
    observing() { return completedAt === null || now() < completedAt + thresholdMs; },
    finish() {
      const end = now(), taskId = childId ?? 'unobserved-child', reportId = `${sessionId}:${taskId}:${parentToolCallId ?? 'unobserved-task'}`;
      const episode = { id: reportId, sessionId, taskId, reportId, thresholdMs, observation: { start, end },
        fixture: { reference: 'background-followthrough/continued.txt=FOLLOWUP-OK\\n', requiredWork: true,
          blocked: false, requiresUser: false, dependsOn: [] },
        coverage: { childCompletion: true, reportDelivery: deliveryModeCovered, parentState: false, userInputs: true, progress: true },
        evidence: { sessionId, taskId, reportId, childCompletedAt: completedAt, reportQueuedAt: null,
          reportDeliveredAt: deliveredAt, parentRequestStartedAt: requestAt,
          firstUsefulProgressAt: progressAt, verifiedFollowupAt: progressAt,
          ...(deliveredAt !== null ? { deliveryContext: modes.get(childId) === 'splice' ? 'held' : 'active' } : {}),
          ...(progressAt !== null ? { progressReference, followupReference: progressReference } : {}) },
        states: [], inputs: inputs.map(i => ({ ...i })), ...(terminal ? { terminal: { ...terminal } } : {}) };
      // WHY: teardown events must not mutate an already closed observation snapshot.
      return { episode, receipts: receipts.map(r => ({ ...r })), correlation: { sessionId, childId, reportId, parentToolCallId, receiptUuid },
        clock: 'performance.now callback observation (single worker timebase)',
        coverageGaps: ['No complete host scheduler state intervals; actionable idle duration and idle-dependent wake-up attribution unknown.',
          'Child completion is callback-observed, not the ledger endedAt wall-clock timestamp; report queue time unobserved.'] };
    },
  };
}
