import { createHash, randomUUID } from 'node:crypto';

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const bytes = value => Buffer.byteLength(JSON.stringify(value ?? null));
const hash = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
function normalizeUsage(usage, metadata) {
  if (!usage) return null;
  return { inputTokens: number(usage.inputTokens?.total), outputTokens: number(usage.outputTokens?.total),
    cacheReadTokens: number(usage.inputTokens?.cacheRead), cacheWriteTokens: number(usage.inputTokens?.cacheWrite),
    reasoningTokens: number(usage.outputTokens?.reasoning),
    costUsd: number(metadata?.openrouter?.costUsd ?? usage.raw?.cost) };
}

/** Wrap the SDK boundary, not turn-complete events: retries and child calls remain separate attempts. */
export function observeModel(model, { records, context = () => null, maxRequests, onRecord = () => {}, beforeRequest = () => {}, activity, rootSessionId }) {
  if (!Number.isInteger(maxRequests) || maxRequests < 1) throw new Error('A positive request limit is required');
  function begin(params) {
    if (records.length >= maxRequests) throw new Error('Lab request limit reached; no further provider call was made');
    beforeRequest(params);
    const ctx = context() ?? {};
    const system = (params.prompt ?? []).filter(m => m.role === 'system');
    const history = (params.prompt ?? []).filter(m => m.role !== 'system');
    // WHY: summary is a request purpose, not ownership; children compact too.
    const scope=rootSessionId&&ctx.sessionId?(ctx.sessionId===rootSessionId?'parent':'child'):
      ctx.purpose==='specialist'?'child':ctx.purpose==='summary'?'unknown':'parent';
    const row = { id: randomUUID(), sessionId: ctx.sessionId ?? null, scope,
      logicalStepId: ctx.logicalStepId ?? null, measurementBoundary: 'sdk-attempt',
      role: ctx.purpose === 'summary' ? 'compaction' : ctx.purpose === 'specialist' ? 'specialist' : 'main',
      purpose: ctx.purpose ?? null, model: model.modelId, provider: model.provider,
      startedAt: new Date().toISOString(), endedAt: null, durationMs: null,
      status: 'interrupted', usage: null,
      requestShape: { systemBytes: bytes(system), toolsBytes: bytes(params.tools), historyBytes: bytes(history),
        systemHash: hash(system), toolsHash: hash(params.tools) } };
    const start = performance.now();
    records.push(row);
    onRecord(row);
    const emit=(kind,data={})=>{if(scope!=='unknown')activity?.emit(kind,{...data,requestId:row.id,sessionId:row.sessionId,scope});};
    emit('request-start');
    let first=true;
    const chunk=part=>{
      if(first){first=false;emit('first-byte');}
      const match=/^(reasoning|text|tool-input)-(start|delta|end)$/.exec(part.type);
      if(match&&(match[2]!=='delta'||typeof part.delta==='string'&&part.delta.length>0))emit('phase-'+match[2],{id:part.id,phase:({'reasoning':'reasoning-stream',text:'answer-stream','tool-input':'tool-argument-stream'})[match[1]]});
    };
    let ended = false;
    return { row, chunk, end(status, result) {
      if (ended) return;
      ended = true;
      emit('request-end',{status});
      row.status = status;
      row.usage = normalizeUsage(result?.usage, result?.providerMetadata);
      row.endedAt = new Date().toISOString();
      row.durationMs = performance.now() - start;
      onRecord(row);
    } };
  }
  const methods = {
    async doGenerate(params) {
      const attempt = begin(params);
      try {
        const result = await model.doGenerate(params);
        attempt.end('completed', result);
        return result;
      } catch (error) { attempt.end(params.abortSignal?.aborted ? 'interrupted' : 'failed'); throw error; }
    },
    async doStream(params) {
      const attempt = begin(params);
      try {
        const result = await model.doStream(params);
        const reader = result.stream.getReader();
        let finish;
        let failed = false;
        // WHY explicit reader instead of tee: preserve backpressure and cancellation without buffering a second transcript.
        const stream = new ReadableStream({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) {
                attempt.end(failed || !finish ? 'failed' : 'completed', finish);
                controller.close();
                return;
              }
              attempt.chunk(next.value);
              if (next.value.type === 'finish') finish = next.value;
              if (next.value.type === 'error') failed = true;
              controller.enqueue(next.value);
            } catch (error) {
              attempt.end(params.abortSignal?.aborted ? 'interrupted' : 'failed', finish);
              controller.error(error);
            }
          },
          async cancel(reason) {
            attempt.end('interrupted', finish);
            await reader.cancel(reason);
          },
        });
        return { ...result, stream };
      } catch (error) { attempt.end(params.abortSignal?.aborted ? 'interrupted' : 'failed'); throw error; }
    },
  };
  return new Proxy(model, { get(target, key) {
    if (key in methods) return methods[key];
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
