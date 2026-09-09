/**
 * Fake OpenAI Responses SSE bodies, driven through the REAL `@ai-sdk/openai`
 * responses provider (never a hand-rolled model). Extracted from
 * tests/openai-continuation.test.ts so the host-level continuation tests
 * exercise the same wire fixtures the harness-level ones do — one place to
 * change when the Responses event shape moves.
 */

/** One `text/event-stream` response carrying `events` then `[DONE]`. */
export function sse(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

export function completed(usage: Record<string, unknown> = {}): unknown {
  return {
    type: 'response.completed',
    response: {
      id: 'resp', status: 'completed',
      usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28, ...usage },
    },
  };
}

/**
 * A complete multi-part step: encrypted reasoning with a visible summary, a
 * `commentary` message, TWO parallel function calls, then a `final_answer`
 * message. `fileA`/`fileB` are the arguments the two calls carry — the host
 * tests point them at real files so the app's own Read tool can run.
 */
export function richToolStep(fileA = 'a.txt', fileB = 'b.txt'): unknown[] {
  return [
    { type: 'response.created', response: { id: 'resp-1', model: 'gpt-test', created_at: 1 } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs-1', encrypted_content: 'CIPHERTEXT'.repeat(10_000), ignored_private_field: 'must-not-round-trip' } },
    { type: 'response.reasoning_summary_part.added', item_id: 'rs-1', output_index: 0, summary_index: 0 },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs-1', output_index: 0, summary_index: 0, delta: 'brief reason' },
    { type: 'response.reasoning_summary_part.done', item_id: 'rs-1', output_index: 0, summary_index: 0 },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs-1', encrypted_content: 'CIPHERTEXT'.repeat(10_000) } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg-commentary', role: 'assistant', phase: 'commentary', content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg-commentary', output_index: 1, content_index: 0, delta: 'checking ' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg-commentary', role: 'assistant', phase: 'commentary', status: 'completed', content: [] } },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'Read', arguments: '' } },
    { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'Read', arguments: JSON.stringify({ file_path: fileA }), status: 'completed' } },
    { type: 'response.output_item.added', output_index: 3, item: { type: 'function_call', id: 'fc-2', call_id: 'call-2', name: 'Read', arguments: '' } },
    { type: 'response.output_item.done', output_index: 3, item: { type: 'function_call', id: 'fc-2', call_id: 'call-2', name: 'Read', arguments: JSON.stringify({ file_path: fileB }), status: 'completed' } },
    { type: 'response.output_item.added', output_index: 4, item: { type: 'message', id: 'msg-final', role: 'assistant', phase: 'final_answer', content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg-final', output_index: 4, content_index: 0, delta: 'both files' },
    { type: 'response.output_item.done', output_index: 4, item: { type: 'message', id: 'msg-final', role: 'assistant', phase: 'final_answer', status: 'completed', content: [] } },
    completed({ output_tokens_details: { reasoning_tokens: 7 } }),
  ];
}

/** A plain one-message step: `id` is the SDK item id the next wire body must carry. */
export function textStep(id: string, text: string): unknown[] {
  return [
    { type: 'response.created', response: { id: `resp-${id}`, model: 'gpt-test', created_at: 1 } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id, role: 'assistant', phase: 'final_answer', content: [] } },
    { type: 'response.output_text.delta', item_id: id, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id, role: 'assistant', phase: 'final_answer', status: 'completed', content: [] } },
    completed(),
  ];
}

/**
 * A step whose reasoning item carries ciphertext but NEVER emits a summary
 * delta — the real shape a low-reasoning-effort ChatGPT turn puts on the wire.
 * `@ai-sdk/openai` still opens a reasoning part for it, so `ai` hands the
 * harness a reasoning part whose text is `''` and whose providerOptions carry
 * the encrypted content. Nothing in the transcript can anchor empty text.
 */
export function silentReasoningStep(id = 'msg-silent', text = 'answered', cipher = 'SILENT-CIPHERTEXT'): unknown[] {
  const item = { type: 'reasoning', id: 'rs-silent', encrypted_content: cipher };
  return [
    { type: 'response.created', response: { id: `resp-${id}`, model: 'gpt-test', created_at: 1 } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id, role: 'assistant', phase: 'final_answer', content: [] } },
    { type: 'response.output_text.delta', item_id: id, output_index: 1, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id, role: 'assistant', phase: 'final_answer', status: 'completed', content: [] } },
    completed({ output_tokens_details: { reasoning_tokens: 7 } }),
  ];
}
