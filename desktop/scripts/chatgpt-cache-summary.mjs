#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';

// WHY: this reader never needs conversation files, and refuses extra fields rather
// than echoing untrusted/private data from a file that is not our diagnostic schema.
const allowed = new Set('version sessionId laneId logicalStepId attemptId resendParentId dispatchSequence baselineAttemptId lastSuccessfulAttemptId timestamp durationMs model purpose outcome inputItems stablePrefixItems firstDifferingItem change changed inputTokens outputTokens cachedInputTokens cacheDetailPresent dropped evicted expired writeFailures'.split(' '));
const count = n => Number.isSafeInteger(n) && n >= 0;
// WHY: grouping-field validation alone accepts fabricated partial records. Every
// persisted field is required and typed, including nested comparison flags.
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.size && Object.keys(value).every(k => keys.has(k));
const opaque = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const nullableCount = value => value === null || count(value);
const components = new Set(['instructions', 'tools', 'model', 'settings', 'cacheKey']);
function validRecord(r) {
  if (!exact(r, allowed) || r.version !== 1 || !['sessionId', 'laneId', 'logicalStepId'].every(k => opaque(r[k])) || !uuid(r.attemptId) ||
      !['resendParentId', 'baselineAttemptId', 'lastSuccessfulAttemptId'].every(k => r[k] === null || uuid(r[k])) ||
      !['dispatchSequence', 'timestamp', 'durationMs', 'inputItems', 'stablePrefixItems', 'dropped', 'evicted', 'expired', 'writeFailures'].every(k => count(r[k])) || r.dispatchSequence < 1 ||
      !['inputTokens', 'outputTokens', 'cachedInputTokens', 'firstDifferingItem'].every(k => nullableCount(r[k])) ||
      typeof r.cacheDetailPresent !== 'boolean' || !exact(r.changed, components) || ![...components].every(k => typeof r.changed[k] === 'boolean') ||
      typeof r.model !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(r.model) ||
      !['chat', 'specialist', 'title', 'summary', 'unknown'].includes(r.purpose) ||
      !['success', 'failed', 'aborted', 'expired'].includes(r.outcome) ||
      !['baseline', 'identical', 'append', 'edit', 'remove'].includes(r.change)) return false;
  if (r.stablePrefixItems > r.inputItems || (r.cachedInputTokens !== null && (!r.cacheDetailPresent || r.inputTokens === null || r.cachedInputTokens > r.inputTokens))) return false;
  if (r.change === 'baseline') return r.baselineAttemptId === null && r.firstDifferingItem === null && r.stablePrefixItems === 0 && [...components].every(k => !r.changed[k]);
  if (r.baselineAttemptId === null) return false;
  if (r.change === 'identical') return r.firstDifferingItem === null && r.stablePrefixItems === r.inputItems;
  if (r.firstDifferingItem !== r.stablePrefixItems) return false;
  return r.change === 'remove' ? r.stablePrefixItems === r.inputItems : r.stablePrefixItems < r.inputItems;
}
const groups = new Map();
let rejected = 0;
const lossCounters = {};
for (const file of process.argv.slice(2)) {
  try {
    if ((await stat(file)).size > 5 * 1024 * 1024) { rejected++; continue; }
    for (const line of (await readFile(file, 'utf8')).split('\n').filter(Boolean)) {
      let r;
      try { r = JSON.parse(line); } catch { rejected++; continue; }
      if (r?.kind === 'loss' && r.version === 1 && Object.keys(r).every(k => ['version', 'kind', 'timestamp', 'dropped', 'evicted', 'expired', 'writeFailures'].includes(k)) && ['timestamp', 'dropped', 'evicted', 'expired', 'writeFailures'].every(k => count(r[k]))) {
        for (const k of ['dropped', 'evicted', 'expired', 'writeFailures']) lossCounters[k] = Math.max(lossCounters[k] ?? 0, r[k]);
        continue;
      }
      if (!validRecord(r)) { rejected++; continue; }
      const key = `${r.sessionId}:${r.model}:${r.purpose}`;
      let g = groups.get(key);
      if (!g) {
        g = { sessionId: r.sessionId, model: r.model, purpose: r.purpose, requests: 0, successful: 0, validRequests: 0, inputTokens: 0, outputTokens: 0, reportedInput: 0, cachedInput: 0, successfulInput: 0, missingInputRequests: 0, durationMs: 0, changes: {}, outcomes: {}, lossCounters: {} };
        groups.set(key, g);
      }
      g.requests++;
      g.changes[r.change] = (g.changes[r.change] ?? 0) + 1;
      g.outcomes[r.outcome] = (g.outcomes[r.outcome] ?? 0) + 1;
      if (count(r.durationMs)) g.durationMs += r.durationMs;
      if (count(r.inputTokens)) g.inputTokens += r.inputTokens; else g.missingInputRequests++;
      if (count(r.outputTokens)) g.outputTokens += r.outputTokens;
      for (const k of ['dropped', 'evicted', 'expired', 'writeFailures']) if (count(r[k])) g.lossCounters[k] = Math.max(g.lossCounters[k] ?? 0, r[k]);
      if (r.outcome !== 'success') continue;
      g.successful++;
      if (count(r.inputTokens)) g.successfulInput += r.inputTokens;
      if (r.cacheDetailPresent === true && count(r.inputTokens) && count(r.cachedInputTokens) && r.cachedInputTokens <= r.inputTokens) {
        g.validRequests++; g.reportedInput += r.inputTokens; g.cachedInput += r.cachedInputTokens;
      }
    }
  } catch { rejected++; }
}
console.log(JSON.stringify({ rejected, lossCounters, groups: [...groups.values()].map(g => ({ ...g,
  reuse: g.reportedInput > 0 ? g.cachedInput / g.reportedInput : null,
  freshInput: g.validRequests ? g.reportedInput - g.cachedInput : null,
  requestCoverage: g.successful ? g.validRequests / g.successful : null,
  inputTokenCoverage: g.successfulInput > 0 ? g.reportedInput / g.successfulInput : null,
  averageDurationMs: g.requests ? g.durationMs / g.requests : null,
})) }, null, 2));
